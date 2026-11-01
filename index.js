/**
 * 超期会话自动归档（宿主半边）。
 *
 * 职责三件：
 *  1. 判定：扫 $DSH_HOME/sessions 下各工作区里的 session-* 目录，取会话档最新写入时间当「最后活动」，
 *     列出超过阈值、未归档、不在保护名单、非置顶的候选。
 *  2. 名单：保护名单（不被自动归档）与阈值落盘在 `$DSH_HOME/session-autarchive/state.json`。
 *  3. 通道：给浏览器半边三条路由（读状态 / 改保护 / 立即执行），并注册一个工具做同样的事。
 *
 * 为什么判定在宿主、执行多在浏览器半边：宿主算得准（文件时间、registry 归档集与置顶集都在这一侧），
 * 但宿主直接归档时侧栏不会立刻刷新；浏览器半边调 uiWorkspace.archiveSession 走的是官方通道，
 * 侧栏当场更新还有原生交互。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Cordis 插件名。 */
export const name = 'dsh-session-autarchive'
/** 需要的服务（webServer / workspaceRegistry 走可选获取，缺了也不该拦加载）。 */
export const inject = ['tools']

/** 路由前缀（与浏览器半边的 ROUTE 对齐；**前导斜杠不能省**——少了它路由挂不上，客户端一律 404）。 */
const API_PREFIX = '/dsh-session-autarchive/api'
const DAY_MS = 86400000

const DEFAULT_STATE = {
  enabled: true,
  days: 5,
  exemptPinned: true,
  protected: [],
  lastRunAt: 0,
  lastResult: '',
}

/** DSH 数据根。 */
function dshHome() {
  return process.env.DSH_HOME || join(process.env.USERPROFILE || process.cwd(), '.dsh')
}

/** 数据目录。 */
function dirPath() {
  return join(dshHome(), 'session-autarchive')
}

/** 状态文件路径（配置与最近一次执行结果）。 */
function statePath() {
  return join(dirPath(), 'state.json')
}

/**
 * 保护名单的真实来源。单独一份文件、只有 protect／unprotect 会写它——
 * 自动归档那条定时链只写 state.json，怎么覆盖都碰不到名单。
 */
function protectPath() {
  return join(dirPath(), 'protected.json')
}

/** 改动留痕（名单改动与每轮归档结果各一行），出问题时对着时间看。 */
function auditPath() {
  return join(dirPath(), 'audit.log')
}

/** 同步小睡：Node 没有 setTimeoutSync，用 Atomics.wait 让出毫秒。 */
function sleep(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const until = Date.now() + ms
    while (Date.now() < until) { /* 兜底自旋 */ }
  }
}

/**
 * 读一份 JSON：文件不存在直接给 undefined；解析失败重试几次
 * （旧写法读盘不重试，撞上半截文件就当成「没有名单」，再把默认值写回去）。
 */
function readJson(file, attempts = 4) {
  for (let i = 0; i < attempts; i += 1) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') return undefined
      if (i === attempts - 1) return undefined
      sleep(20)
      continue
    }
    try {
      return JSON.parse(text)
    } catch {
      if (i === attempts - 1) return undefined
      sleep(20)
    }
  }
  return undefined
}

/** 原子写：先写临时文件再改名，读的一侧永远看不到半截内容。 */
function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp'
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  for (let i = 0; i < 10; i += 1) {
    try {
      renameSync(tmp, file)
      return
    } catch (error) {
      if (i === 9) {
        try { unlinkSync(tmp) } catch { /* 临时文件清不掉就留着，不影响正在用的那份 */ }
        throw error
      }
      sleep(15)
    }
  }
}

