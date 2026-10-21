# 灰烬余生 · Ashes Remain

AI 驱动的末日丧尸生存文字游戏。纯静态网页，没有后端。每一回合的事件由大模型现场生成，前后因果相连；结局不从清单里抽，死亡是唯一失败条件。

| 项 | 说明 |
| --- | --- |
| 版本 | 2.0.0（`zombie-survival-text-game`） |
| 形态 | 单人 · 回合制 · 纯文字 · 浏览器 |
| 运行时 | Node.js 18+（用于安装、构建与托管；玩的时候只需要浏览器） |
| 存储 | 浏览器内 SQLite（sql.js / WASM），文件落在 IndexedDB |
| 模型 | 浏览器直连任意 OpenAI 兼容接口。跨域中转默认关闭 |
| 托管 | 任意静态托管；Bonto（bonto.dev）一条命令：`npm run deploy:bonto` |

---

## 项目是什么

你从尸化病毒 HNV-7 爆发的第一天活下去。界面给出 3–4 个选项，选完之后模型写出下一事件，并推进游戏内时钟。没有事件池，也没有预设结局表。

引擎和模型分工固定：

- **引擎管可枚举的东西**：生命 / 饥饿 / 口渴 / 精神 / 体力 / 感染、24 小时时钟、天气、任务焦点、事件骰、区域地图、搜刮配额、结局判定。
- **模型管写出来的东西**：事件正文、选项措辞、人物、变异株、记忆摘要。它每回合只收到一份体积恒定的状态快照、上一事件和玩家选择，不接收逐轮对话历史，所以玩到第 50 回合也不会把上下文撑爆。

主线是当前阶段必须做成的一件事。支线从主线岔出去，了结后焦点回到主线。主线做成或做不成，引擎归档旧主线并开启下一条。生命、精神归零，或感染值到 100，游戏结束。

### 这一版

- **选项必须能在剧情里对上。** 每个选项带一句「依据」，写在按钮下方。选项里点到的物件、人名、地点，必须已经出现在本回合正文、背包、地点或任务线索里。模型没写进去时，引擎用它自己给出的依据补进这一段叙事，再让你选择。背包和主线里本来就有的，不会再重复补一句。
- **跨域中转默认关闭。** 请求直接发给服务商，不经过公共代理。
- **需要时再开。** 服务商不返回 CORS 头时，在设置里改为「同源中转」（部署在带服务端的实例上，请求不出自己的源），或 cors.io，或填写自己的网关前缀。直连被拦且本站带服务端时会自动兜底。

---

## 目录

```
├── package.json              # 脚本与依赖
├── server.js                 # 平台入口：静态托管 + /api/cors 反代 + /healthz（零依赖）
├── vite.config.js            # 双产物构建，以及开发/预览用的 /api/cors 转发
├── web/
│   ├── index.html
│   └── src/
│       ├── main.jsx / App.jsx / styles.css / api.js
│       ├── core/
│       │   ├── engine.js     # 状态机、数值、昼夜、任务链、地图、结局
│       │   ├── prompt.js     # 世界设定、状态快照、事件骰、各动作提示词
│       │   ├── llm.js        # OpenAI 兼容客户端、JSON 提取、CORS 地址拼接
│       │   └── mock.js       # 离线通道，只给自检用，不能正式开局
│       ├── db/
│       │   ├── sqlite.js     # WASM 初始化与 IndexedDB 持久化
│       │   └── store.js      # 存档与设置仓储
│       └── components/       # 开局、对局、结局、设置
└── scripts/
    ├── build-bonto.mjs       # 生成 bonto/ 部署包（零依赖清单 + 构建产物）
    ├── deploy-bonto.mjs      # 构建 + 建应用 + 上传，一条命令发布
    └── selftest.mjs          # 提示词单元检查 + 浏览器端到端自检
```

构建产物 `dist/`、`dist-standalone/`、部署包 `bonto/` 和 `node_modules/` 不入库。

### 数据表

| 表 | 内容 |
| --- | --- |
| `sessions` | 一局一行：天数、分钟时钟、天气、地点、六项数值、主线、结局 |
| `log_entries` | 叙事段落，只增量追加 |
| `entities` | 背包、伤病、同行者、剧情标记、变异株、支线、地图节点、行进轨迹、已完成主线、任务焦点 |
| `settings` | 键值配置，含 API Key、Base URL、模型名、温度、跨域中转 |

---

## 环境要求

- Node.js 18 或更高，自带 npm
- 现代浏览器（Chrome / Edge / Firefox）。需要 IndexedDB 和 WebAssembly
- 一个 OpenAI 兼容的对话接口，以及对应的 API Key。没有 Key 不能开局

