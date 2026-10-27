import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

/**
 * 本地 CORS 代理：POST /api/cors?url=<上游地址>
 * ------------------------------------------------------------------
 * 浏览器把方法、请求头、请求体原样交给这个接口，接口再转发给 url。
 * 响应补上 Access-Control-Allow-Origin，所以不依赖上游自己开 CORS。
 * 只接受 http/https，避免被拿去打本机其它端口。
 */
function localCorsApi() {
  const hopByHop = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailers', 'transfer-encoding', 'upgrade', 'host', 'content-length',
  ])
  const handler = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || '*')
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }
    let target
    try {
      const reqUrl = new URL(req.url || '', 'http://127.0.0.1')
      target = new URL(reqUrl.searchParams.get('url') || '')
    } catch {
      res.statusCode = 400
      res.end('本地 CORS 接口需要 ?url=http(s)://...')
      return
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      res.statusCode = 400
      res.end('只转发 http 与 https')
      return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    const headers = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (hopByHop.has(k) || k.startsWith('access-control-') || k === 'origin' || k === 'referer') continue
      if (v != null) headers[k] = Array.isArray(v) ? v.join(', ') : v
    }
    try {
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
        redirect: 'follow',
      })
      res.statusCode = upstream.status
      const type = upstream.headers.get('content-type')
      if (type) res.setHeader('Content-Type', type)
      res.end(Buffer.from(await upstream.arrayBuffer()))
    } catch (err) {
      res.statusCode = 502
      res.end(`本地 CORS 接口转发失败：${err.message}`)
    }
  }
  const attach = (server) => {
    server.middlewares.use('/api/cors', handler)
    // 与生产 server.js 保持同一契约：前端用它判断"本站是否带同源反代"（llm.js 的 hasSameOriginProxy）
    server.middlewares.use('/api/health', (req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.end(JSON.stringify({ ok: true, corsProxy: true, dev: true }))
    })
  }
  return {
    name: 'local-cors-api',
    configureServer: attach,
    configurePreviewServer: attach,
  }
}

const require = createRequire(import.meta.url)

const WASM_SRC = require.resolve('sql.js/dist/sql-wasm.wasm')

const WASM_BASE64_ID = 'virtual:sql-wasm-base64'
const RESOLVED_BASE64_ID = '\0' + WASM_BASE64_ID

/**
 * 把 sql.js 的 wasm 以 base64 **内联进主包**（`virtual:sql-wasm-base64`）。
 * ------------------------------------------------------------------
 * 为什么不用外置资源文件：外置方案要在"扩展名 / MIME / CDN 是否改写 .js"之间反复妥协，
 * 踩过的坑包括——`.wasm` 被部分 CDN 直接 404；`.bin` 被只放行已知 MIME 的托管环境 404；
 * 用 `<link rel="preload">` 时相对路径按 document.baseURI 解析，在 blob:/srcdoc 预览壳
 * 或无尾斜杠的深层路径下会解析错，浏览器报 `Failed to fetch`（连状态码都没有）。
 * 内联之后：**产物零外部请求**，任何静态托管（含热铁盒这类平台）与本地静态服务器都能跑，
 * 也不再有"新旧版本 chunk 对不上"的问题。
 *
 * 取舍：wasm 原始 658KB，base64 后 878KB，主包因此变大（+33%）。
 * 我们内联的是**未压缩**的 wasm，运行时不需要 DecompressionStream——
 * 少一个环境相关的 API 依赖，就少一类"有的浏览器跑不起来"。
 * 传输体积由托管方的 gzip/brotli 兜底（base64 文本压缩率很好）。
 */
function sqlWasmInline() {
  let cache = null
  const base64 = () => (cache ??= readFileSync(WASM_SRC).toString('base64'))
  return {
    name: 'sql-wasm-inline',
    enforce: 'pre',
    resolveId(id) {
      if (id === WASM_BASE64_ID) return RESOLVED_BASE64_ID
      return null
    },
    load(id) {
      if (id === RESOLVED_BASE64_ID) return `export default ${JSON.stringify(base64())}`
      return null
    },
  }
}

/** 文件名 → 可安全嵌入正则的字面量 */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 内联到 HTML 里的 JS/CSS 必须做「标签闭合」转义。
 * ------------------------------------------------------------------
 * 若代码里出现 `</script`，HTML 解析器会认为脚本到此结束：**后面的 JS 会被当成 HTML 解析**，
 * 凭空多出一个外链 <script> 标签——在 file:// 下就是一条 CORS 报错 + 白屏。
 * （Vite 的 modulepreload polyfill 源码里恰好含 `</script>` 字面量，必然踩到。）
 * 顺带转义 `<!--`，避免 tokenizer 进入 script-data-escaped 状态。
 * 这两种转义在 JS 里都是**等值**的（`\/` → `/`、`\!` → `!`），不会改变代码行为。
 */
