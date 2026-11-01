#!/usr/bin/env node
/**
 * 本机冒烟：不起应用、不发网络请求、不碰真实会话数据。
 *
 * 六关：
 *   1. 包结构      —— files 声明的必需文件都在（含已提交的 lib/client.js）
 *   2. 组合声明    —— dsh.bundle.patch 指向的文件在，且里面的 insert id 等于包名
 *   3. 宿主半边    —— 桩 ctx 跑 apply：注册 1 个工具、4 条路由，路径与包名一致
 *   4. 路由鉴权    —— 非回环 403、非 POST 405、坏会话 id 400
 *   5. 状态读写    —— 指向临时 DSH_HOME：改天数、加名单后回读一致
 *   6. 客户端产物  —— 外壳 id == 包名，产物里带上了路由与四个 slot 名
 *
 * 用法：node scripts/smoke.mjs   （任一条失败退出码 1）
 *
 * ⚠️ 全程使用临时 DSH_HOME，跑完删掉；不会读到或改到你自己的会话数据。
 */

import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const problems = []

const ok = (label, extra = '') => console.log('ok   ' + label + (extra ? '  ' + extra : ''))
const fail = (label, why) => {
  problems.push(label + ': ' + why)
  console.log('FAIL ' + label + '  ' + why)
}

/** 1. 包结构 */
const REQUIRED = [
  'index.js',
  'invariant.js',
  'cordis.patch.yml',
  'src/entry.jsx',
  'lib/client.js',
  'README.md',
  'README.en.md',
  'LICENSE',
]
const missing = REQUIRED.filter((rel) => !existsSync(join(root, rel)))
if (missing.length > 0) fail('结构', '缺 ' + missing.join('、'))
else ok('结构', REQUIRED.length + ' 个必需文件齐全')

/** 2. 组合声明：dsh plugin add 靠这一条把包接进层栈 */
const patchRel = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch
if (!patchRel) fail('组合声明', 'package.json 没声明 dsh.bundle.patch')
else if (!existsSync(join(root, patchRel))) fail('组合声明', 'dsh.bundle.patch 指向的文件不存在：' + patchRel)
else {
  const patch = readFileSync(join(root, patchRel), 'utf8')
  if (!patch.includes('id: ' + pkg.name)) fail('组合声明', patchRel + ' 里没有 id: ' + pkg.name)
  else ok('组合声明', 'dsh.bundle.patch → ' + patchRel + '（id = ' + pkg.name + '）')
}
if (!pkg.exports || pkg.exports['./client'] !== './lib/client.js') fail('组合声明', 'exports["./client"] 应指向 ./lib/client.js')

/** 临时 DSH_HOME：宿主半边的读写全落在这里 */
const home = mkdtempSync(join(tmpdir(), 'dsh-session-autarchive-smoke-'))
process.env.DSH_HOME = home

/** 3. 宿主半边：桩 ctx 跑 apply */
const mod = await import(pathToFileURL(join(root, 'index.js')).href)
if (mod.name !== pkg.name) fail('宿主半边', 'index.js 导出的 name 是 ' + mod.name + '，不等于包名 ' + pkg.name)
else ok('宿主半边', 'name = ' + mod.name)

const tools = []
const routes = []
const cleanups = []
const webServer = {
  port: 0,
  register(route) {
    routes.push(route)
    return () => {}
  },
}
const ctx = {
  tools: {
    register(tool) {
      tools.push(tool)
    },
  },
  get(name) {
    if (name === 'webServer') return webServer
    return undefined
  },
  effect(fn) {
    const cleanup = fn()
    if (typeof cleanup === 'function') cleanups.push(cleanup)
  },
}

try {
  mod.apply(ctx)
} catch (error) {
  fail('宿主半边', 'apply 抛错：' + error.message)
}

const PREFIX = '/' + pkg.name + '/api'
const wanted = [PREFIX + '/state', PREFIX + '/protect', PREFIX + '/config', PREFIX + '/run']
if (tools.length !== 1) fail('宿主半边', '应注册 1 个工具，实际 ' + tools.length)
else if (tools[0].name !== pkg.name) fail('宿主半边', '工具名是 ' + tools[0].name + '，应等于包名 ' + pkg.name)
if (routes.length !== wanted.length) fail('宿主半边', '应注册 ' + wanted.length + ' 条路由，实际 ' + routes.length)
for (const path of wanted) {
  const found = routes.find((route) => route.path === path)
  if (!found) fail('宿主半边', '缺路由 ' + path)
  else if (found.kind !== 'exact') fail('宿主半边', path + ' 的 kind 是 ' + found.kind + '，应为 exact')
}
if (routes.length === wanted.length && wanted.every((path) => routes.some((route) => route.path === path))) {
  ok('宿主半边', '工具 1 个、路由 ' + wanted.length + ' 条（前缀 ' + PREFIX + '）')
}

/** 路由调用器：假 req/res，按 readBody 的事件流喂 body */
const { EventEmitter } = await import('node:events')

