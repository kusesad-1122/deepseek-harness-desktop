/**
 * Minimal zero-dependency class name combiner for the native recovery UI.
 * Accepts string variadic inputs and base-ui render-prop class names
 * (``(state) => string | undefined``); falsy values and empty results are dropped.
 */
export type ClassValue =
  | string
  | undefined
  | false
  | null
  | ((...args: any[]) => string | undefined)

export function cn(...inputs: ClassValue[]): string {
  const parts: string[] = []
  for (const input of inputs) {
    if (!input) continue
    const value = typeof input === 'function' ? input() : input
    if (value) parts.push(value)
  }
  return parts.join(' ')
}
