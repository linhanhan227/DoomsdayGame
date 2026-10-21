/**
 * 一键部署到 Bonto（bonto.dev）
 * ------------------------------------------------------------------
 * 用法：
 *   npm run deploy:bonto -- --subdomain ashes-remain
 *   npm run deploy:bonto -- --subdomain ashes-remain --name ashes-remain --dry-run
 *
 * 前置：本机装好 Node 18+，并已登录一次
 *   npx @sidequestvr/bonto auth login
 *
 * 流程：构建 dist → 生成 bonto/ 部署包 → 建应用（若不存在）→ 上传文件 → 平台自动部署。
 *
 * 两个刻意的设计：
 *   · package.json **最后上传**。平台是"写文件即部署"，先传它会用缺 server.js 的
 *     残缺状态起一次容器，日志里刷一轮崩溃，白等十几秒。
 *   · 大文件用 files upload 而不是 files write --content：1.2MB 的主包塞进命令行参数
 *     在 Windows 上会直接超长失败。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BUNDLE = join(ROOT, 'bonto')
const isWin = process.platform === 'win32'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      out[key] = next
      i++
    } else {
      out[key] = true
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const subdomain = String(args.subdomain || 'ashes-remain').toLowerCase()
// 应用显示名只走 ASCII：Windows 上 shell 转发非 ASCII 参数会按本地代码页编码，中文会变乱码
const appName = String(args.name || subdomain)
const dryRun = Boolean(args['dry-run'])
const skipBuild = Boolean(args['skip-build'])

if (!/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(subdomain)) {
  console.error(`✗ 子域名不合法：${subdomain}（只允许小写字母、数字、连字符，2–32 位）`)
  process.exit(1)
}

function run(cmd, argv, { capture = false } = {}) {
  const r = spawnSync(cmd, argv, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: isWin, // Windows 上 npx 是 .cmd，必须走 shell 才能解析
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
  if (r.error) throw r.error
  return r
}

function bonto(argv) {
  return run('npx', ['--yes', '@sidequestvr/bonto', ...argv, '--json'], { capture: true })
}

/** CLI 的 --json 输出里可能混进提示行，尽量把 JSON 主体抠出来 */
function parseJson(text) {
  const s = String(text || '').trim()
  try {
    return JSON.parse(s)
  } catch {
    const start = s.search(/[[{]/)
    const end = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'))
    if (start === -1 || end <= start) return null
    try {
      return JSON.parse(s.slice(start, end + 1))
    } catch {
      return null
    }
  }
}

function toArray(json) {
  if (Array.isArray(json)) return json
  for (const k of ['apps', 'data', 'items', 'results']) {
    if (Array.isArray(json?.[k])) return json[k]
  }
  return []
}

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

/* ---------------- 1. 构建 ---------------- */

if (dryRun) {
  console.log('· [dry-run] 跳过构建，仅打印将要执行的动作')
} else if (!skipBuild) {
  console.log('▸ 构建 dist/ …')
  const r = run(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'build'])
  if (r.status !== 0) process.exit(r.status || 1)
}

if (!dryRun) {
  console.log('▸ 生成 bonto/ 部署包 …')
  const r = run(process.execPath, [join(ROOT, 'scripts/build-bonto.mjs')])
  if (r.status !== 0) process.exit(r.status || 1)
}

if (!existsSync(join(BUNDLE, 'package.json'))) {
  console.error('✗ 缺少 bonto/package.json，先跑一次 npm run build:bonto')
  process.exit(1)
}

/* ---------------- 2. 认证检查 ---------------- */

if (dryRun) {
  console.log(`· [dry-run] npx @sidequestvr/bonto whoami`)
} else {
  const who = bonto(['whoami'])
  if (who.status !== 0) {
    console.error('✗ 未登录 Bonto。先执行：\n    npx @sidequestvr/bonto auth login')
    console.error(String(who.stderr || who.stdout || '').trim())
    process.exit(1)
  }
  console.log('✓ 已登录 Bonto')
}

/* ---------------- 3. 应用 ---------------- */

let appRef = subdomain
if (dryRun) {
  console.log(`· [dry-run] npx @sidequestvr/bonto apps list`)
  console.log(`· [dry-run] 若无 ${subdomain}：npx @sidequestvr/bonto apps create ${appName} ${subdomain}`)
} else {
  const list = bonto(['apps', 'list'])
  const apps = toArray(parseJson(list.stdout))
  const found = apps.find((a) => [a.subdomain, a.slug, a.name].filter(Boolean).some((v) => String(v) === subdomain))
  if (found) {
    appRef = found.subdomain || found.slug || subdomain
    console.log(`✓ 应用已存在：${appRef}`)
  } else {
    console.log(`▸ 创建应用 ${subdomain} …`)
    const made = bonto(['apps', 'create', appName, subdomain])
    if (made.status !== 0) {
      console.error('✗ 创建失败：' + String(made.stderr || made.stdout || '').trim())
      process.exit(1)
    }
    console.log(`✓ 已创建：${subdomain}`)
  }
}

/* ---------------- 4. 上传 ---------------- */

const files = walk(BUNDLE)
// package.json 最后传，避免用残缺状态触发一次部署
files.sort((a, b) => {
  const w = (f) => (f.endsWith('package.json') ? 1 : 0)
  return w(a) - w(b)
})

console.log(`▸ 上传 ${files.length} 个文件 …`)
for (const full of files) {
  const remote = relative(BUNDLE, full).split('\\').join('/')
  if (dryRun) {
    console.log(`  · [dry-run] files upload ${appRef} ${remote} <本地同名文件>`)
    continue
  }
  const r = bonto(['files', 'upload', appRef, remote, full])
  if (r.status !== 0) {
    console.error(`✗ 上传失败：${remote}\n${String(r.stderr || r.stdout || '').trim()}`)
    process.exit(1)
  }
  console.log(`  ✓ ${remote}`)
}

console.log('')
console.log(`完成。线上地址：https://${subdomain}.bonto.run`)
console.log('首次部署后容器要十几秒才起得来，看日志：')
console.log(`  npx @sidequestvr/bonto logs ${subdomain} --tail 50`)