/** 读保护名单；保护名单文件还不存在时，从老版 state.json 里迁出来。 */
function readProtected() {
  const list = readJson(protectPath())
  if (Array.isArray(list)) return [...new Set(list.map(String))]
  const legacy = readJson(statePath())
  const migrated = legacy && Array.isArray(legacy.protected) ? legacy.protected.map(String) : []
  if (migrated.length > 0) {
    try { writeProtected(migrated) } catch { /* 迁不动就先用内存里这份，下次再迁 */ }
  }
  return [...new Set(migrated)]
}

/** 写保护名单。 */
function writeProtected(list) {
  writeJsonAtomic(protectPath(), [...new Set(list.map(String))])
}

/** 读状态（配置与统计；名单从 protected.json 取，缺字段按默认补，文件坏了不抛错）。 */
function readState() {
  const parsed = readJson(statePath())
  const merged = { ...DEFAULT_STATE, ...(parsed && typeof parsed === 'object' ? parsed : {}) }
  merged.protected = readProtected()
  merged.days = Number(merged.days) > 0 ? Number(merged.days) : DEFAULT_STATE.days
  return merged
}

/** 写状态：名单不落在这个文件里，所以这里整份覆盖也丢不了标记。 */
function writeState(state) {
  const { protected: _protected, ...rest } = state
  writeJsonAtomic(statePath(), rest)
}

/** 追加一行审计。 */
function audit(line) {
  try {
    mkdirSync(dirPath(), { recursive: true })
    appendFileSync(auditPath(), new Date().toISOString() + ' ' + line + '\n', 'utf8')
  } catch { /* 审计写不进去不影响主流程 */ }
}

