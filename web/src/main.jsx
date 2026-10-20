import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './styles.css'

/**
 * 站点图标：**运行时用 Blob URL 注入**，而不是在 index.html 里写死 data: URI。
 * ------------------------------------------------------------------
 * 为什么不用 data: ——部分托管 / 预览环境会下发 CSP（实测为 img-src blob: https:），
 * data: 图标会被直接拦截并在控制台报错；更糟的是浏览器随后会回退去请求
 * /favicon.ico，在静态托管上又是一条 404。blob: 正好在白名单内，两边都干净。
 * 图标本身是锦上添花，任何失败都不应影响游戏启动，因此整体 try/catch 兜住。
 */
const FAVICON_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>" +
  "<rect width='64' height='64' rx='14' fill='#0b0d0c'/>" +
  "<path d='M32 11c-7.5 0-13 5.4-13 12.6 0 5.2 2.2 8.4 5.4 10.6v9.2c0 2.2 1.8 4 4 4h7.2c2.2 0 4-1.8 4-4v-9.2c3.2-2.2 5.4-5.4 5.4-10.6C45 16.4 39.5 11 32 11z' fill='#c0392b'/>" +
  "<circle cx='27' cy='25' r='3' fill='#0b0d0c'/>" +
  "<circle cx='37' cy='25' r='3' fill='#0b0d0c'/>" +
  '</svg>'

function installFavicon() {
  try {
    const url = URL.createObjectURL(new Blob([FAVICON_SVG], { type: 'image/svg+xml' }))
    let link = document.getElementById('app-icon') || document.querySelector('link[rel="icon"]')
    if (!link) {
      link = document.createElement('link')
      link.rel = 'icon'
      document.head.appendChild(link)
    }
    link.type = 'image/svg+xml'
    link.href = url
  } catch {
    /* 图标失败不影响游戏 */
  }
}

installFavicon()

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
