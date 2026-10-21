/**
 * 静态托管 + 同源 CORS 反代（零依赖）
 * ------------------------------------------------------------------
 * 这个文件是**平台入口**，专门为 Bonto（bonto.dev）这类"给一个容器、注入 PORT、
 * 由平台反向代理到公网域名"的托管方式准备。本地 `npm start` / `npm run serve`
 * 用的也是它，所以线上和本地跑的是同一套逻辑，不存在"本地好线上崩"的差异。
 *
 * 三个必须遵守的平台约定（写死在这里，不要再改回去）：
 *   1) 端口从 `process.env.PORT` 取，缺省 3000 —— 平台注入的端口不一定是谁；
 *   2) 必须绑 `0.0.0.0` —— 绑 127.0.0.1 时容器外的反代连不进来，表现为平台一直
 *      报"健康检查失败"或 502，而容器日志里一切正常（最容易误判的一类故障）；
 *   3) 启动要快、要有 /healthz —— 平台健康检查和冷启动唤醒都先打这个路径。
 *
 * 为什么保留 /api/cors：浏览器直连模型服务商要求上游返回 CORS 头，而部分服务商
 * （尤其自建网关、本地模型）不返回。放在同一个源上转发，浏览器就不需要 CORS 了。
 * 代价是 API Key 会经过本服务进程，所以**只在玩家自己部署的实例上才划算**。
 *
 * 静态目录按顺序探测，取第一个含 index.html 的：
 *   STATIC_ROOT → dist/（本地构建产物）→ public/（Bonto 部署包）→ dist-standalone/ → 当前目录
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGzip } from 'node:zlib'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PORT = Number(process.env.PORT || 3000)
// 平台容器里必须 0.0.0.0；本地想只给本机用时可以 HOST=127.0.0.1
const HOST = process.env.HOST || '0.0.0.0'

/** 逐级探测静态根目录：谁的 index.html 先命中就用谁 */
function pickRoot() {
  const candidates = [process.env.STATIC_ROOT, 'dist', 'public', 'dist-standalone', '.']
  for (const c of candidates) {
    if (!c) continue
    const abs = resolve(HERE, c)
    if (existsSync(join(abs, 'index.html'))) return abs
  }
  return resolve(HERE, 'dist')
}

const ROOT = pickRoot()

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.sqlite': 'application/x-sqlite3',
}

/** 值得 gzip 的类型。主包 1.2MB，不压的话首屏流量是压缩后的两倍多 */
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.map', '.svg', '.txt'])

/** 反代时要剥掉的逐跳头 + 会暴露来源的头（上游可能据此拒绝或改写响应） */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade', 'host', 'content-length',
])

/**
 * 私有网段黑名单。
 * 公网实例上如果不拦，任何人都能拿这个接口去打内网 / 云元数据（169.254.169.254），
 * 属于典型的 SSRF 入口。本地调试本地 Ollama 时用 ALLOW_PRIVATE_TARGETS=1 放开。
 */
