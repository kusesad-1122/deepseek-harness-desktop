/**
 * App-layer global reasoning-effort default for DSH Desktop.
 *
 * The upstream default-model seam (`agent-default-model`) and the per-session
 * model selector only carry a `reasoningEffort` when the user (or the model's
 * own `defaultEffort`) named one. This plugin gives the desktop an
 * application-wide default: whenever a request resolves with NO
 * reasoning effort, and the selected model actually supports the configured
 * level, the effort is filled in — so every conversation runs at the app's
 * chosen thinking level unless the user picks one per model.
 *
 * Safety: a level the exact model does not offer would make the request fail
 * before network I/O with `UNSUPPORTED_REASONING_EFFORT`, so the plugin
 * consults `ctx.llm.resolveModelInfo` (cached per provider/model) and only
 * applies the default when the model advertises that level. Non-reasoning
 * models (no reasoning metadata) are left untouched. An explicit
 * `resolved.reasoningEffort` always wins over the default.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

/** Stable Cordis plugin name. */
export const name = 'desktop-reasoning-default'

/** Services required before the global default can mount. */
export const inject = ['settings', 'llm']

/** Settings namespace carrying the app-layer reasoning-effort default. */
export const REASONING_SETTINGS_NAMESPACE = settingsNamespace('dsh-desktop-reasoning')

/** Canonical reasoning levels the desktop may name as its global default. */
export const REASONING_EFFORT_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** One canonical reasoning level. */
export type ReasoningEffortLevel = typeof REASONING_EFFORT_LEVELS[number]

/** Stored and composed global reasoning-effort default. */
export interface ReasoningDefaultSettings {
  /** Whether the app-layer default is applied at all. */
  enabled: boolean
  /** Global default reasoning level. */
  defaultEffort: ReasoningEffortLevel
}

/** Schema of the global reasoning-effort default settings section. */
export const ReasoningDefaultSettingsSchema: z<ReasoningDefaultSettings> = z.object({
  enabled: z.boolean().default(true),
  defaultEffort: z.union([
    z.const('off'), z.const('minimal'), z.const('low'), z.const('medium'),
    z.const('high'), z.const('xhigh'), z.const('max'),
  ]).default('high'),
})

/** Model-capability cache TTL: metadata is stable within a generation. */
const CAPABILITY_TTL_MS = 60_000

interface CachedCapability {
  /** The exact effort ids the model advertises; null = no reasoning metadata. */
  effortIds: ReadonlySet<string> | null
  at: number
}

/** Per-process model capability cache keyed by provider + model. */
const capabilityCache = new Map<string, CachedCapability>()

function cacheKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`
}

/**
 * Resolve whether `level` is a supported reasoning effort for one exact
 * provider/model route. Failures and absent reasoning metadata resolve to
 * `false` so the default can never break a request. Exported for tests; the
 * per-process capability cache makes repeated lookups cheap.
 */
export async function supportsEffort(ctx: Context, provider: string, model: string, level: string, signal: AbortSignal): Promise<boolean> {
  const key = cacheKey(provider, model)
  const now = Date.now()
  const cached = capabilityCache.get(key)
  if (cached !== undefined && now - cached.at < CAPABILITY_TTL_MS) {
    return cached.effortIds?.has(level) ?? false
  }
  try {
    const info = await ctx.llm.resolveModelInfo(provider, model, signal)
    const efforts = info.reasoning?.efforts
    const ids = efforts === undefined ? null : new Set(efforts.map(effort => String(effort.id)))
    capabilityCache.set(key, { effortIds: ids, at: now })
    return ids?.has(level) ?? false
  } catch {
    // An un-resolvable model must never block or break its requests.
    capabilityCache.set(key, { effortIds: null, at: now })
    return false
  }
}

/**
 * Register the global reasoning-effort default: the settings namespace plus
 * the `agent/request` waterfall that fills the default when nothing else did.
 */
export function apply(ctx: Context): void {
  const scope = ctx.settings.register(
    REASONING_SETTINGS_NAMESPACE,
    ReasoningDefaultSettingsSchema,
    { applies: 'restart' },
  )

  ctx.on('agent/request', async (payload, next): Promise<LlmCallConfig> => {
    const resolved = await next()
    if (resolved.reasoningEffort !== undefined) return resolved
    const settings = scope.get()
    if (settings.enabled === false) return resolved
    const level = settings.defaultEffort
    const effort = ReasoningEffortId(level)
    if (await supportsEffort(ctx, resolved.provider, resolved.model, level, payload.signal)) {
      return { ...resolved, reasoningEffort: effort }
    }
    return resolved
  })
}