/** 扫描会话档：每个会话目录的最新子文件时间即「最后活动」。 */
function scanSessions() {
  const root = join(dshHome(), 'sessions')
  const rows = []
  if (!existsSync(root)) return rows
  for (const ws of readdirSync(root, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue
    const wsPath = join(root, ws.name)
    let entries
    try { entries = readdirSync(wsPath, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^session-/.test(entry.name)) continue
      const dir = join(wsPath, entry.name)
      let mtime = 0
      try {
        for (const file of readdirSync(dir)) {
          try { mtime = Math.max(mtime, statSync(join(dir, file)).mtimeMs) } catch { /* 单个文件读不到就跳过 */ }
        }
      } catch { /* 目录读不到就跳过 */ }
      if (mtime === 0) {
        try { mtime = statSync(dir).mtimeMs } catch { /* 换成目录时间也算 */ }
      }
      rows.push({ id: entry.name, mtime, workspace: ws.name })
    }
  }
  return rows
}

/** 汇总一侧的事实：归档集、置顶集、保护名单、可见会话集。 */
function readFacts(ctx, state) {
  const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
  const archived = new Set(((registry && registry.archivedSessionIds) || []).map(String))
  const pinned = new Set(((registry && registry.pinnedSessionIds) || []).map(String))
  const guarded = new Set((state.protected || []).map(String))
  let visible = null
  try {
    const ids = registry ? registry.list().flatMap((w) => (w.sessionIds || []).map(String)) : []
    if (ids.length > 0) visible = new Set(ids)
  } catch { visible = null }
  return { registry, archived, pinned, guarded, visible }
}

/** 算出这一轮该归档谁。 */
function plan(ctx, state, now = Date.now()) {
  const facts = readFacts(ctx, state)
  const cutoff = now - Number(state.days) * DAY_MS
  const candidates = scanSessions()
    .filter((row) => row.mtime > 0 && row.mtime < cutoff)
    .filter((row) => !facts.archived.has(row.id) && !facts.guarded.has(row.id))
    .filter((row) => !(state.exemptPinned && facts.pinned.has(row.id)))
    .filter((row) => facts.visible === null || facts.visible.has(row.id))
    .sort((a, b) => a.mtime - b.mtime)
  return { ...facts, candidates }
}

/** 宿主自己执行归档（浏览器半边不在场时也能用工具跑）。 */
async function runArchive(ctx, state, dryRun) {
  const { registry, candidates } = plan(ctx, state)
  if (!registry || typeof registry.archiveSession !== 'function') {
    return { archived: [], failed: ['宿主没有 workspaceRegistry 服务，无法归档'], candidates }
  }
  if (dryRun) return { archived: [], failed: [], candidates }
  const archived = []
  const failed = []
  for (const item of candidates) {
    // 名单可能在候选算完之后才改：动手前再看一眼名单，保护优先于这一轮的候选
    let guardedNow = false
    try { guardedNow = readProtected().includes(item.id) } catch { guardedNow = false }
    if (guardedNow) continue
    try {
      await registry.archiveSession(item.id)
      archived.push(item.id)
    } catch (error) {
      failed.push(item.id + '：' + String((error && error.message) || error))
    }
  }
  // 写统计前重新读一遍当前配置：绝不用函数开头那份旧快照盖掉这期间的改动
  const next = {
    ...readState(),
    lastRunAt: Date.now(),
    lastResult: '归档 ' + archived.length + ' 个' + (failed.length > 0 ? '，失败 ' + failed.length + ' 个' : ''),
  }
  writeState(next)
  audit('run 候选 ' + candidates.length + ' 个，归档 ' + archived.length + ' 个，失败 ' + failed.length + ' 个')
  return { archived, failed, candidates, state: next }
}

/** 本地时间文本（不写日期后缀，只用于人读）。 */
function stamp(ms) {
  if (!ms) return '—'
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}

/** 相对天数，用于候选行。 */
function ago(ms, now) {
  return Math.round((now - ms) / DAY_MS) + ' 天前'
}

/** 一行配置摘要。 */
function describe(state) {
  return '自动归档：' + (state.enabled ? '开' : '关')
    + '｜阈值：' + state.days + ' 天'
    + '｜置顶豁免：' + (state.exemptPinned ? '开' : '关')
    + '｜保护名单：' + (state.protected.length) + ' 个'
}

/** 状态文本（工具输出，也给路由复用）。 */
function statusText(ctx, state, now = Date.now()) {
  const { candidates, archived, pinned, guarded } = plan(ctx, state, now)
  const lines = [describe(state), '']
  lines.push('当前候选（超期且未受保护）：' + candidates.length + ' 个')
  for (const c of candidates.slice(0, 30)) {
    lines.push('  - ' + c.id.slice(8, 16) + '  最后活动 ' + stamp(c.mtime) + '（' + ago(c.mtime, now) + '）')
  }
  if (candidates.length > 30) lines.push('  …（其余 ' + (candidates.length - 30) + ' 个）')
  lines.push('')
  lines.push('保护名单（不自动归档）：' + (state.protected.length > 0 ? '' : '（空）'))
  for (const id of state.protected) lines.push('  - ' + id.slice(8, 16))
  lines.push('已归档：' + archived.size + ' 个｜置顶：' + pinned.size + ' 个｜命中保护：' + guarded.size + ' 个')
  lines.push('最近一次执行：' + (state.lastRunAt ? stamp(state.lastRunAt) + '，' + state.lastResult : '还没跑过'))
  lines.push('状态文件：' + statePath())
  return lines.join('\n')
}

/** 是否本机请求。 */
function isLocal(req) {
  const addr = req.socket && req.socket.remoteAddress
  return typeof addr === 'string' && /^(::1|127\.|::ffff:127\.)/.test(addr)
}

/** 回一个 JSON。 */
function sendJson(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** 读请求体。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let text = ''
    req.on('data', (chunk) => { text += chunk; if (text.length > 1e6) req.destroy() })
    req.on('end', () => resolve(text))
    req.on('error', reject)
  })
}