const PRIVATE_HOST =
  /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]|\[fd|\[fe80)/i
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE_TARGETS === '1'

/**
 * 静态根里连 index.html 都没有时返回的说明页。
 * 这是部署链路的问题（产物没跟上来），不是访问路径的问题；
 * 只回一句「没有这个文件」会让人去查路由，白绕一大圈。
 */
function deployHintPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>构建产物未部署</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#14110f;color:#e8e0d4;
       font:15px/1.75 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
  main{max-width:640px;padding:32px 28px}
  h1{margin:0 0 16px;font-size:20px;letter-spacing:.02em;color:#f0b429}
  code{background:#241f1b;padding:2px 6px;border-radius:4px;font-size:13px;color:#f7d488}
  pre{background:#241f1b;padding:14px 16px;border-radius:8px;overflow:auto;font-size:13px}
  p{margin:0 0 12px}
  .dim{color:#9a8f80;font-size:13px}
</style></head><body><main>
<h1>服务已启动，但静态目录里没有页面</h1>
<p><code>server.js</code> 正在正常运行，只是它的静态根目录里找不到 <code>index.html</code>。</p>
<p>当前静态根：<code>${ROOT}</code></p>
<p>最常见的原因：<strong>构建产物没有随代码一起部署</strong>。本项目的部署模型是
「从仓库拉代码 → 直接 <code>npm start</code>」，平台侧不会执行 <code>vite build</code>，
所以 <code>dist/</code> 必须在仓库里。</p>
<p>修复：</p>
<pre>npm run build          # 生成 dist/
git add dist           # 构建产物必须入库
git commit -m "构建产物入库" && git push</pre>
<p class="dim">如果你是在本机跑：确认已执行过 <code>npm run build</code>，或改用
<code>npm run build:bonto</code> 生成自带 public/ 的部署包。</p>
</main></body></html>`
}

function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    ...extra,
  })
  res.end(body)
}

/** 把 URL 路径安全地映射到 ROOT 下的绝对路径；越界返回 null */
function filePath(urlPath) {
  let raw
  try {
    raw = decodeURIComponent(urlPath.split('?')[0])
  } catch {
    return null // 非法百分号编码
  }
  const rel = normalize(raw).replace(/^(\.\.(\/|\\|$))+/, '')
  const full = join(ROOT, rel)
  const prefix = ROOT.endsWith(sep) ? ROOT : ROOT + sep
  if (full !== ROOT && !full.startsWith(prefix)) return null
  return full
}

async function proxy(req, res, targetUrl) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || '*',
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors)
    res.end()
    return
  }

  let target
  try {
    target = new URL(targetUrl)
  } catch {
    send(res, 400, '需要 ?url=http(s)://...', undefined, cors)
    return
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    send(res, 400, '只转发 http 与 https', undefined, cors)
    return
  }
  if (!ALLOW_PRIVATE && PRIVATE_HOST.test(target.hostname)) {
    send(res, 403, '出于安全考虑，不转发到内网 / 本机地址（自用可设 ALLOW_PRIVATE_TARGETS=1）', undefined, cors)
    return
  }

  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = Buffer.concat(chunks)

  const headers = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(k) || k.startsWith('access-control-') || k === 'origin' || k === 'referer') continue
    if (v != null) headers[k] = Array.isArray(v) ? v.join(', ') : v
  }

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
      redirect: 'follow',
    })
    const type = upstream.headers.get('content-type') || 'application/octet-stream'
    const bytes = Buffer.from(await upstream.arrayBuffer())
    res.writeHead(upstream.status, {
      ...cors,
      'Content-Type': type,
      'Content-Length': bytes.length,
      'Cache-Control': 'no-store',
    })
    res.end(bytes)
  } catch (err) {
    // undici 的 "fetch failed" 本身不带原因，真正的原因在 cause 里（DNS / 拒绝连接 / TLS）
    const cause = err.cause?.message || err.cause?.code || ''
    send(res, 502, `转发失败：${err.message}${cause ? `（${cause}）` : ''}`, undefined, cors)
  }
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, '只接受 GET / HEAD')
    return
  }

  let full = filePath(pathname)
  if (!full) {
    send(res, 403, '路径越界')
    return
  }
  if (existsSync(full) && statSync(full).isDirectory()) full = join(full, 'index.html')

  // SPA 回退：没有扩展名又找不到文件的路径一律交给 index.html，
  // 免得刷新深链接时被平台判成 404。
  if (!existsSync(full) || !statSync(full).isFile()) {
    if (!extname(pathname)) {
      full = join(ROOT, 'index.html')
    }
    if (!existsSync(full) || !statSync(full).isFile()) {
      // 连 index.html 都没有 → 产物没部署上来，给可诊断的说明页而不是四个字
      if (!existsSync(join(ROOT, 'index.html'))) {
        send(res, 503, deployHintPage(), 'text/html; charset=utf-8')
        return
      }
      send(res, 404, '没有这个文件')
      return
    }
  }

  const ext = extname(full).toLowerCase()
  const type = MIME[ext] || 'application/octet-stream'
  // Vite 产物文件名带内容哈希，可以放心长缓存；HTML 必须每次回源，否则新版发不出去
  const cache = ext === '.html' ? 'no-cache' : pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600'

  const acceptsGzip = String(req.headers['accept-encoding'] || '').includes('gzip')
  if (COMPRESSIBLE.has(ext) && acceptsGzip) {
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': cache,
      'Content-Encoding': 'gzip',
      Vary: 'Accept-Encoding',
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(full).pipe(createGzip()).pipe(res)
    return
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': cache,
    'Content-Length': statSync(full).size,
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(full).pipe(res)
}

const server = createServer(async (req, res) => {
  let url
  try {
    url = new URL(req.url || '/', 'http://127.0.0.1')
  } catch {
    send(res, 400, '非法请求')
    return
  }
  const { pathname } = url

  // 平台健康检查 + 前端探测同源反代是否可用（llm.js 的 hasSameOriginProxy）
  if (pathname === '/healthz' || pathname === '/api/health') {
    // hasIndex 让"部署成功但打开 404"能在一条 curl 里定位：false 就是产物没上来。
    // 注意 ok 始终为 true —— 平台的健康检查看的是进程活着，产物缺失不该触发重启循环。
    send(
      res,
      200,
      JSON.stringify({
        ok: true,
        corsProxy: true,
        hasIndex: existsSync(join(ROOT, 'index.html')),
        uptime: Math.round(process.uptime()),
      }),
      'application/json; charset=utf-8',
    )
    return
  }

  if (pathname === '/api/cors') {
    await proxy(req, res, url.searchParams.get('url') || '')
    return
  }

  serveStatic(req, res, pathname)
})

server.listen(PORT, HOST, () => {
  console.log(`[ashes-remain] listening on http://${HOST}:${PORT}`)
  console.log(`[ashes-remain] static root: ${ROOT}`)
  console.log('[ashes-remain] proxy: /api/cors?url=  health: /healthz')
  // 忘了构建是最常见的一种"部署成功但打开 404"
  if (!existsSync(join(ROOT, 'index.html'))) {
    console.warn('[ashes-remain] ⚠ 静态目录里没有 index.html，先执行 npm run build（部署包用 npm run build:bonto）')
  }
})

// 平台滚动更新会先发 SIGTERM，给它两秒把手上的请求收干净，避免连接被硬切
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000)
  })
}
