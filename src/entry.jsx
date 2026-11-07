/**
 * 超期会话自动归档（浏览器半边源码）。
 *
 * 会话列表上三处，都只在「点开菜单」或「被标记」之后才出现：
 *  1. 会话菜单里平铺一行「不自动归档」——与官方「置顶会话／重命名／分叉会话／归档会话」同层并列，不另造「更多」；
 *  2. 被标记的会话行首一个小盾牌；
 *  3. 悬停卡片里一行说明。
 * 行尾那排悬停图标按钮**不放东西**（不与归档／置顶图标并排）。
 * 设置里一行：通用设置最底「自动归档天数」（`settings.general.item`），失焦或回车即落盘。
 * 外加每 5 分钟拉一次宿主的候选清单：拿得到官方归档通道就顺手归档，拿不到就只刷新名单——
 * 判定在宿主，宿主自己有兜底定时（窗口没开也照常归档）。
 *
 * ⚠️ 客户端 entry 里只用已验证的写法：`export const inject = ['slots']` + `ctx.slots.inject/register`，
 *   服务探测一律 `ctx.get('…')`；`ctx.inject([...], cb)` 与直接 `ctx.uiWorkspace` 会把 entry 打成 failed
 *   （桌面端会弹「启动失败」）。apply 整体再兜一层 try/catch。
 *
 * 样式照原生：菜单行用 ui-primitives Menu.module.css 的 `.item` 数值（13px/20px、min-height 34px、padding 6px 8px、
 * gap 6px、图标 14px），颜色走 `--dsw-alias-*`。不 import 宿主包，全部内联。
 *
 * 打包：npm run build:client → lib/client.js（window.__ModuleLoader__.load 外壳，id 等于包名）。
 */
import { useEffect, useState } from 'react'

/** 宿主路由前缀。 */
const ROUTE = 'dsh-session-autarchive/api'
/** 名单刷新间隔：5 分钟。 */
const TICK_MS = 5 * 60 * 1000
/** 一轮最多归档多少个。 */
const MAX_PER_TICK = 60

/** 把路由拼成当前挂载点下的路径（锚 document.baseURI，兼容子路径部署）。 */
function api(path) {
  const relative = String(path).replace(/^\/+/, '')
  if (typeof document === 'undefined') return '/' + relative
  return new URL(relative, document.baseURI).pathname
}

/** 调宿主路由；宿主按 { ok, ... } 回包，ok === false 时抛出 error。 */
async function call(method, path, body) {
  const res = await fetch(api(path), {
    method,
    headers: body ? { 'content-type': 'application/json' } : { accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => null)
  if (!res.ok || !data || data.ok === false) throw new Error((data && data.error) || ('HTTP ' + res.status))
  return data
}

/** 模块级缓存：菜单行与标记读同一份。 */
const store = {
  enabled: true,
  days: 5,
  protected: new Set(),
  candidates: [],
}
const listeners = new Set()

/** 通知所有订阅者重渲染。 */
function emit() {
  for (const fn of [...listeners]) {
    try { fn() } catch { /* 单个订阅者出错不影响其他 */ }
  }
}

/** 合并状态并通知。 */
function patchStore(next) {
  Object.assign(store, next)
  emit()
}

/** 订阅同一份缓存。 */
function useStore() {
  const [, bump] = useState(0)
  useEffect(() => {
    const fn = () => bump((n) => n + 1)
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  }, [])
  return store
}

/** 拉一次宿主状态。 */
async function pull() {
  const data = await call('GET', ROUTE + '/state')
  patchStore({
    enabled: data.enabled !== false,
    days: Number(data.days) > 0 ? Number(data.days) : 5,
    // 名单字段缺失（宿主没回、老版本回包）时保留本地这份：宁可多显示盾牌，也不整片清空
    protected: Array.isArray(data.protected) ? new Set(data.protected) : store.protected,
    candidates: Array.isArray(data.candidates) ? data.candidates : [],
  })
  return data
}

/** 官方归档通道：只用 ctx.get 探测（拿不到就这一轮不动手，宿主侧还有兜底定时）。 */
function archiveChannel(ctx) {
  try {
    const found = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined
    return found && typeof found.archiveSession === 'function' ? found : undefined
  } catch {
    return undefined
  }
}

/** 一轮：刷新名单，顺手把候选归档掉（走官方通道，侧栏当场刷新）。 */
async function runOnce(ctx) {
  const workspace = archiveChannel(ctx)
  const data = await pull()
  if (!workspace || !data.enabled || !Array.isArray(data.candidates) || data.candidates.length === 0) return
  let done = 0
  for (const item of data.candidates.slice(0, MAX_PER_TICK)) {
    // 本地名单里已经有它（刚点过保护、宿主回包还没跟上）就不动手
    if (store.protected.has(item.id)) continue
    try {
      await workspace.archiveSession(item.id)
      done += 1
    } catch { /* 这轮归档不了（有活跃工作或被拒），下一轮再看 */ }
  }
  if (done > 0) await pull()
}

/** 切换保护标记（写宿主名单，成功后当场刷新本地缓存）。 */
async function toggleProtect(sessionId, protectedNow) {
  const data = await call('POST', ROUTE + '/protect', { sessionId, protected: protectedNow })
  patchStore({ protected: Array.isArray(data.protected) ? new Set(data.protected) : store.protected })
}

/**
 * 「不自动归档」盾牌图标：与原生菜单图标同为 14px、跟随 currentColor。
 * @param props.size - 边长，默认 14。
 * @returns 一个描边盾牌。
 */
function ShieldIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false"
      fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l7 2.6v5.2c0 4.3-3 8.2-7 9.4-4-1.2-7-5.1-7-9.4V5.6L12 3z" />
    </svg>
  )
}