function call(route, { method = 'GET', remoteAddress = '127.0.0.1', body } = {}) {
  return new Promise((resolve) => {
    const req = new EventEmitter()
    req.method = method
    req.socket = { remoteAddress }
    req.destroy = () => {}
    const res = {
      status: 0,
      body: '',
      writeHead(code) {
        res.status = code
      },
      end(value) {
        res.body = String(value ?? '')
        resolve(res)
      },
    }
    route.handler(req, res)
    setImmediate(() => {
      if (body !== undefined) req.emit('data', typeof body === 'string' ? body : JSON.stringify(body))
      req.emit('end')
    })
  })
}

const routeOf = (suffix) => routes.find((route) => route.path === PREFIX + suffix)

/** 4. 路由鉴权 */
if (routes.length === wanted.length) {
  const cases = [
    { label: '非回环地址被拒', route: routeOf('/protect'), opts: { method: 'POST', remoteAddress: '10.1.2.3', body: {} }, want: 403 },
    { label: 'GET 打 protect 被拒', route: routeOf('/protect'), opts: { method: 'GET' }, want: 405 },
    { label: 'GET 打 run 被拒', route: routeOf('/run'), opts: { method: 'GET' }, want: 405 },
    { label: '坏会话 id 被拒', route: routeOf('/protect'), opts: { method: 'POST', body: { sessionId: 'not-a-session' } }, want: 400 },
    { label: '越界天数被拒', route: routeOf('/config'), opts: { method: 'POST', body: { days: 0 } }, want: 400 },
    { label: '::1 被认作本机', route: routeOf('/state'), opts: { method: 'GET', remoteAddress: '::1' }, want: 200 },
  ]
  let passed = 0
  for (const item of cases) {
    const res = await call(item.route, item.opts)
    if (res.status !== item.want) fail('路由鉴权', item.label + '：返回 ' + res.status + '，应为 ' + item.want)
    else passed += 1
  }
  if (passed === cases.length) ok('路由鉴权', passed + ' 条全部符合')
}

/** 5. 状态读写：全落在临时 DSH_HOME */
if (routes.length === wanted.length) {
  const sessionId = 'session-smoke-0000'
  const protectedRes = await call(routeOf('/protect'), { method: 'POST', body: { sessionId, protected: true } })
  const configRes = await call(routeOf('/config'), { method: 'POST', body: { days: 7 } })
  const stateRes = await call(routeOf('/state'), { method: 'GET' })
  const state = JSON.parse(stateRes.body || '{}')
  if (protectedRes.status !== 200) fail('状态读写', 'protect 返回 ' + protectedRes.status)
  else if (configRes.status !== 200) fail('状态读写', 'config 返回 ' + configRes.status)
  else if (state.days !== 7) fail('状态读写', '回读天数 ' + state.days + '，应为 7')
  else if (!Array.isArray(state.protected) || !state.protected.includes(sessionId)) fail('状态读写', '回读名单里没有刚加进去的会话')
  else if (!existsSync(join(home, 'session-autarchive', 'state.json'))) fail('状态读写', '状态文件没写进临时 DSH_HOME')
  else if (!existsSync(join(home, 'session-autarchive', 'protected.json'))) fail('状态读写', '保护名单没写进临时 DSH_HOME')
  else if (!existsSync(join(home, 'session-autarchive', 'audit.log'))) fail('状态读写', '审计文件没写进临时 DSH_HOME')
  else ok('状态读写', '天数、名单、审计都落在临时 DSH_HOME')

  const tool = tools[0]
  if (tool) {
    const result = await tool.execute({ action: 'status' })
    if (!result || result.ok !== true || !/自动归档/.test(result.text)) fail('工具', 'status 没有回可读状态')
    else ok('工具', 'status 返回 ' + result.text.split('\n').length + ' 行')
  }
}

/** 6. 客户端产物 */
const client = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
const idMatch = /^\s*id:\s*"([^"]+)"/m.exec(client)
const SLOTS = [
  'sidebar.workspaces.session.menu.item',
  'sidebar.session.row.leading',
  'sidebar.session.row.hover',
  'settings.general.item',
]
if (!idMatch) fail('客户端产物', '外壳里找不到 id')
else if (idMatch[1] !== pkg.name) fail('客户端产物', '外壳 id 是 ' + idMatch[1] + '，应等于包名 ' + pkg.name)
else if (!client.includes(pkg.name + '/api')) fail('客户端产物', '产物里没有路由前缀（源码改了但没重新构建）')
else {
  const absent = SLOTS.filter((slot) => !client.includes(slot))
  if (absent.length > 0) fail('客户端产物', '产物里缺 slot：' + absent.join('、'))
  else ok('客户端产物', 'id=' + pkg.name + '，' + Buffer.byteLength(client, 'utf8') + ' 字节')
}

/** 收尾：清掉宿主半边的定时器与临时目录 */
for (const cleanup of cleanups) {
  try {
    cleanup()
  } catch {
    /* 已清理过 */
  }
}
try {
  rmSync(home, { recursive: true, force: true })
} catch {
  /* 临时目录删不掉不影响结果 */
}

console.log('')
if (problems.length > 0) {
  console.error('冒烟失败 ' + problems.length + ' 项')
  process.exit(1)
}
console.log('冒烟通过')
process.exit(0)
