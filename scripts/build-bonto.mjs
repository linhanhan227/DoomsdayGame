/**
 * 生成 Bonto 部署包（bonto/）
 * ------------------------------------------------------------------
 * 为什么不让平台直接跑仓库根目录：
 *   1) 根 package.json 带 vite / rollup 等 devDependencies。平台在 512M 容器里
 *      跑一次 `npm install` 既慢又可能 OOM，而我们**根本不需要**它——产物已经构建好了。
 *   2) 根目录还有 web/、scripts/、node_modules 等一堆运行时用不到的东西，
 *      上传和文件监听都会被拖累。
 *
 * 所以这里裁出一个自包含目录：server.js + public/（构建产物）+ 一份**零依赖**的
 * package.json。平台上 `npm install` 无事可做，`npm start` 直接起服务。
 *
 * 产物 bonto/ 是生成物，不进版本库（见 .gitignore）。
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT = join(ROOT, 'bonto')
const DIST = join(ROOT, 'dist')

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('✗ 找不到 dist/index.html。先执行 npm run build（或 npm run build:host）。')
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

rmSync(OUT, { recursive: true, force: true })
mkdirSync(join(OUT, 'public'), { recursive: true })

// 逐文件复制而不是 cpSync：字节完全一致、跨平台行为稳定，
// 且顺便得到"到底传了哪些文件"的清单（部署脚本要按同一份清单上传）。
for (const src of walk(DIST)) {
  const dest = join(OUT, 'public', relative(DIST, src))
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(src, dest)
}
copyFileSync(join(ROOT, 'server.js'), join(OUT, 'server.js'))

// 零依赖清单：平台的 npm install 会瞬间返回，不会拖慢冷启动
const manifest = {
  name: pkg.name,
  version: pkg.version,
  private: true,
  type: 'module',
  description: pkg.description,
  engines: { node: '>=18' },
  scripts: { start: 'node server.js' },
}
writeFileSync(join(OUT, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')

const files = walk(OUT)
const total = files.reduce((n, f) => n + statSync(f).size, 0)
console.log(`✓ 部署包已生成：${relative(ROOT, OUT)}/  （${files.length} 个文件，${(total / 1048576).toFixed(2)} MB）`)
for (const f of files) console.log(`  · ${relative(OUT, f).split('\\').join('/')}`)