/** 菜单行：照 ui-primitives Menu.module.css 的 `.item`。 */
const ITEM = {
  display: 'flex', alignItems: 'center', gap: '6px', width: '100%', minHeight: '34px',
  padding: '6px 8px', border: 'none', borderRadius: 'var(--dsw-radius-md)',
  background: 'transparent', cursor: 'pointer', fontSize: '13px', lineHeight: '20px',
  color: 'var(--dsw-alias-label-primary)', textAlign: 'left', fontFamily: 'inherit',
}

/** 图标格：照 `.itemIcon`。 */
const ITEM_ICON = {
  display: 'inline-flex', flex: 'none', width: '14px', height: '14px',
  alignItems: 'center', justifyContent: 'center', color: 'var(--dsw-alias-menu-icon)',
}

/** props 里没给开合钩子时的替身（保持 hook 调用次数恒定）。 */
const noopMenuHook = () => [false, () => {}]

/**
 * 会话菜单里的一行「不自动归档」：与官方四项同层并列（order 450，紧跟「归档会话」）。
 * @param props - 行身份与菜单开合状态钩子。
 * @returns 一行菜单按钮。
 */
export function ProtectMenuItem(props) {
  const { sessionId } = props
  const state = useStore()
  const menuHook = typeof props.useMenuOpenState === 'function' ? props.useMenuOpenState : noopMenuHook
  const [, setMenuOpen] = menuHook()
  const [hover, setHover] = useState(false)
  const [busy, setBusy] = useState(false)
  const on = state.protected.has(sessionId)
  const click = () => {
    setMenuOpen(false)
    setBusy(true)
    void toggleProtect(sessionId, !on)
      .catch(() => { /* 路由没挂或写盘失败：不改本地状态，界面保持原样 */ })
      .finally(() => setBusy(false))
  }
  return (
    <button
      type="button"
      role="menuitem"
      disabled={busy}
      onClick={click}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...ITEM,
        background: hover && !busy ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
        opacity: busy ? 0.4 : 1,
      }}
    >
      <span aria-hidden="true" style={{ ...ITEM_ICON, color: on ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-menu-icon)' }}>
        <ShieldIcon />
      </span>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {on ? '取消「不自动归档」' : '不自动归档'}
      </span>
    </button>
  )
}

/**
 * 会话行首标记：被保护的会话显示盾牌（该格只在行处于空闲态时才渲染）。
 * @param props - 行身份。
 * @returns 小盾牌，或空。
 */
