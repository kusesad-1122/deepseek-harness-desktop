/**
 * Office Desk theme host for compatibility mode.
 *
 * The user-authored theme (`office-desk-theme-data.ts`, copied verbatim from
 * the downloaded `index.html`) is mounted inside a full-screen `srcdoc`
 * iframe so the theme file itself is never modified. This module bridges host
 * routes into the theme (same-origin srcdoc inherits the parent origin, but a
 * message bridge is used so the adapter stays robust), then drives every
 * theme page with real Desktop data:
 *
 *   home      → memory pending / knowledge today / news metrics
 *   tasks     → knowledge card management + create via the theme dialog
 *   calendar  → daily news feed calendar
 *   files     → knowledge card table + reader dialog
 *   team      → WorkBuddy expert roster
 *   settings  → memory budgets + knowledge health + theme variants
 *   market    → injected 07 nav page: dsh-market registry browse/install
 *
 * The right-hand context rail is filled with live next-steps, progress,
 * tags, and system hints. Every page keeps the theme's own classes so the
 * authored visual design is untouched.
 */

import { OFFICE_DESK_THEME_HTML } from './office-desk-theme-data.ts'

export interface OfficeDeskThemeHostInfo {
  readonly mode: string
  readonly platform: string
}

interface BridgeRequest {
  readonly id: number
  readonly op: 'json' | 'post'
  readonly route: string
  readonly body?: unknown
}

interface BridgeReply {
  readonly id: number
  readonly ok: boolean
  readonly data?: unknown
  readonly error?: string
}

const THEME_READY_FLAG = '__dshDeskThemeReady'

/** Fetch JSON through the parent document (never depends on srcdoc origin). */
export function mountOfficeDeskTheme(container: HTMLElement, info: OfficeDeskThemeHostInfo): () => void {
  const frame = document.createElement('iframe')
  frame.className = 'dsh-desk-theme-frame'
  frame.setAttribute('aria-label', '办公工作台')
  frame.setAttribute('title', '办公工作台')
  frame.style.cssText = [
    'position:fixed', 'inset:0', 'width:100%', 'height:100%', 'border:0',
    'display:block', 'background:#f7f6f3', 'z-index:1001',
  ].join(';')
  const disposers: Array<() => void> = []
  let disposed = false

  const pending = new Map<number, (reply: BridgeReply) => void>()
  const onMessage = (event: MessageEvent): void => {
    const data = event.data as { dshDeskThemeReply?: BridgeReply, dshDeskTheme?: BridgeRequest } | null
    if (data === null || typeof data !== 'object') return
    const reply = data.dshDeskThemeReply
    if (reply !== undefined && typeof reply.id === 'number') {
      const resolve = pending.get(reply.id)
      if (resolve !== undefined) {
        pending.delete(reply.id)
        resolve(reply)
      }
      return
    }
    const request = data.dshDeskTheme
    if (request !== undefined && typeof request.id === 'number'
      && (request.op === 'json' || request.op === 'post')) {
      const target = frame.contentWindow
      if (target === null) return
      void (async () => {
        try {
          const init: RequestInit = request.op === 'post'
            ? {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(request.body ?? {}),
              }
            : { cache: 'no-store' }
          const response = await fetch(request.route, init)
          const text = await response.text()
          let data: unknown = null
          if (text.length > 0) {
            try {
              data = JSON.parse(text)
            } catch {
              data = text
            }
          }
          target.postMessage(
            { dshDeskThemeReply: { id: request.id, ok: response.ok, data } },
            '*',
          )
        } catch (cause) {
          target.postMessage(
            {
              dshDeskThemeReply: {
                id: request.id,
                ok: false,
                error: cause instanceof Error ? cause.message : String(cause),
              },
            },
            '*',
          )
        }
      })()
      return
    }
  }
  window.addEventListener('message', onMessage)
  disposers.push(() => window.removeEventListener('message', onMessage))

  const mounted = (): void => {
    const win = frame.contentWindow
    const doc = frame.contentDocument
    if (disposed || win === null || doc === null) return
    if ((win as unknown as Record<string, unknown>)[THEME_READY_FLAG] === true) return
    ;(win as unknown as Record<string, unknown>)[THEME_READY_FLAG] = true
    disposers.push(setupThemeAdapter(win, doc, info))
  }
  frame.addEventListener('load', mounted, { once: true })
  frame.srcdoc = OFFICE_DESK_THEME_HTML

  container.appendChild(frame)
  disposers.push(() => {
    disposed = true
    frame.remove()
  })
  return () => {
    for (const dispose of disposers.splice(0)) dispose()
  }
}

// ─────────────────────────── theme adapter ───────────────────────────

interface ThemeWindow extends Window {
  toast?(message: string): void
  navigate?(page: string): void
}

