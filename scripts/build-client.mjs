#!/usr/bin/env node
/**
 * 构建浏览器半边：src/entry.jsx → lib/client.js
 *
 * 客户端模块表按「入口名 == 包名」索引，所以产物必须套上 DSH 的模块外壳：
 *   window.__ModuleLoader__.load({ id: <package.json 的 name>, factory })
 * 外壳里的 id 与包名对不上，界面就静默不加载。
 *
 * 用法：
 *   node scripts/build-client.mjs           重新生成 lib/client.js
 *   node scripts/build-client.mjs --check   只比对新产物与已提交产物，不一致即退出码 1
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const entry = join(root, 'src', 'entry.jsx')
const out = join(root, 'lib', 'client.js')
const check = process.argv.includes('--check')

if (!existsSync(entry)) {
  console.error('找不到浏览器半边源码：' + entry)
  process.exit(2)
}

const bundled = await build({
  entryPoints: [entry],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  jsx: 'automatic',
  target: ['chrome120'],
  // react 由 DSH 客户端模块表提供，不能打进产物
  external: ['react', 'react/jsx-runtime'],
  write: false,
  logLevel: 'warning',
  legalComments: 'none',
})

const code = bundled.outputFiles[0].text.replace(/\s*\/\/# sourceMappingURL=.*$/m, '')
const envelope = 'window.__ModuleLoader__.load({\n'
  + '\tid: ' + JSON.stringify(pkg.name) + ',\n'
  + '\tfactory: (require) => {\n'
  + '\t\tvar module = { exports: {} };\n'
  + '\t\tvar exports = module.exports;\n'
  + '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });\n'
  + code
  + '\n\t\treturn module.exports;\n'
  + '\t}\n'
  + '});\n'

// 语法自检：只解析不执行（new Function 不跑函数体）
try {
  // eslint-disable-next-line no-new-func
  new Function(envelope)
} catch (error) {
  console.error('产物语法检查失败：' + error.message)
  process.exit(1)
}

if (check) {
  if (!existsSync(out)) {
    console.error('缺少已提交的产物：' + out + '（先跑 node scripts/build-client.mjs）')
    process.exit(1)
  }
  if (readFileSync(out, 'utf8') !== envelope) {
    console.error('lib/client.js 与 src/entry.jsx 不一致：先跑 node scripts/build-client.mjs 再提交')
    process.exit(1)
  }
  console.log('ok  lib/client.js 与源码一致（' + Buffer.byteLength(envelope, 'utf8') + ' 字节）')
  process.exit(0)
}

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, envelope, 'utf8')
console.log('ok  已写出 ' + out + '（' + Buffer.byteLength(envelope, 'utf8') + ' 字节，id=' + pkg.name + '）')
