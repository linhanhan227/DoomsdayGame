/**
 * check-wasm.mjs —— sql.js 与内联 wasm 版本一致性校验
 * ------------------------------------------------------------------
 * 构建时 vite 插件把 node_modules/sql.js 的 sql-wasm.wasm 以 base64 内联进主包
 * （virtual:sql-wasm-base64）。一旦手动升级 sql.js 却忘了重新构建（或构建缓存命中），
 * 就会出现"引擎版本与内联 wasm 不匹配"的隐蔽故障。
 *
 * 本脚本在构建后运行：把 node_modules 里的真实 wasm 转成 base64，校验 dist（与可选的
 * dist-standalone）产物中确实包含了这段 base64。不一致则非零退出，便于 CI / pre-commit 拦截。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('..', import.meta.url))

const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm')
// sql.js 的 exports 禁止解析 package.json 子路径，故用文件系统直接读取版本
const pkgPath = resolve(dirname(wasmPath), '..', 'package.json')
const sqljsVersion = JSON.parse(readFileSync(pkgPath, 'utf8')).version
const wasm = readFileSync(wasmPath)
const expectedBase64 = wasm.toString('base64')
const expectedSha = createHash('sha256').update(wasm).digest('hex')

let failed = false

for (const outDir of ['dist', 'dist-standalone']) {
  const dir = `${root}/${outDir}`
  if (!existsSync(dir)) continue
  // 多文件版：wasm 内联在 assets/index-*.js；单文件版：内联进 index.html
  const assetsDir = `${dir}/assets`
  let code = null
  let label = null
  if (existsSync(assetsDir)) {
    const jsFile = readdirSync(assetsDir).find((f) => /^index-.*\.js$/.test(f))
    if (jsFile) {
      code = readFileSync(`${assetsDir}/${jsFile}`, 'utf8')
      label = jsFile
    }
  }
  if (code === null && existsSync(`${dir}/index.html`)) {
    code = readFileSync(`${dir}/index.html`, 'utf8')
    label = 'index.html'
  }
  if (code === null) {
    console.error(`✗ [${outDir}] 未找到 index-*.js 或 index.html，请先构建`)
    failed = true
    continue
  }
  if (code.includes(expectedBase64)) {
    console.log(`✓ [${outDir}] 内联 wasm 与 sql.js@${sqljsVersion} 一致 (${label}, sha256 ${expectedSha.slice(0, 16)}…)`)
  } else {
    console.error(`✗ [${outDir}] 内联 wasm 与 node_modules/sql.js@${sqljsVersion} 的 wasm 不一致`)
    console.error(`  请重新运行构建（npm run build），确保 vite 重新内联最新 wasm。`)
    failed = true
  }
}

process.exit(failed ? 1 : 0)