export function ProtectLeading(props) {
  const state = useStore()
  if (!state.protected.has(props.sessionId)) return null
  return (
    <span title="不会被自动归档" aria-label="不会被自动归档" style={ITEM_ICON}>
      <ShieldIcon />
    </span>
  )
}

/**
 * 会话悬停卡片里的一行说明。
 * @param props - 行身份。
 * @returns 一行文字，或空。
 */
export function ProtectHover(props) {
  const state = useStore()
  if (!state.protected.has(props.sessionId)) return null
  return (
    <span style={{ fontSize: '11px', lineHeight: '16px', color: 'var(--dsw-alias-label-caption)' }}>不会被自动归档</span>
  )
}

/** 通用设置的行：版式照 ui-settings-general 的 DeveloperToolsRow（上下 16px、发丝分隔线、14px 标题 + 12px 说明）。 */
const ROW_CSS = `
.zsa-item { display:flex; align-items:center; gap:8px; padding:16px 0; border-bottom:0.5px solid var(--dsw-alias-border-l2); }
.zsa-text { flex:1; min-width:0; display:flex; flex-direction:column; gap:4px; padding-right:24px; }
.zsa-title { font-size:14px; font-weight:400; line-height:22px; color:var(--dsw-alias-label-primary); }
.zsa-desc { font-size:12px; line-height:18px; color:var(--dsw-alias-label-secondary); }
.zsa-field { flex:none; display:flex; align-items:center; gap:8px; }
.zsa-input { width:88px; height:36px; padding:0 10px; border:1px solid var(--dsw-alias-border-l1); border-radius:var(--dsw-radius-md); background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font:inherit; font-size:14px; text-align:center; }
.zsa-input:focus { outline:none; border-color:var(--dsw-alias-brand-primary); }
.zsa-unit { font-size:12px; color:var(--dsw-alias-label-secondary); }
.zsa-error { font-size:12px; line-height:18px; color:var(--dsw-alias-state-error-primary); }
`

/** 开关：纯内联样式，不 import 宿主组件包。 */
function Switch({ on, disabled, onChange }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={on ? '关闭自动归档' : '开启自动归档'}
      disabled={disabled}
      onClick={() => onChange(!on)}
      style={{
        width: 36, height: 20, flex: 'none', border: 0, borderRadius: 10, padding: 0,
        cursor: disabled ? 'default' : 'pointer', position: 'relative',
        background: on ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)',
        opacity: disabled ? 0.5 : 1, transition: 'background .15s',
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: on ? 18 : 2, width: 16, height: 16,
        borderRadius: 8, background: '#fff', transition: 'left .15s',
      }} />
    </button>
  )
}

/**
 * 通用设置里的一行：自动归档开关。
 * 关掉后宿主定时链与浏览器侧都不再自动归档；手动 run 不受影响（宿主那边也这么判）。
 * @returns 一行设置。
 */