const inlineSafe = (code) =>
  String(code)
    .split('</script')
    .join('<\\/script')
    .split('<!--')
    .join('<\\!--')

/**
 * 单文件打包（`--mode single`）。
 * ------------------------------------------------------------------
 * 目的：让 `index.html` **双击就能玩**。
 * 为什么必须全部内联——实测 Chrome 在 `file://` 下会以 "origin 'null'" 为由拦掉
 * **所有跨文件子资源**：`type="module"` 的脚本、外链 CSS 都会被 CORS 拒绝
 * （`ERR_FAILED`），页面只剩空白。而 IndexedDB 与 WebAssembly 在 file:// 下是可用的，
 * 所以只要把 JS/CSS 全塞进这一个 HTML，双击打开就能正常跑，无需任何服务器。
 * 同时这个文件放在 http 下也一样能跑，因此它同时覆盖"本地双击"与"任意静态托管"。
 *
 * 注意保留 `type="module"`：产物里用到了 `import.meta`，只有在模块语境下才合法；
 * 而**内联**模块脚本没有网络请求，不受 file:// 的 CORS 限制。
 */
function singleFile() {
  return {
    name: 'inline-single-file',
    enforce: 'post',
    generateBundle(_opts, bundle) {
      const htmlKey = Object.keys(bundle).find((k) => k.endsWith('.html'))
      if (!htmlKey) return
      const htmlAsset = bundle[htmlKey]
      let html = String(htmlAsset.source)

      // CSS → <style>
      for (const [key, item] of Object.entries(bundle)) {
        if (item.type !== 'asset' || !key.endsWith('.css')) continue
        const tag = new RegExp(`<link[^>]*href="[^"]*${escapeRe(key.split('/').pop())}"[^>]*>`)
        if (tag.test(html)) {
          html = html.replace(tag, () => `<style>\n${inlineSafe(item.source)}\n</style>`)
          delete bundle[key]
        }
      }

      // 入口 JS → 内联模块脚本
      for (const [key, item] of Object.entries(bundle)) {
        if (item.type !== 'chunk' || !item.isEntry) continue
        const tag = new RegExp(`<script[^>]*src="[^"]*${escapeRe(key.split('/').pop())}"[^>]*></script>`)
        if (!tag.test(html)) continue
        // 用函数式替换：字符串替换会把 code 里的 $& / $` 等当成替换模式展开，
        // 从而把匹配到的标签整段塞进 JS 中间（既污染代码又提前闭合 script 标签）
        html = html.replace(tag, () => `<script type="module">\n${inlineSafe(item.code)}\n</script>`)
        delete bundle[key]
      }

      // 清掉不再需要的 modulepreload 提示
      html = html.replace(/<link[^>]*rel="modulepreload"[^>]*>\s*/g, '')

      htmlAsset.source = html
    },
  }
}

// 纯静态构建：前端源码位于 web/，产物输出到仓库根目录
//   · 默认（npm run build）      → dist/            多文件版，托管用（JS 可被浏览器缓存）
//   · --mode single（一并执行）   → dist-standalone/ 单文件版，双击 index.html 即玩
// base 用相对路径，便于部署到任意子目录（GitHub Pages / nginx / OSS / 热铁盒 等）
export default defineConfig(({ mode }) => {
  const single = mode === 'single'
  return {
    root: 'web',
    base: './',
    plugins: [react(), sqlWasmInline(), localCorsApi(), ...(single ? [singleFile()] : [])],
    build: {
      outDir: single ? '../dist-standalone' : '../dist',
      emptyOutDir: true,
      chunkSizeWarningLimit: 2048,
      // 单文件版必须把动态 import 一并内联，否则 file:// 下加载子 chunk 会被拦
      // 多文件托管版则把 react/react-dom 拆成独立 vendor chunk，提升浏览器缓存命中
      ...(single
        ? { rollupOptions: { output: { inlineDynamicImports: true } } }
        : {
            rollupOptions: {
              output: {
                manualChunks: { react: ['react', 'react-dom'] },
              },
            },
          }),
    },
    server: {
      port: 5173,
      // 编辑器原子保存会在源码旁生成 `.文件名.<pid>.<uuid>.tmpdir`，
      // Windows 上 chokidar 跟进去后文件立刻被删，会以 EBUSY 直接打崩 dev server。
      watch: {
        ignored: ['**/.*.tmpdir/**', '**/*.tmp'],
      },
    },
  }
})