/** 挂三条路由（webServer 在 apply 期可能还没进上下文，走 inject 等它到位）。 */
function registerRoutes(ctx) {
  const mount = (hostCtx, webServer) => {
    hostCtx.effect(() => webServer.register({
      kind: 'exact',
      path: API_PREFIX + '/state',
      handler: async (req, res) => {
        if (!isLocal(req)) return sendJson(res, 403, { ok: false, error: '只接受本机请求' })
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '只支持 GET' })
        try {
          const state = readState()
          const now = Date.now()
          const { candidates } = plan(ctx, state, now)
          sendJson(res, 200, {
            ok: true,
            enabled: state.enabled,
            days: state.days,
            exemptPinned: state.exemptPinned,
            protected: state.protected,
            candidates: candidates.map((c) => ({ id: c.id, mtime: c.mtime })),
            now,
          })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
        }
      },
    }), 'dsh-session-autarchive: state route')

    hostCtx.effect(() => webServer.register({
      kind: 'exact',
      path: API_PREFIX + '/protect',
      handler: async (req, res) => {
        if (!isLocal(req)) return sendJson(res, 403, { ok: false, error: '只接受本机请求' })
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST' })
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const sessionId = String(body.sessionId || '')
          if (!/^session-/.test(sessionId)) return sendJson(res, 400, { ok: false, error: '会话 id 不合法' })
          const state = readState()
          const keep = new Set(state.protected)
          if (body.protected === false) keep.delete(sessionId)
          else keep.add(sessionId)
          const list = [...keep]
          writeProtected(list)
          audit((body.protected === false ? 'unprotect ' : 'protect ') + sessionId + '，名单现有 ' + list.length + ' 个')
          sendJson(res, 200, { ok: true, protected: list, protectedNow: keep.has(sessionId) })
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
        }
      },
    }), 'dsh-session-autarchive: protect route')

    // 设置页写配置：与工具的 config 动作写同一个 days 字段（界面上改天数走这条）。
    hostCtx.effect(() => webServer.register({
      kind: 'exact',
      path: API_PREFIX + '/config',
      handler: async (req, res) => {
        if (!isLocal(req)) return sendJson(res, 403, { ok: false, error: '只接受本机请求' })
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST' })
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const next = readState()
          if (body.days !== undefined) {
            const days = Number(body.days)
            if (!Number.isFinite(days) || days < 1 || days > 3650) {
              return sendJson(res, 400, { ok: false, error: '天数要是 1～3650 之间的整数' })
            }
            next.days = Math.round(days)
          }
          if (body.enabled !== undefined) next.enabled = body.enabled === true
          if (body.exemptPinned !== undefined) next.exemptPinned = body.exemptPinned === true
          writeState(next)
          audit('config ' + describe(next))
          sendJson(res, 200, { ok: true, enabled: next.enabled, days: next.days, exemptPinned: next.exemptPinned })
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
        }
      },
    }), 'dsh-session-autarchive: config route')

    hostCtx.effect(() => webServer.register({
      kind: 'exact',
      path: API_PREFIX + '/run',
      handler: async (req, res) => {
        if (!isLocal(req)) return sendJson(res, 403, { ok: false, error: '只接受本机请求' })
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST' })
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const result = await runArchive(ctx, readState(), body.dryRun === true)
          sendJson(res, 200, { ok: true, archived: result.archived, failed: result.failed })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
        }
      },
    }), 'dsh-session-autarchive: run route')
  }

  const direct = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  if (direct && typeof direct.register === 'function') {
    mount(ctx, direct)
    return
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (hostCtx) => {
      const webServer = hostCtx
        && (hostCtx.webServer || (typeof hostCtx.get === 'function' ? hostCtx.get('webServer') : undefined))
      if (!webServer || typeof webServer.register !== 'function') return
      mount(hostCtx, webServer)
    })
  }
}

