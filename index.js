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
import * as zlib from 'node:zlib'

/** Cordis 插件名。 */
export const name = 'dsh-session-autarchive'
/** 需要的服务（webServer / workspaceRegistry 走可选获取，缺了也不该拦加载）。 */
export const inject = ['tools']

/** 路由前缀（与浏览器半边的 ROUTE 对齐；**前导斜杠不能省**——少了它路由挂不上，客户端一律 404）。 */
const API_PREFIX = '/dsh-session-autarchive/api'
const DAY_MS = 86400000

/** zstd 帧头魔数（小端读出的值）。 */
const ZSTD_MAGIC = 0xfd2fb528
/** 刚被写过的会话留一小时宽限：正开着的那个不该在同一次 tick 里被收走。 */
const GRACE_MS = 60 * 60 * 1000
/** 一轮里最多解多少个档（解压是整份读进来，防止一次把几百兆都展开）。 */
const MAX_DECODE = 400
/** 会话档「最后一条对话结束时间」的缓存：同一个 文件+大小+写入时间 只解一次。 */
const turnCache = new Map()
/** 本轮还剩多少次解码额度（每次 plan 重置）。 */
let decodeBudget = MAX_DECODE

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
      rows.push({ id: entry.name, mtime, workspace: ws.name, dir })
    }
  }
  return rows
}

/**
 * 定位会话档里所有完整 zstd 帧的字节范围（会话档是多帧拼接：一帧一条追加）。
 * 算法与 DSH 自己的 scanZstdFrames 一致；尾部撕裂帧直接当结束。
 */
function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return frames
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return frames
    offset += 4
    if (offset === buffer.length) return frames
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) return frames
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return frames
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return frames
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) return frames
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return frames
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return frames
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

/** 逐帧解压拼回整份文本；坏帧跳过，全坏返回空串。 */
function decodeSessionText(buffer) {
  const parts = []
  for (const frame of scanZstdFrames(buffer)) {
    try {
      parts.push(zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8'))
    } catch { /* 单帧坏了不影响别的帧 */ }
  }
  return parts.join('\n')
}

/** 会话目录里当前那一代的存档（多代并存时取最大的那份）。 */
function sessionFileOf(dir) {
  let best = ''
  let bestSize = -1
  let names
  try { names = readdirSync(dir) } catch { return '' }
  for (const name of names) {
    if (!name.endsWith('.zstd')) continue
    const full = join(dir, name)
    let size = 0
    try { size = statSync(full).size } catch { continue }
    if (size > bestSize) { best = full; bestSize = size }
  }
  return best
}

/**
 * 会话档里最后一条「对话结束」事件（turn/end）的时间。
 *
 * 为什么不用文件写入时间：会话被**打开/恢复**时，DSH 也会往档里追写
 * 开场提示（session/end-seed、agent/inbox/spliced），文件时间被顶新，
 * 于是一个 8 天没聊的会话看着像「4 天前还活着」，永远轮不到清理。
 * 打开会话不算活动，所以只认 turn/end。
 */
function lastTurnEndMs(file) {
  if (!file) return 0
  if (decodeBudget <= 0) return 0
  let st
  try { st = statSync(file) } catch { return 0 }
  const key = file + '|' + st.size + '|' + Math.floor(st.mtimeMs)
  const hit = turnCache.get(key)
  if (hit !== undefined) return hit
  decodeBudget -= 1
  let value = 0
  try {
    if (typeof zlib.zstdDecompressSync === 'function') {
      const text = decodeSessionText(readFileSync(file))
      for (const line of text.split('\n')) {
        if (line.length < 20 || line.indexOf('turn/end') === -1) continue
        try {
          const event = JSON.parse(line)
          if (event.type === 'turn/end' && typeof event.time === 'number' && event.time > value) value = event.time
        } catch { /* 坏行跳过 */ }
      }
    }
  } catch { value = 0 }
  if (turnCache.size > 4000) turnCache.clear()
  turnCache.set(key, value)
  return value
}

/** 这一行该按什么时间判超期：文件太新就先问对话最后结束在什么时候。 */
function activityMs(row, now, cutoff) {
  if (row.mtime <= 0) return 0
  if (row.mtime < cutoff) return row.mtime
  if (now - row.mtime < GRACE_MS) return row.mtime
  const last = lastTurnEndMs(sessionFileOf(row.dir))
  return last > 0 ? last : row.mtime
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
  decodeBudget = MAX_DECODE
  const facts = readFacts(ctx, state)
  const cutoff = now - Number(state.days) * DAY_MS
  const candidates = scanSessions()
    .map((row) => ({ ...row, last: activityMs(row, now, cutoff) }))
    .filter((row) => row.last > 0 && row.last < cutoff)
    .filter((row) => !facts.archived.has(row.id) && !facts.guarded.has(row.id))
    .filter((row) => !(state.exemptPinned && facts.pinned.has(row.id)))
    .filter((row) => facts.visible === null || facts.visible.has(row.id))
    .sort((a, b) => a.last - b.last)
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
  const lines = [describe(state), '判据：会话内最后一条对话结束（turn/end）；只是被打开/恢复过不算活动，读不到事件时退回文件写入时间', '']
  lines.push('当前候选（超期且未受保护）：' + candidates.length + ' 个')
  for (const c of candidates.slice(0, 30)) {
    lines.push('  - ' + c.id.slice(8, 16) + '  最后对话 ' + stamp(c.last) + '（' + ago(c.last, now) + '）')
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
            candidates: candidates.map((c) => ({ id: c.id, mtime: c.last })),
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
  // 工具注册失败（重名、DSH 升级后格式漂移）不该拖垮路由与兜底定时：
  // 单独圈起来，失败只留一行警告，归档主功能照常。
  try {
    ctx.tools.register({
      name: 'dsh-session-autarchive',
      description: '超期会话自动归档的开关台：status 看配置、保护名单与当前候选；run 立刻归档候选；protect/unprotect 标记单个会话「不自动归档」；config 改阈值与开关。判定口径＝会话内最后一条对话结束事件（turn/end）的时间——只是被打开/恢复过（会追写开场提示）不算活动；读不到事件时退回文件最后写入时间。已归档、保护名单内、置顶（可关）都跳过。浏览器半边每 5 分钟按同一份清单自动执行，侧栏右键菜单的「不自动归档」也写这份名单。',
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
            for (const c of result.candidates) lines.push('  · ' + c.id.slice(8, 16) + '  最后对话 ' + stamp(c.last))
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
  } catch (error) {
    console.warn('[dsh-session-autarchive] 工具未注册：' + (error && error.message ? error.message : error))
  }

  registerRoutes(ctx)

  // 宿主侧兜底：浏览器窗口没开着也照常归档（客户端那条是让侧栏当场刷新的快通道）。
  // 启动 60 秒后第一次（避开启动竞争），之后每 10 分钟。
  // 开关每次现读：关掉自动归档后这条定时链要立刻停，不能等重启。
  // 手动执行（工具／路由的 run）不在这里拦，那是用户主动点的，开关只管自动。
  const tick = () => {
    const state = readState()
    if (!state.enabled) return
    void runArchive(ctx, state, false).catch(() => { /* 这轮不行，下一轮再来 */ })
  }
  const first = setTimeout(tick, 60 * 1000)
  const timer = setInterval(tick, 10 * 60 * 1000)
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => { clearTimeout(first); clearInterval(timer) })
  }
}