export function AutoArchiveToggleRow() {
  const state = useStore()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const on = state.enabled !== false

  const toggle = async (next) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const data = await call('POST', ROUTE + '/config', { enabled: next })
      patchStore({ enabled: data.enabled !== false })
    } catch (err) {
      setError('没保存上：' + String((err && err.message) || err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="zsa-item">
      <style>{ROW_CSS}</style>
      <div className="zsa-text">
        <div className="zsa-title">自动归档</div>
        <div className="zsa-desc">
          {'关闭后后台不再自动归档；手动执行仍然可用。当前候选 ' + state.candidates.length + ' 个。'}
        </div>
        {error ? <div className="zsa-error" role="alert">{error}</div> : null}
      </div>
      <div className="zsa-field">
        <Switch on={on} disabled={busy} onChange={(next) => void toggle(next)} />
      </div>
    </div>
  )
}

/**
 * 通用设置里的一行：自动归档天数。
 * 失焦或回车即落盘（与设置里其它行一样即时生效），写的是宿主同一个 days 字段。
 * @returns 一行设置。
 */
export function AutoArchiveRow() {
  const state = useStore()
  const [draft, setDraft] = useState(null)
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(null)

  // 打开通用页就拿一次最新候选数：设置页可能开着很久。
  useEffect(() => {
    void pull()
      .then(() => setLoaded(true))
      .catch(() => { /* 宿主没起或路由没挂：候选数显示占位，不报错 */ })
  }, [])

  const value = draft === null ? String(state.days) : draft
  const parsed = Number(draft)
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= 3650

  /** 把草稿写回宿主（config 路由，与工具的 config 动作同一个字段）。 */
  const commit = async () => {
    if (draft === null || busy) return
    if (!valid) { setError('天数要是 1～3650 的整数'); setDraft(null); return }
    if (parsed === state.days) { setDraft(null); setError(null); return }
    setBusy(true)
    setError(null)
    try {
      const data = await call('POST', ROUTE + '/config', { days: parsed })
      patchStore({ days: Number(data.days) > 0 ? Number(data.days) : parsed })
      setDraft(null)
    } catch (err) {
      setError('没保存上：' + String((err && err.message) || err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="zsa-item">
      <style>{ROW_CSS}</style>
      <div className="zsa-text">
        <div className="zsa-title">自动归档天数</div>
        <div className="zsa-desc">
          {'超过这个天数没有活动的会话会被自动归档（已归档、置顶、标记「不自动归档」的跳过）。当前候选 ' + (loaded ? state.candidates.length : '—') + ' 个。'}
        </div>
        {error ? <div className="zsa-error" role="alert">{error}</div> : null}
      </div>
      <div className="zsa-field">
        <input
          className="zsa-input"
          type="number"
          min={1}
          max={3650}
          step={1}
          value={value}
          disabled={busy || state.enabled === false}
          aria-label="自动归档天数"
          onChange={(event) => { setDraft(event.target.value); setError(null) }}
          onBlur={() => { void commit() }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
            if (event.key === 'Escape') { setDraft(null); setError(null) }
          }}
        />
        <span className="zsa-unit">天</span>
      </div>
    </div>
  )
}

/** 需要的客户端服务（只用已验证的 slots；其余服务走 ctx.get 探测）。 */
export const inject = ['slots']

/**
 * 注册菜单行与标记，并启动名单刷新。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx) {
  // 自动归档/名单刷新：起不来也不影响下面的界面注册，更不该让整个 entry 失败。
  try {
    const tick = () => { void runOnce(ctx).catch(() => { /* 路由没挂或网络断了，下一轮再来 */ }) }
    tick()
    const timer = setInterval(tick, TICK_MS)
    try {
      if (typeof ctx.effect === 'function') ctx.effect(() => () => clearInterval(timer))
    } catch { /* 清理不了也只是多一个定时器 */ }
  } catch { /* 见上 */ }

  // 三处：菜单里并列一行 ＋ 行首标记 ＋ 悬停说明。行尾那排图标按钮不放东西。
  place(ctx, 'sidebar.workspaces.session.menu.item', 450, ProtectMenuItem)
  place(ctx, 'sidebar.session.row.leading', 100, ProtectLeading)
  place(ctx, 'sidebar.session.row.hover', 100, ProtectHover)

  // 通用设置里两行，排在「当前版本」上面（order 94/95，当前版本是 100）：
  // 「自动归档」开关与「自动归档天数」。先开关后天数，与页面从上到下的阅读顺序一致。
  try {
    ctx.slots.inject('settings.general.item', () => ctx.slots.register({
      name: 'settings.general.item',
      id: 'session-autarchive-enabled',
      order: 94,
    }, AutoArchiveToggleRow))
    ctx.slots.inject('settings.general.item', () => ctx.slots.register({
      name: 'settings.general.item',
      id: 'session-autarchive-days',
      order: 95,
    }, AutoArchiveRow))
  } catch { /* 通用页没有这个座位就算了，会话列表那三处不受影响 */ }
}

/**
 * 挂一个 slot 入口；这个位置没有就算了，不牵连其他。
 * @param ctx - 客户端根上下文。
 * @param slot - slot 名。
 * @param order - 注册顺序。
 * @param Component - 组件。
 */
function place(ctx, slot, order, Component) {
  try {
    ctx.slots.inject(slot, () => ctx.slots.register({
      name: slot,
      id: 'dsh-session-autarchive-' + slot.replace(/\./g, '-'),
      order,
    }, Component))
  } catch { /* 这个位置没有就算了 */ }
}