/** 注册工具与路由。 */
export function apply(ctx) {
  ctx.tools.register({
    name: 'dsh-session-autarchive',
    description: '超期会话自动归档的开关台：status 看配置、保护名单与当前候选；run 立刻归档候选；protect/unprotect 标记单个会话「不自动归档」；config 改阈值与开关。判定口径＝会话档最后写入时间（$DSH_HOME/sessions），已归档、保护名单内、置顶（可关）都跳过。浏览器半边每 5 分钟按同一份清单自动执行，侧栏右键菜单的「不自动归档」也写这份名单。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: '要做什么：status（默认，看状态）｜run（立刻归档候选）｜protect（标记不自动归档）｜unprotect（取消标记）｜config（改阈值/开关）' },
        sessionId: { type: 'string', description: 'protect/unprotect 用：会话 id，形如 session-xxxxxxxx-…' },
        dryRun: { type: 'boolean', description: 'run 用：true 时只列候选、不动手' },
        days: { type: 'number', description: 'config 用：多少天没动就归档，默认 5' },
        enabled: { type: 'boolean', description: 'config 用：是否启用自动归档' },
        exemptPinned: { type: 'boolean', description: 'config 用：置顶会话是否也豁免（默认豁免）' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
        required: ['ok', 'text'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const action = String((args && args.action) || 'status')
      let state = readState()

      if (action === 'status') {
        return { ok: true, text: statusText(ctx, state) }
      }

      if (action === 'run') {
        const result = await runArchive(ctx, state, args && args.dryRun === true)
        const head = args && args.dryRun === true
          ? '干跑：候选 ' + result.candidates.length + ' 个，未动手'
          : '已归档 ' + result.archived.length + ' 个' + (result.failed.length > 0 ? '，失败 ' + result.failed.length + ' 个' : '')
        const lines = [head]
        for (const id of result.archived) lines.push('  ✓ ' + id.slice(8, 16))
        for (const line of result.failed) lines.push('  ✗ ' + line)
        if (args && args.dryRun === true) {
          for (const c of result.candidates) lines.push('  · ' + c.id.slice(8, 16) + '  最后活动 ' + stamp(c.mtime))
        }
        return { ok: true, text: lines.join('\n') }
      }

      if (action === 'protect' || action === 'unprotect') {
        const sessionId = String((args && args.sessionId) || '')
        if (!/^session-/.test(sessionId)) return { ok: false, text: 'protect/unprotect 需要 sessionId（形如 session-xxxxxxxx-…）' }
        const keep = new Set(state.protected)
        if (action === 'protect') keep.add(sessionId)
        else keep.delete(sessionId)
        state = { ...state, protected: [...keep] }
        writeProtected(state.protected)
        audit((action === 'protect' ? 'protect ' : 'unprotect ') + sessionId + '，名单现有 ' + state.protected.length + ' 个')
        return {
          ok: true,
          text: (action === 'protect' ? '已标记不自动归档：' : '已取消标记：') + sessionId
            + '\n保护名单现有 ' + state.protected.length + ' 个',
        }
      }

      if (action === 'config') {
        const next = { ...state }
        if (args.days !== undefined) next.days = Number(args.days) > 0 ? Number(args.days) : next.days
        if (args.enabled !== undefined) next.enabled = args.enabled === true
        if (args.exemptPinned !== undefined) next.exemptPinned = args.exemptPinned === true
        writeState(next)
        return { ok: true, text: '已更新：' + describe(next) }
      }

      return { ok: false, text: '不认识的 action：' + action + '（可用 status／run／protect／unprotect／config）' }
    },
  })

  registerRoutes(ctx)

  // 宿主侧兜底：浏览器窗口没开着也照常归档（客户端那条是让侧栏当场刷新的快通道）。
  // 启动 60 秒后第一次（避开启动竞争），之后每 10 分钟。
  const tick = () => { void runArchive(ctx, readState(), false).catch(() => { /* 这轮不行，下一轮再来 */ }) }
  const first = setTimeout(tick, 60 * 1000)
  const timer = setInterval(tick, 10 * 60 * 1000)
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => { clearTimeout(first); clearInterval(timer) })
  }
}