function setupThemeAdapter(win: ThemeWindow, doc: Document, info: OfficeDeskThemeHostInfo): () => void {
  const $ = (selector: string): HTMLElement | null => doc.querySelector<HTMLElement>(selector)
  const $$ = (selector: string): HTMLElement[] => Array.from(doc.querySelectorAll<HTMLElement>(selector))
  const esc = (value: unknown): string => {
    const text = String(value ?? '')
    return text
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')
  }
  const toast = (message: string): void => {
    if (typeof win.toast === 'function') win.toast(message)
    else {
      const el = $('#toast')
      if (el !== null) {
        el.textContent = message
        el.classList.add('show')
        clearTimeout((win as unknown as { __dshToast?: number }).__dshToast)
        ;(win as unknown as { __dshToast?: number }).__dshToast = window.setTimeout(
          () => el.classList.remove('show'),
          2400,
        )
      }
    }
  }
  const relative = (iso: string): string => {
    const time = Date.parse(iso)
    if (!Number.isFinite(time)) return '—'
    const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000))
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h`
    const days = Math.floor(hours / 24)
    if (days < 30) return `${days}d`
    return `${Math.floor(days / 30)}mo`
  }
  const todayISO = (): string => new Date().toISOString().slice(0, 10)
  const isToday = (iso: string): boolean => iso.slice(0, 10) === todayISO()
  const setText = (selector: string, text: string | number): void => {
    const el = $(selector)
    if (el !== null) el.textContent = String(text)
  }

  let seq = 0
  const bridge = (op: 'json' | 'post', route: string, body?: unknown): Promise<unknown | null> => {
    const id = ++seq
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        resolve(null)
      }, 12_000)
      pending.set(id, (reply) => {
        clearTimeout(timer)
        resolve(reply.ok ? reply.data ?? null : null)
      })
      win.parent.postMessage({ dshDeskTheme: { id, op, route, body } }, '*')
    })
  }
  const pending = new Map<number, (reply: BridgeReply) => void>()
  const onReply = (event: MessageEvent): void => {
    const data = event.data as { dshDeskThemeReply?: BridgeReply } | null
    if (data === null || data.dshDeskThemeReply === undefined) return
    const reply = data.dshDeskThemeReply
    const resolve = pending.get(reply.id)
    if (resolve !== undefined) {
      pending.delete(reply.id)
      resolve(reply)
    }
  }
  win.addEventListener('message', onReply)

  // ── real host data shapes ──
  interface KnowledgeCard {
    id: string
    title: string
    summary: string
    tags: string[]
    source: string
    createdAt: string
    updatedAt: string
  }
  interface KnowledgeState {
    enabled: boolean
    maxCards: number
    count: number
    charCount: number
    cards: KnowledgeCard[]
  }
  interface MemoryPending {
    id: string
    target: string
    origin: string
    createdAt: string
    operations: Array<{ action: string, content?: string, oldText?: string }>
  }
  interface MemoryState {
    approval: boolean
    pending: MemoryPending[]
    targets: Array<{ target: string, charCount: number, charLimit: number, entries: string[] }>
    review: { enabled: boolean, interval: number, lastOutcome: string }
  }
  interface NewsItem { id: string, title: string, url?: string, cover?: string, publishedAt: string }
  interface NewsFeed { date: string, source: string, sourceUrl: string, items: NewsItem[] }
  interface Expert {
    id: string
    name: string
    displayName: Record<string, string>
    profession: Record<string, string>
    description: Record<string, string>
    marketplace: string
    expertType: string
    hasAvatar: boolean
    avatarRoute: string
    tags: Array<Record<string, string>>
    categoryId?: string
  }
  interface MarketPlugin {
    name: string
    url: string
    description?: string
    npm?: string
    version?: string
  }
  interface MarketRegistry { source: string, registry: { plugins: MarketPlugin[] } }
  interface MarketInstalled {
    installed: Record<string, string>
    present: string[]
    activation: Record<string, boolean>
  }

  const api = {
    memory: (): Promise<MemoryState | null> => bridge('json', '/dsh-desktop/memory/state') as Promise<MemoryState | null>,
    knowledge: (): Promise<KnowledgeState | null> => bridge('json', '/dsh-desktop/knowledge/state') as Promise<KnowledgeState | null>,
    createCard: (payload: { title: string, summary: string, tags: string[] }): Promise<unknown | null> =>
      bridge('post', '/dsh-desktop/knowledge/cards', payload),
    deleteCard: (id: string): Promise<unknown | null> =>
      bridge('post', '/dsh-desktop/knowledge/cards/delete', { id }),
    approvePending: (id: string): Promise<unknown | null> =>
      bridge('post', '/dsh-desktop/memory/approve', { id }),
    rejectPending: (id: string): Promise<unknown | null> =>
      bridge('post', '/dsh-desktop/memory/reject', { id }),
    news: (force = false): Promise<NewsFeed | null> =>
      bridge('json', `/dsh-desktop/news/daily${force ? '?refresh=1' : ''}`) as Promise<NewsFeed | null>,
    experts: (): Promise<Expert[] | null> => bridge('json', '/dsh-desktop/experts/list') as Promise<Expert[] | null>,
    registry: (): Promise<MarketRegistry | null> => bridge('json', '/dsh-market/registry') as Promise<MarketRegistry | null>,
    installed: (): Promise<MarketInstalled | null> => bridge('json', '/dsh-market/installed') as Promise<MarketInstalled | null>,
    install: (url: string): Promise<unknown | null> => bridge('post', '/dsh-market/install', { url }),
    uninstall: (name: string): Promise<unknown | null> => bridge('post', '/dsh-market/uninstall', { name }),
  }

  // ── reader dialog (theme-styled, runtime-injected; theme file untouched) ──
  let readerDialog: HTMLDialogElement | null = null
  function ensureReaderDialog(): HTMLDialogElement {
    if (readerDialog !== null) return readerDialog
    const dialog = doc.createElement('dialog')
    dialog.id = 'dshReaderDialog'
    dialog.innerHTML = `
      <div class="dialog-head"><div><p class="kicker">知识卡 / 阅读器</p><h2 id="dshReaderTitle">阅读</h2></div>
      <button class="close" data-close="dshReaderDialog" aria-label="关闭">×</button></div>
      <div class="dialog-body">
        <div id="dshReaderMeta" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px"></div>
        <div id="dshReaderBody" style="font-size:12px;line-height:1.7;white-space:pre-wrap;color:var(--fg)"></div>
      </div>
      <div class="dialog-foot">
        <button class="secondary" id="dshReaderCopy" type="button">复制全文</button>
        <button class="primary" data-close="dshReaderDialog" type="button">关闭</button>
      </div>`
    doc.body.appendChild(dialog)
    dialog.querySelector('[data-close="dshReaderDialog"]')?.addEventListener('click', () => dialog.close())
    dialog.querySelector('#dshReaderCopy')?.addEventListener('click', () => {
      const text = dialog.querySelector('#dshReaderBody')?.textContent ?? ''
      void navigator.clipboard?.writeText(text).then(() => toast('知识卡全文已复制')).catch(() => toast('复制失败'))
    })
    readerDialog = dialog
    return dialog
  }
  function openReader(card: KnowledgeCard): void {
    const dialog = ensureReaderDialog()
    dialog.querySelector('#dshReaderTitle')!.textContent = card.title
    const meta = dialog.querySelector('#dshReaderMeta')!
    meta.innerHTML = ''
    for (const tag of card.tags.slice(0, 8)) {
      const span = doc.createElement('span')
      span.className = 'tag accent'
      span.textContent = tag
      meta.appendChild(span)
    }
    const time = doc.createElement('span')
    time.className = 'tag'
    time.textContent = `${card.source} · ${relative(card.createdAt)}`
    meta.appendChild(time)
    dialog.querySelector('#dshReaderBody')!.textContent = card.summary
    if (typeof dialog.showModal === 'function') dialog.showModal()
  }

  // ── card create dialog: reuse the theme taskDialog, retarget to knowledge ──
  function interceptTaskForm(): void {
    const form = $('#taskForm') as HTMLFormElement | null
    if (form === null) return
    form.querySelector('#taskName')?.setAttribute('placeholder', '例如：桌面工作台主题接入要点')
    const owner = form.querySelector('#taskOwner') as HTMLSelectElement | null
    if (owner !== null && owner.options.length > 0 && owner.options[0] !== undefined) owner.options[0].text = '本地工作台'
    const due = form.querySelector('#taskDue')
    due?.parentElement?.remove()
    const note = form.querySelector('#taskNote')
    if (note !== null) note.setAttribute('placeholder', '写下这条知识卡的摘要，会保存到本地知识库')
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      event.stopImmediatePropagation()
      const title = (form.querySelector('#taskName') as HTMLInputElement | null)?.value.trim() ?? ''
      if (title === '') return
      const summary = (form.querySelector('#taskNote') as HTMLTextAreaElement | null)?.value.trim() ?? ''
      void api.createCard({ title, summary, tags: ['桌面工作台'] }).then((result) => {
        if (result === null) toast('知识卡创建失败，请稍后重试')
        else {
          toast('知识卡已沉淀到本地知识库')
          dialogClose()
          form.reset()
          void refreshAll()
        }
      })
    }, { capture: true })
    const dialog = $('#taskDialog') as HTMLDialogElement | null
    const headline = dialog?.querySelector('.dialog-head h2')
    if (headline !== null && headline !== undefined) headline.textContent = '沉淀知识卡'
  }
  function dialogClose(): void {
    const dialog = $('#taskDialog') as HTMLDialogElement | null
    if (dialog !== null && typeof dialog.close === 'function') dialog.close()
  }

  // ── renderers ──
  async function renderHome(memory: MemoryState | null, knowledge: KnowledgeState | null, news: NewsFeed | null): Promise<void> {
    const cards = knowledge?.cards ?? []
    const today = cards.filter((card) => isToday(card.createdAt))
    const pendingList = memory?.pending ?? []
    setText('#doneMetric', String(today.length))
    setText('#doneBar', `${today.length}`)
    const bar = $('#doneBar')
    if (bar !== null) bar.style.width = `${Math.min(100, Math.round((today.length / Math.max(1, cards.length)) * 100))}%`
    setText('#inboxMetric', String(pendingList.length))
    setText('#syncText', `已同步 · ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`)
    const metricCards = $$('.grid-3 .card')
    if (metricCards[1] !== undefined) {
      const deepLabel = metricCards[1].querySelector('.metric span')
      const deepValue = metricCards[1].querySelector('.metric strong')
      if (deepValue !== null) deepValue.textContent = String(Math.round((knowledge?.charCount ?? 0) / 1024))
      if (deepLabel !== null) deepLabel.textContent = 'KB 知识库'
    }

    const list = $('#homeTaskList')
    if (list !== null) {
      list.innerHTML = ''
      const rows: Array<{ title: string, meta: string, onCheck: () => void, onReject?: () => void }> = []
      for (const item of pendingList.slice(0, 6)) {
        const op = item.operations[0]
        rows.push({
          title: `${item.origin} → ${item.target}${op?.action ? ` · ${op.action}` : ''}`,
          meta: `${relative(item.createdAt)} · 待审批`,
          onCheck: () => { void api.approvePending(item.id).then(() => { toast('已批准并写入记忆'); void refreshAll() }) },
          onReject: () => { void api.rejectPending(item.id).then(() => { toast('已拒绝该申请'); void refreshAll() }) },
        })
      }
      for (const card of cards.slice(0, pendingList.length === 0 ? 6 : 0)) {
        rows.push({
          title: card.title,
          meta: `${card.tags.slice(0, 2).join(' · ') || '知识卡'} · ${relative(card.createdAt)}`,
          onCheck: () => openReader(card),
        })
      }
      if (rows.length === 0) {
        list.innerHTML = '<div class="empty" style="min-height:120px;border:0"><strong>暂无待审批/知识卡</strong><p>沉淀一条本会话知识，或等待记忆审查产生待办。</p></div>'
      }
      for (const row of rows) {
        const div = doc.createElement('div')
        div.className = 'task'
        const check = doc.createElement('button')
        check.className = 'check'
        check.setAttribute('aria-label', '处理')
        check.addEventListener('click', row.onCheck)
        const title = doc.createElement('span')
        title.className = 'task-title'
        title.textContent = row.title
        const metaWrap = doc.createElement('span')
        metaWrap.className = 'task-meta'
        metaWrap.textContent = row.meta
        div.append(check, title, metaWrap)
        if (row.onReject !== undefined) {
          const reject = doc.createElement('button')
          reject.className = 'mini'
          reject.textContent = '拒'
          reject.style.marginLeft = '6px'
          reject.addEventListener('click', row.onReject)
          metaWrap.appendChild(reject)
        }
        list.appendChild(div)
      }
    }

    // right rail
    const sideCards = $$('.side-card')
    const nextCard = sideCards.find((card) => card.querySelector('h3')?.textContent === '下一步行动')
    if (nextCard !== undefined) {
      const sideList = nextCard.querySelector('.side-list')
      if (sideList !== null) {
        sideList.innerHTML = ''
        const source = pendingList.length > 0
          ? pendingList.slice(0, 3).map((item) => ({ title: `${item.origin} 的 ${item.target} 写入`, meta: relative(item.createdAt) }))
          : cards.slice(0, 3).map((card) => ({ title: card.title, meta: relative(card.createdAt) }))
        if (source.length === 0) {
          const empty = doc.createElement('div')
          empty.innerHTML = '<span>暂无待办</span>'
          sideList.appendChild(empty)
        }
        for (const item of source) {
          const row = doc.createElement('div')
          const strong = doc.createElement('strong')
          strong.textContent = item.title
          const span = doc.createElement('span')
          span.textContent = item.meta
          row.append(strong, span)
          sideList.appendChild(row)
        }
      }
    }
    const progressCard = sideCards.find((card) => card.querySelector('h3')?.textContent === '项目进度')
    if (progressCard !== undefined) {
      const target = memory?.targets.find((entry) => entry.target === 'memory')
      const bar = progressCard.querySelector<HTMLElement>('.bar i')
      if (bar !== null && target !== undefined) {
        const percent = Math.min(100, Math.round((target.charCount / Math.max(1, target.charLimit)) * 100))
        bar.style.width = `${percent}%`
        const label = progressCard.querySelector('.label-row')
        if (label !== null) label.innerHTML = `<span>记忆预算</span><span>${percent}% · ${Math.round(target.charCount / 1024)}KB/${Math.round(target.charLimit / 1024)}KB</span>`
      }
    }
    const tagCard = sideCards.find((card) => card.querySelector('h3')?.textContent === '关联标签')
    if (tagCard !== undefined) {
      const holder = tagCard.querySelector('div[style*="flex-wrap"]')
      if (holder !== null) {
        holder.innerHTML = ''
        const counts = new Map<string, number>()
        for (const card of cards) for (const tag of card.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
        const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
        if (top.length === 0) holder.innerHTML = '<span class="tag">暂无标签</span>'
        for (const [tag, count] of top) {
          const span = doc.createElement('span')
          span.className = 'tag accent'
          span.textContent = `${tag} ${count}`
          holder.appendChild(span)
        }
      }
    }
    const noticeCard = sideCards.find((card) => card.querySelector('h3')?.textContent === '系统提示')
    if (noticeCard !== undefined) {
      const notice = noticeCard.querySelector('.notice')
      if (notice !== null) {
        notice.textContent = `桌面工作台 · ${info.mode} 模式运行中。知识库 ${cards.length} 张卡，待审批 ${pendingList.length} 条，今日新增 ${today.length} 条。`
      }
    }
    if (news !== null && news.items.length > 0) setText('#pageKicker', `实时 / 01 · ${news.source}`)
  }

  function taskRowHtml(card: KnowledgeCard): string {
    return `
      <button class="task-title" data-open="${esc(card.id)}" style="border:0;background:transparent;padding:0;text-align:left;font:inherit;color:inherit;cursor:pointer">${esc(card.title)}</button>
      <span class="task-meta">${esc(card.tags.slice(0, 3).join(' · ') || '知识卡')} · ${relative(card.createdAt)}</span>
      <button class="mini" data-del="${esc(card.id)}" aria-label="删除">删</button>
      <button class="check" data-read="${esc(card.id)}" aria-label="查看"></button>`
  }

  async function renderFullTasks(): Promise<void> {
    const knowledge = await api.knowledge()
    const cards = knowledge?.cards ?? []
    setText('#taskCount', String(cards.length))
    const list = $('#fullTaskList')
    if (list === null) return
    list.innerHTML = ''
    if (cards.length === 0) {
      list.innerHTML = '<div class="empty" style="border:0"><strong>知识库为空</strong><p>点击「＋ 新建任务」沉淀第一条知识卡。</p></div>'
      return
    }
    for (const card of cards) {
      const row = doc.createElement('div')
      row.className = 'task'
      row.innerHTML = taskRowHtml(card)
      row.querySelector('[data-open]')?.addEventListener('click', () => openReader(card))
      row.querySelector('[data-read]')?.addEventListener('click', () => openReader(card))
      row.querySelector('[data-del]')?.addEventListener('click', () => {
        if (!win.confirm(`删除知识卡「${card.title}」？`)) return
        void api.deleteCard(card.id).then((result) => {
          toast(result === null ? '删除失败' : '知识卡已删除')
          void refreshAll()
        })
      })
      list.appendChild(row)
    }
  }

  async function renderCalendarPage(): Promise<void> {
    const feed = await api.news()
    const now = new Date()
    const year = now.getFullYear()
    const month = now.getMonth()
    const grid = $('#calendarGrid')
    if (grid !== null) {
      const first = new Date(year, month, 1)
      const startWeekday = first.getDay()
      const daysInMonth = new Date(year, month + 1, 0).getDate()
      const cells: string[] = []
      for (let i = 0; i < startWeekday; i += 1) cells.push('<button class="day muted" disabled><b>·</b></button>')
      for (let day = 1; day <= daysInMonth; day += 1) {
        const isTodayDay = day === now.getDate()
        const event = isTodayDay && feed !== null && feed.items[0] !== undefined
          ? `<span class="event">${esc(feed.items[0].title.slice(0, 12))}${feed.items[0].title.length > 12 ? '…' : ''}</span>`
          : ''
        cells.push(`<button class="day${isTodayDay ? ' today' : ''}" data-day="${day}"><b>${day}</b>${event}</button>`)
      }
      grid.innerHTML = cells.join('')
      $$('.day[data-day]').forEach((button) => {
        button.addEventListener('click', () => toast(`已选择 ${month + 1} 月 ${button.dataset.day} 日`))
      })
    }
    const label = $('.label-row span')
    if (label !== null && feed !== null) label.textContent = `${year} 年 ${month + 1} 月 · ${feed.source}`
    const candidates = $$('.card .task-list')
    const list = candidates[1] ?? candidates[0]
    if (list !== undefined) {
      list.innerHTML = ''
      const items = feed?.items ?? []
      if (items.length === 0) list.innerHTML = '<div class="empty" style="min-height:90px;border:0"><strong>今日暂无热点</strong><p>可在每日热点页刷新抓取。</p></div>'
      for (const item of items.slice(0, 6)) {
        const row = doc.createElement('div')
        row.className = 'task'
        const mark = doc.createElement('span')
        mark.className = 'timeline-mark'
        mark.textContent = 'NEWS'
        mark.style.fontSize = '8px'
        const title = doc.createElement('span')
        title.className = 'task-title'
        title.textContent = item.title
        const meta = doc.createElement('span')
        meta.className = 'task-meta'
        meta.textContent = `${feed?.source ?? '热点'} · ${relative(item.publishedAt)}`
        row.append(mark, title, meta)
        list.appendChild(row)
      }
    }
  }

  async function renderFilesPage(): Promise<void> {
    const knowledge = await api.knowledge()
    const cards = knowledge?.cards ?? []
    const tbody = $('#fileRows')
    if (tbody === null) return
    tbody.innerHTML = ''
    if (cards.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5"><div class="empty" style="border:0;min-height:80px"><strong>暂无资料</strong><p>沉淀知识卡后会出现在这里。</p></div></td></tr>'
      return
    }
    for (const card of cards) {
      const tr = doc.createElement('tr')
      tr.innerHTML = `
        <td><strong>${esc(card.title)}</strong></td>
        <td>${card.tags.slice(0, 3).map((tag) => `<span class="tag">${esc(tag)}</span>`).join(' ') || '<span class="tag">知识卡</span>'}</td>
        <td>${relative(card.updatedAt)}</td>
        <td><span class="tag ${card.source === 'manual' ? 'accent' : 'blue'}">${esc(card.source)}</span></td>
        <td><button class="mini file-open" data-file="${esc(card.id)}">预览</button></td>`
      tr.querySelector(`[data-file="${CSS.escape(card.id)}"]`)?.addEventListener('click', () => openReader(card))
      tbody.appendChild(tr)
    }
    const search = $('#fileSearch') as HTMLInputElement | null
    if (search !== null) {
      const onInput = (): void => {
        const query = search.value.trim().toLowerCase()
        for (const tr of Array.from(tbody.querySelectorAll('tr'))) {
          tr.style.display = query === '' || (tr.textContent ?? '').toLowerCase().includes(query) ? '' : 'none'
        }
      }
      search.addEventListener('input', onInput)
    }
  }

  async function renderTeamPage(): Promise<void> {
    const experts = await api.experts()
    const memory = await api.memory()
    const list = experts ?? []
    setText('.grid-3 .card:nth-child(1) .metric strong', String(list.length))
    const successCard = $$('.grid-3 .card')[1]
    const avatarRatio = list.length > 0 ? Math.round((list.filter((expert) => expert.hasAvatar).length / list.length) * 100) : 0
    successCard?.querySelector('.metric strong')?.replaceChildren(doc.createTextNode(String(avatarRatio)))
    successCard?.querySelector('.metric span')?.replaceChildren(doc.createTextNode('% 带形象'))
    setText('.grid-3 .card:nth-child(3) .metric strong', String(memory?.pending.length ?? 0))
    const tbody = $('.card .table tbody')
    if (tbody === null) return
    tbody.innerHTML = ''
    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4"><div class="empty" style="border:0;min-height:90px"><strong>专家目录暂不可用</strong><p>WorkBuddy 目录未加载或主机未启用该页。</p></div></td></tr>'
      return
    }
    for (const expert of list.slice(0, 20)) {
      const tr = doc.createElement('tr')
      const profession = expert.profession['zh'] ?? expert.profession['en'] ?? expert.expertType
      const description = expert.description['zh'] ?? expert.description['en'] ?? ''
      tr.innerHTML = `
        <td><strong>${esc(expert.displayName['zh'] ?? expert.name)}</strong></td>
        <td>${esc(profession)}</td>
        <td>${esc(description.slice(0, 42))}${description.length > 42 ? '…' : ''}</td>
        <td><span class="tag ${expert.hasAvatar ? 'accent' : 'blue'}">${esc(expert.marketplace)}</span></td>`
      tbody.appendChild(tr)
    }
    const invite = $('#inviteBtn')
    if (invite !== null) {
      invite.addEventListener('click', () => {
        const first = list[0]
        if (first === undefined) { toast('专家目录为空'); return }
        const text = `专家：${first.displayName['zh'] ?? first.name}\n职业：${first.profession['zh'] ?? ''}\n介绍：${first.description['zh'] ?? ''}`
        void navigator.clipboard?.writeText(text).then(() => toast('已复制第一位专家的调用文案')).catch(() => toast('复制失败'))
      }, { capture: true })
    }
  }

  // ── settings: memory budgets + knowledge health + theme variants ──
  async function renderSettingsPage(): Promise<void> {
    const memory = await api.memory()
    const knowledge = await api.knowledge()
    const cards = knowledge?.cards ?? []
    const firstCard = $('.grid-2 .card')
    if (firstCard !== null) {
      const holder = firstCard.querySelector('.task-list') ?? firstCard
      const bars = memory?.targets ?? []
      const existing = firstCard.querySelector('#dshMemoryBars')
      existing?.remove()
      const wrap = doc.createElement('div')
      wrap.id = 'dshMemoryBars'
      wrap.style.marginTop = '10px'
      for (const target of bars) {
        const percent = Math.min(100, Math.round((target.charCount / Math.max(1, target.charLimit)) * 100))
        const row = doc.createElement('div')
        row.innerHTML = `
          <div class="label-row"><span>${esc(target.target)} 预算</span><span>${Math.round(target.charCount / 1024)}KB / ${Math.round(target.charLimit / 1024)}KB · ${percent}%</span></div>
          <div class="bar" style="margin-top:6px"><i style="width:${percent}%"></i></div>`
        wrap.appendChild(row)
      }
      holder.appendChild(wrap)
    }
    const secondCard = $$('.grid-2 .card')[1]
    if (secondCard !== undefined) {
      const holder = secondCard.querySelector('.task-list') ?? secondCard
      const tooShort = cards.filter((card) => card.summary.trim().length < 30).length
      const noTags = cards.filter((card) => card.tags.length === 0).length
      const dupes = cards.length - new Set(cards.map((card) => card.title.trim())).size
      const report = doc.createElement('div')
      report.id = 'dshHealthReport'
      report.innerHTML = `
        <div class="label-row" style="margin-top:12px"><span>知识库体检</span><span>${cards.length} 张卡</span></div>
        <div class="task-list" style="margin-top:8px">
          <div class="task"><span class="task-title">摘要过短（&lt;30 字）</span><span class="task-meta">${tooShort} 条</span></div>
          <div class="task"><span class="task-title">缺少标签</span><span class="task-meta">${noTags} 条</span></div>
          <div class="task"><span class="task-title">标题重复候选</span><span class="task-meta">${dupes} 条</span></div>
        </div>`
      holder.appendChild(report)
    }
    // theme variants (runtime CSS variables only)
    const variantStyle = doc.createElement('style')
    variantStyle.textContent = `
      html[data-desk-variant="blue"] { --accent: oklch(.54 .105 250); --pink: oklch(.64 .14 38); }
      html[data-desk-variant="mint"] { --accent: oklch(.58 .12 160); --pink: oklch(.64 .14 38); }
      .dsh-variant-row { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
    `
    doc.head.appendChild(variantStyle)
    const saved = (() => { try { return win.localStorage.getItem('dsh-desk-theme-variant') ?? 'default' } catch { return 'default' } })()
    doc.documentElement.setAttribute('data-desk-variant', saved)
    const settingsPage = $('[data-page="settings"]')
    if (settingsPage !== null && !settingsPage.querySelector('.dsh-variant-row')) {
      const row = doc.createElement('div')
      row.className = 'dsh-variant-row'
      row.innerHTML = '<span class="label-row" style="align-self:center">主题变体</span>'
      const variants: Array<{ key: string, label: string }> = [
        { key: 'default', label: '原版办公' },
        { key: 'blue', label: '蔚蓝' },
        { key: 'mint', label: '薄荷' },
      ]
      for (const variant of variants) {
        const button = doc.createElement('button')
        button.className = `mini${saved === variant.key ? ' filter-task active' : ''}`
        button.textContent = variant.label
        button.addEventListener('click', () => {
          doc.documentElement.setAttribute('data-desk-variant', variant.key)
          try { win.localStorage.setItem('dsh-desk-theme-variant', variant.key) } catch { /* best effort */ }
          $$('.dsh-variant-row .mini').forEach((element) => element.classList.toggle('filter-task', element === button))
          toast(`主题变体：${variant.label}`)
        })
        row.appendChild(button)
      }
      settingsPage.appendChild(row)
    }
  }

  // ── market page (injected nav 07; never touches the theme source) ──
  function ensureMarketPage(): void {
    const nav = $('.nav')
    if (nav !== null && $('[data-nav="market"]') === null) {
      const button = doc.createElement('button')
      button.className = 'nav-btn'
      button.dataset['nav'] = 'market'
      button.innerHTML = '<span class="nav-no">07</span><strong>市场</strong><small>插件浏览与安装</small>'
      nav.appendChild(button)
    }
    if ($('[data-page="market"]') === null) {
      const stage = $('.stage')
      if (stage === null) return
      const section = doc.createElement('section')
      section.className = 'page'
      section.dataset['page'] = 'market'
      section.setAttribute('aria-labelledby', 'marketTitle')
      section.innerHTML = `
        <div class="hero"><div><p class="kicker">市场 / 浏览与安装</p><h2 id="marketTitle">插件市场，<br><span>即装即用。</span></h2><p>浏览社区插件目录，一键安装到当前桌面工作台。安装后按提示重启即可生效。</p></div><button class="primary" id="marketRefresh">↻ 刷新目录</button></div>
        <div class="card card-pad">
          <div class="label-row"><span>插件目录</span><label class="mini">⌕ <input id="marketSearch" placeholder="搜索插件" style="width:140px;border:0;background:transparent;color:var(--fg);outline:0;font-size:10px"></label></div>
          <div class="grid grid-3" id="marketGrid" style="margin-top:12px"></div>
        </div>`
      stage.appendChild(section)
      section.querySelector('#marketRefresh')?.addEventListener('click', () => { marketCache = null; void renderMarketPage() })
      const search = section.querySelector('#marketSearch') as HTMLInputElement | null
      search?.addEventListener('input', () => { void renderMarketPage(search.value.trim().toLowerCase()) })
    }
  }
  let marketCache: { registry: MarketRegistry | null, installed: MarketInstalled | null } | null = null
  async function renderMarketPage(filter = ''): Promise<void> {
    ensureMarketPage()
    if (marketCache === null) {
      const [registry, installed] = await Promise.all([api.registry(), api.installed()])
      marketCache = { registry, installed }
      if (registry === null || installed === null) {
        toast('市场接口暂不可用（重启桌面版后生效）')
      }
    }
    const grid = $('#marketGrid')
    if (grid === null) return
    grid.innerHTML = ''
    const plugins = marketCache?.registry?.registry?.plugins ?? []
    const installedMap = marketCache?.installed?.installed ?? {}
    const filtered = plugins.filter((plugin) => {
      if (filter === '') return true
      const haystack = `${plugin.name} ${plugin.description ?? ''} ${plugin.npm ?? ''}`.toLowerCase()
      return haystack.includes(filter)
    })
    if (filtered.length === 0) {
      grid.innerHTML = '<div class="empty" style="grid-column:1/-1"><strong>没有匹配插件</strong><p>换个关键词试试。</p></div>'
      return
    }
    for (const plugin of filtered.slice(0, 48)) {
      const isInstalled = installedMap[plugin.name] !== undefined
      const card = doc.createElement('article')
      card.className = 'card card-pad'
      const title = doc.createElement('h3')
      title.textContent = plugin.name
      const desc = doc.createElement('p')
      desc.textContent = (plugin.description ?? '').slice(0, 90)
      const actionRow = doc.createElement('div')
      actionRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-top:12px'
      const badge = doc.createElement('span')
      badge.className = `tag ${isInstalled ? 'accent' : 'blue'}`
      badge.textContent = isInstalled ? '已安装' : '可安装'
      const action = doc.createElement('button')
      action.className = 'mini'
      action.textContent = isInstalled ? '卸载' : '安装'
      action.addEventListener('click', () => {
        if (isInstalled) {
          if (!win.confirm(`卸载插件「${plugin.name}」？`)) return
          action.textContent = '处理中…'
          void api.uninstall(plugin.name).then((result) => {
            marketCache = null
            if (result === null) toast('卸载失败或接口未就绪')
            else toast(`${plugin.name} 已卸载`)
            void renderMarketPage(filter)
          })
        } else {
          action.textContent = '安装中…'
          void api.install(plugin.url).then((result) => {
            const body = result as { error?: string } | null
            if (result === null) { toast('安装失败：接口未就绪'); action.textContent = '安装' }
            else if (body?.error !== undefined) { toast(`安装失败：${body.error}`); action.textContent = '安装' }
            else {
              marketCache = null
              toast(`${plugin.name} 安装成功，重启桌面版后生效`)
              void renderMarketPage(filter)
            }
          })
        }
      })
      actionRow.append(badge, action)
      card.append(title, desc, actionRow)
      grid.appendChild(card)
    }
  }

  // ── central refresh / navigation ──
  async function refreshAll(): Promise<void> {
    const [memory, knowledge, news] = await Promise.all([api.memory(), api.knowledge(), api.news(false)])
    await renderHome(memory, knowledge, news)
    await Promise.all([
      renderFullTasks(),
      renderCalendarPage(),
      renderFilesPage(),
      renderTeamPage(),
      renderSettingsPage(),
      renderMarketPage(),
    ])
  }

  const pages: Record<string, () => void> = {
    home: () => { void refreshAll() },
    tasks: () => { void renderFullTasks() },
    calendar: () => { void renderCalendarPage() },
    files: () => { void renderFilesPage() },
    team: () => { void renderTeamPage() },
    settings: () => { void renderSettingsPage() },
    market: () => { void renderMarketPage() },
  }
  const titles: Record<string, { name: string, no: string }> = {
    home: { name: '办公工作台', no: '01' },
    tasks: { name: '任务清单', no: '02' },
    calendar: { name: '日历安排', no: '03' },
    files: { name: '本地文件', no: '04' },
    team: { name: '团队协作', no: '05' },
    settings: { name: '工作台设置', no: '06' },
    market: { name: '插件市场', no: '07' },
  }
  win.navigate = (page: string): void => {
    $$('.page').forEach((element) => element.classList.toggle('active', element.dataset['page'] === page))
    $$('.nav-btn').forEach((element) => {
      const active = element.dataset['nav'] === page
      element.classList.toggle('active', active)
      if (active) element.setAttribute('aria-current', 'page')
      else element.removeAttribute('aria-current')
    })
    const title = titles[page]
    setText('#pageTitle', title?.name ?? '办公工作台')
    setText('#pageKicker', `实时 / ${title?.no ?? '—'} · 工作区`)
    toast(`已切换到${title?.name ?? '办公工作台'}`)
    pages[page]?.()
  }

  // primary buttons retargeted to live actions (runtime only; theme intact)
  const addTask = $('#addTaskBtn')
  addTask?.addEventListener('click', () => { ($('#taskDialog') as HTMLDialogElement | null)?.showModal() }, { capture: true })
  const addTask2 = $('#addTaskBtn2')
  addTask2?.addEventListener('click', () => { ($('#taskDialog') as HTMLDialogElement | null)?.showModal() }, { capture: true })
  const upload = $('#uploadBtn')
  upload?.addEventListener('click', () => { ($('#taskDialog') as HTMLDialogElement | null)?.showModal() }, { capture: true })
  const addEvent = $('#addEventBtn')
  addEvent?.addEventListener('click', () => { void refreshAll() }, { capture: true })
  const reset = $('#resetBtn')
  reset?.addEventListener('click', () => { toast('桌面工作台偏好保存在本地') }, { capture: true })
  const clearDone = $('#clearDoneBtn')
  clearDone?.addEventListener('click', () => { toast('知识卡请使用列表中的「删」按钮') }, { capture: true })
  const searchBtn = $('#searchBtn')
  searchBtn?.addEventListener('click', () => { win.navigate?.('market') }, { capture: true })
  const focusBtn = $('#focusBtn')
  focusBtn?.addEventListener('click', () => { toast('本地模式运行中，工作区已连接') }, { capture: true })

  interceptTaskForm()
  ensureMarketPage()
  void refreshAll()

  return () => {
    win.removeEventListener('message', onReply)
    const dialog = readerDialog
    if (dialog !== null) dialog.remove()
    readerDialog = null
  }
}
