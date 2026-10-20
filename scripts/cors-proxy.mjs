/**
 * 静态站点的 CORS 反代。
 * ------------------------------------------------------------------
 * HTML/JS/CSS 仍从 dist/ 按文件发出。只有 /api/cors?url= 会转发到上游。
 * 双击打开的 HTML 没有这个进程，到不了这条路径。
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(process.env.STATIC_ROOT || fileURLToPath(new URL('../dist/', import.meta.url)))
const PORT = Number(process.env.PORT || 4173)
const HOST = process.env.HOST || '127.0.0.1'

const HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade', 'host', 'content-length',
])

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

async function proxy(req, res, targetUrl) {
  let target
  try {
    target = new URL(targetUrl)
  } catch {
    send(res, 400, '需要 ?url=http(s)://...')
    return
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    send(res, 400, '只转发 http 与 https')
    return
  }
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = Buffer.concat(chunks)
  const headers = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP.has(k) || k.startsWith('access-control-') || k === 'origin' || k === 'referer') continue
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
    send(res, upstream.status, bytes, type)
  } catch (err) {
    send(res, 502, `转发失败：${err.message}`)
  }
}

function filePath(urlPath) {
  const raw = decodeURIComponent(urlPath.split('?')[0])
  const rel = normalize(raw).replace(/^(\.\.(\/|\\|$))+/, '')
  const full = join(ROOT, rel)
  if (!full.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep) && full !== ROOT) return null
  return full
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  if (url.pathname === '/api/cors') {
    if (req.method === 'OPTIONS') {
      send(res, 204, '')
      return
    }
    await proxy(req, res, url.searchParams.get('url') || '')
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, '只接受 GET')
    return
  }
  let full = filePath(url.pathname)
  if (!full) {
    send(res, 403, '路径越界')
    return
  }
  if (existsSync(full) && statSync(full).isDirectory()) full = join(full, 'index.html')
  if (!existsSync(full) || !statSync(full).isFile()) {
    send(res, 404, '没有这个文件')
    return
  }
  const type = TYPES[extname(full).toLowerCase()] || 'application/octet-stream'
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': extname(full) === '.html' ? 'no-cache' : 'public, max-age=31536000',
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(full).pipe(res)
})

server.listen(PORT, HOST, () => {
  console.log(`静态站点 + CORS 反代  http://${HOST}:${PORT}`)
  console.log(`页面目录  ${ROOT}`)
  console.log('反代路径  /api/cors?url=')
})