不需要数据库服务、不需要自己的后端。

---

## 安装与开发

在项目根目录：

```bash
npm install
npm run dev
```

开发服务器默认地址：[http://localhost:5173](http://localhost:5173)（`vite.config.js` 里 `server.port`）。源码在 `web/`，改完即热更新。

首次进入会弹出「AI 通道设置」。选一个预设或填自定义地址，写入 API Key，点「测试连通性」。测试通过后才能开新局。

---

## 构建

一次构建产出两种静态包：

```bash
npm run build
```

| 命令 | 产物 | 用途 |
| --- | --- | --- |
| `npm run build` | 先后写出 `dist/` 和 `dist-standalone/` | 默认，两种都要 |
| `npm run build:host` | 只写 `dist/` | 多文件，给静态托管 |
| `npm run build:single` | 只写 `dist-standalone/` | 单文件，双击即玩 |
| `npm run preview` | 预览已构建的 `dist/`，带 `/api/cors` | [http://localhost:4173](http://localhost:4173) |
| `npm start`（= `npm run serve`） | 用 `server.js` 托管 `dist/`，并反代 `/api/cors?url=` | [http://localhost:3000](http://localhost:3000)。端口取 `PORT`，监听地址取 `HOST` |

`base` 为 `'./'`，产物可以放在网站子目录里。

### 两种产物怎么选

| 产物 | 什么时候用 | 怎么打开 |
| --- | --- | --- |
| `dist/` | Nginx、Apache、OSS / COS / S3、GitHub Pages、Vercel、Netlify，以及其它静态托管 | 把目录内容整份上传。本地可用 `npm run preview` 或 `npx serve dist` |
| `dist-standalone/index.html` | 双击、用网盘或聊天发文件、只留一个文件归档 | 双击打开。放到任意静态托管上也能跑 |

不要双击 `dist/index.html`。多文件版的脚本和样式是外链，`file://` 下会被 CORS 拦掉，页面白屏。双击请用单文件版。

单文件版把 JS、CSS 和 SQLite 的 wasm（base64）全部内联进一个 HTML，运行时零外部请求。内联时会转义 `</script` 和 `<!--`，避免 HTML 解析器提前截断脚本。wasm 用未压缩字节内联，不依赖 `DecompressionStream`。

### 构建后体积（量级）

| 文件 | 大约体积 |
| --- | --- |
| `dist/assets/index-<hash>.js` | ~1.21 MB（gzip ~541 KB），内含 SQLite 引擎 |
| `dist/assets/index-<hash>.css` | ~35 KB（gzip ~7 KB） |
| `dist/assets/mock-*.js` | ~15 KB，仅自检时加载 |
| `dist-standalone/index.html` | ~1.26 MB（gzip ~560 KB） |

托管侧建议对 `assets/` 开 gzip 或 brotli，并按内容哈希做长缓存。`server.js` 已经自带 gzip（主包 1.2 MB → 约 540 KB），静态托管上则由托管方压缩。

---

## 部署到 Bonto

[Bonto](https://bonto.dev/) 给每个应用一个容器和 `https://<子域名>.bonto.run`，从 `package.json` 的 `start` 脚本拉起进程，端口由平台通过 `PORT` 注入。仓库里的 `server.js` 就是按这套约定写的，本地和线上跑的是同一份代码。

### 从仓库拉取部署（Git 通道）

平台只做「拉代码 → `npm install` → `npm start`」，**不会执行 `vite build`**，所以构建产物必须入库：

```bash
npm run build
git add dist
git commit -m "构建产物入库"
git push
```

`dist/` 之所以不再被 `.gitignore` 忽略，就是这条链路的要求。漏了这一步的表现很有辨识度：
**服务其实起来了**（`/healthz` 返回 200），但访问任何路径都是 404「没有这个文件」。
现在这种情况会返回一页部署说明，且 `/healthz` 里带 `hasIndex: false`，一条 curl 就能确认：

```bash
curl -s https://<子域名>.bonto.run/healthz
# {"ok":true,"corsProxy":true,"hasIndex":false,...}   ← false 就是产物没上来
```

### 一条命令

```bash
npx @sidequestvr/bonto auth login          # 只需一次，浏览器里输 6 位码
npm run deploy:bonto -- --subdomain ashes-remain
```

`deploy:bonto` 会依次做四件事：构建 `dist/` → 生成 `bonto/` 部署包 → 应用不存在就创建 → 逐文件上传（`package.json` 最后传，避免用残缺状态触发一次部署）。上传完成后平台自动部署，十几秒后访问 `https://ashes-remain.bonto.run`。

先看计划不执行，加 `--dry-run`；产物已是最新不想再构建，加 `--skip-build`。

### 为什么另做 `bonto/` 部署包

直接把仓库根目录推上去也能跑，但根 `package.json` 带着 vite / rollup 这些构建期依赖，平台会在 512 MB 的容器里跑一遍 `npm install`——既慢又可能 OOM，而产物其实早就构建好了。

`scripts/build-bonto.mjs` 因此裁出一个自包含目录：

```
bonto/
├── package.json     # 零依赖，只有 "start": "node server.js"
├── server.js        # 与仓库根目录的同一份
└── public/          # dist/ 的内容
```

平台上 `npm install` 无事可做，`npm start` 直接起服务。整个包 6 个文件、约 1.3 MB。

### 平台约定（改代码时别破坏）

| 约定 | 为什么 |
| --- | --- |
| 端口取 `process.env.PORT`，缺省 3000 | 平台注入的端口不固定 |
| 必须绑 `0.0.0.0` | 绑 `127.0.0.1` 时容器外的反代连不进来，表现为平台报健康检查失败 / 502，而容器日志一切正常 |
| 提供 `/healthz` | 平台健康检查与冷启动唤醒先打这个路径 |
| 静态目录自动探测 `dist/` → `public/` → `dist-standalone/` | 本地和部署包用同一个入口，不需要各自配置 |
| 不写服务端文件 | 容器重启会丢临时盘。存档本来就在浏览器 IndexedDB 里，服务端保持无状态才能安全休眠 |

### 计费与休眠

Bonto 免费额度按小时计。纯静态站点不扣时长，但**有 `start` 脚本的 Node 应用会扣**（免费额度每月 50 小时），空闲 30 分钟后自动休眠、下次请求唤醒。

如果只想要零时长的静态托管，把 `bonto/public/` 的内容直接当静态站上传即可，代价是**没有 `/api/cors`**，模型请求只能靠服务商自己的 CORS 头或 cors.io。需要同源反代时仍走 Node 应用这条路。

### 其它托管

`dist/` 是纯静态产物，Nginx、OSS / COS / S3、GitHub Pages、Vercel、Netlify 都能直接放。只有一点区别：**静态托管没有 `/api/cors`**，设置里选「同源中转」会 404，保持「关闭」或改用 cors.io。

---

## 配置模型

入口：首页或对局顶栏的「AI 通道设置」。

| 通道 | 填什么 |
| --- | --- |
| 预设 | DeepSeek、OpenAI、Moonshot、通义千问、智谱 GLM、硅基流动、本地 Ollama，点一下套用地址和模型名 |
| 自定义 | 任意 OpenAI 兼容端点：名称、Base URL、模型名、API Key |

首次启动不预置网关、模型或 Key。Base URL 要带版本路径，通常以 `/v1` 结尾；程序会自行拼接 `/chat/completions`。Key 写入本机 SQLite，不会打进构建产物。

本地 Ollama：先设环境变量 `OLLAMA_ORIGINS=*` 再重启 Ollama，然后选「本地 Ollama」（`http://localhost:11434/v1`），或自己填兼容地址。

### 跨域

浏览器直连要求上游返回 CORS 头。设置里的「跨域中转」有四档：

| 选项 | 行为 |
| --- | --- |
| 关闭（默认） | 浏览器直连上游。上游必须允许 CORS |
| 同源中转 · 本站 `/api/cors` | 请求打到自己部署的服务端，由它转发。浏览器侧不需要 CORS，Key 不经过第三方。**需要带服务端的部署**（Bonto Node 应用 / `npm start`） |
| cors.io · https://cors.io/?url= | 浏览器 POST 到 `https://cors.io/?url=<编码后的上游 URL>`。由该代理转发 POST 正文和鉴权头，并补上 CORS 头 |
| 自定义中转前缀 | 填你自己的网关前缀。以 `?url=` 结尾时按同样方式编码上游地址 |

直连被 CORS 挡掉、且本站带服务端时，`llm.js` 会**自动改走一次同源中转**（先用 `/api/health` 探测，一局只探一次）。玩家显式选了中转时不覆盖。

`vite.config.js` 的 `localCorsApi()`（开发/预览）和根目录 `server.js`（生产）都提供 `/api/cors?url=` 与 `/api/health`，两者契约一致。

拼接逻辑在 `web/src/core/llm.js` 的 `localCorsUrl()` / `wrapWithCorsProxy()`。

温度可在设置里调。事件分歧不够时，试 1.05–1.15。每回合另有一枚命运种子，温度越高，同一局面分叉越大。

---

## 怎么玩

1. 配好模型并测试通过。
2. 填写主角，开一局。开场从爆发第 1 天写起。
3. 读事件，点一个选项。选项只写动作，不写结果；按钮下方的「依据」对应该段剧情里已经出现的细节。有的选项听起来稳、实际上是陷阱。
4. 选项在内部标注它服务的任务线：主线、某条进行中的支线，或另起一条。点支线选项，下一回合就围着那条支线写。界面上不把这条标注印在按钮上。
5. 顶栏可打开地图（SVG 街区，当前位置和走过的路随剧情更新）、备份或导入存档、回主菜单。

对局中还可以搜刮、使用物品、把物品交给某人、睡觉。这些动作同样走模型，但数值结算（饥饿、口渴、感染、时钟、天气漂移、死亡判定）由引擎做。

时钟只在行动时走。现实约 5 分钟对应游戏内一天；模型只报这次行动花了几小时（`timeCostHours`，0–6）。白天 06:00–18:00，黄昏到 20:00，之后是夜。入夜后界面变暗，丧尸更活跃。

存档自动写在当前浏览器里。换电脑或换浏览器：在设置或顶栏导出 `.sqlite`，到新环境导入（覆盖当前库，需确认）。清空全部存档同样要二次确认。

---

## 边界

- 没有数据后端。存档、Key、配置都在这台浏览器的 IndexedDB 里，清站点数据等于删档。导出文件是唯一备份。`server.js` 只发静态文件、转一次跨域请求，不写盘、不存状态，所以容器随时可以休眠或重启。
- 没有 Key、连通性测试没过，不能开局。`mock` 通道不能用来正式开局，只服务于 `scripts/selftest.mjs`。
- 模型必须返回约定 JSON。解析失败时本回合不会推进；检查 Base URL、模型名和余额。
- 静态托管上页面自己不能发跨域请求。默认直连，上游必须允许 CORS；不支持时用「同源中转」（需带服务端的部署）或 cors.io。
- 单文件版约 1 MB 出头，不适合当作「轻量页面」优化目标；换来的是双击可玩、对 CDN 的 MIME 和 wasm 扩展名没有要求。
- 自检脚本会拉起外部 Chrome 调试端口，并访问本机预览地址。它不是玩家流程的一部分。

### 自检（可选）

```bash
npm run build
npm run preview
```

另开一个带远程调试端口的 Chrome，再跑：

```bash
node scripts/selftest.mjs
```

默认连 `CDP=http://127.0.0.1:9222`、`APP=http://127.0.0.1:4173`，可用同名环境变量覆盖。脚本前半段不依赖浏览器，直接检查事件骰和提示词拼装。

---

## 常见问题

**打不开模型，或控制台出现 CORS。**  
先确认是不是纯静态托管：那种部署没有 `/api/cors`，只能靠上游自己的 CORS 头或 cors.io。有服务端时把跨域中转改为「同源中转」，或直接留「关闭」——直连失败会自动兜底走同源中转一次。本地 Ollama 需要 `OLLAMA_ORIGINS=*`。

**Bonto 上打开是 502，或一直转圈。**  
先看日志：`npx @sidequestvr/bonto logs <子域名> --tail 50`。三种常见原因：① 端口没取 `PORT`；② 绑了 `127.0.0.1` 而不是 `0.0.0.0`；③ 上传时漏了 `public/`，`server.js` 找不到静态目录。前两条 `server.js` 已经处理，改动它时别改回去。

**选项里出现正文没写过的东西。**  
看按钮下的「依据」，并回头看这一段末尾。引擎会把对不上的物件用依据补进叙事。若依据本身也对不上背包、地点和任务线索，那一句会出现在正文末尾。刷新旧存档不会改写已经生成过的段落。

**双击 `dist/index.html` 白屏。**  
用 `dist-standalone/index.html`。多文件版必须通过 http(s) 打开。

**换电脑后没有存档。**  
在旧浏览器里导出 `.sqlite`，在新浏览器里导入。

**401 / 403。**  
Key 无效，或这把 Key 没有该模型的权限。回设置里改完再测试。

**404，提示 Base URL 或模型名不正确。**  
Base URL 补上 `/v1`（或该服务实际的版本前缀）。不要自己再加 `/chat/completions`。

**剧情换汤不换药。**  
把温度调到 1.05–1.15。事件骨架每回合都会重掷，内容仍取决于模型。

---

## 友情链接

- [LINUX DO](https://linux.do/)
