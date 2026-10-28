/**
 * Electron 桌面端主进程
 * ------------------------------------------------------------------
 * 末日生存游戏是纯静态前端（React + Vite）。桌面端不需要任何原生插件，
 * 因此这里用一个最小的 Node 静态服务器把已构建的 web/dist 跑在
 * http://127.0.0.1:<随机端口> 上，再用 BrowserWindow 打开——和浏览器
 * 行为一致（IndexedDB / WebAssembly / ES Module 都正常），避免 file:// 下
 * 模块化脚本与 IndexedDB 被限制的问题。
 *
 * 构建流程：
 *   1) npm run build            # 生成 web/dist 与 web/dist-standalone
 *   2) npm run electron:build   # electron-builder 打包成安装包
 */
const { app, BrowserWindow } = require('electron')
const http = require('http')
const fs = require('fs')
const path = require('path')

// dist 目录：仓库根/dist（与 capacitor 共用同一份 web 构建产物）
const DIST = path.join(__dirname, '..', 'dist')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
}

function startStaticServer() {
  const server = http.createServer((req, res) => {
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0])
    if (urlPath === '/' || urlPath === '') urlPath = '/index.html'
    const filePath = path.normalize(path.join(DIST, urlPath))
    // 防目录穿越
    if (!filePath.startsWith(DIST)) {
      res.writeHead(403)
      res.end('Forbidden')
      return
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        // SPA 兜底：未知路径回退到 index.html
        const fallback = path.join(DIST, 'index.html')
        fs.readFile(fallback, (e2, d2) => {
          if (e2) {
            res.writeHead(404)
            res.end('Not found')
          } else {
            res.writeHead(200, { 'Content-Type': MIME['.html'] })
            res.end(d2)
          }
        })
        return
      }
      const ext = path.extname(filePath).toLowerCase()
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
      res.end(data)
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function createWindow(server) {
  const port = server.address().port
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0b0e0c',
    title: '末日生存',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })
  win.loadURL(`http://127.0.0.1:${port}/`)
  // 方便调试：Ctrl+Shift+I 打开开发者工具
  win.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'I' && input.control && input.shift) {
      win.webContents.toggleDevTools()
      event.preventDefault()
    }
  })
  return win
}

app.whenReady().then(async () => {
  const server = await startStaticServer()
  createWindow(server)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(server)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
