# 参与贡献 · Contributing

感谢你关注「灰烬余生 · Ashes Remain」。本项目是一个纯前端、浏览器内 SQLite 存档、由大模型现场生成叙事的末日生存文字游戏。

## 开发环境

```bash
npm install
npm run dev            # 本地开发（带 /api/cors 反代与热更新）
npm run build:host     # 构建多文件托管版 → dist/
npm run build:single   # 构建单文件双击版 → dist-standalone/
npm run start          # 用零依赖 Node 服务托管 dist/（含 /api/cors 反代与 /healthz）
```

> 注意：`dist/` 必须入库（Bonto 等平台是「从仓库拉代码 → 直接 `npm start`」，不会跑 vite build）。
> 单文件版 `dist-standalone/` 与 `bonto/` 已被 .gitignore 忽略，无需提交。

## 架构约定

- **引擎管数值，模型写叙事**：`web/src/core/engine.js` 只裁决可枚举的状态（hp/hunger/thirst/sanity/stamina/infection、时钟、天气、任务链、地图、搜刮配额、结局）；LLM 仅在引擎给出的「有界状态快照 + 上一事件 + 玩家选择」骨架内生成叙事文本。
- **持久层**：`web/src/db/` 把 SQLite + IndexedDB 封装成存档/配置读写；配置与存档都只存在用户本机，没有数据后端。
- **wasm 内联**：sql.js 的 wasm 由 `vite.config.js` 的 `sqlWasmInline()` 以 base64 内联进主包，运行时零外部请求。改动 `sql.js` 版本后务必重新构建，并用 `npm run check:wasm` 校验内联一致性。

## 提交前自检

```bash
npm run build:host     # 必须构建通过
npm run check:wasm     # 内联 wasm 必须与当前 sql.js 版本一致
node scripts/selftest.mjs   # 引擎核心不变量集成测试必须通过
```

也可以在本地用自带 Key 跑一次真实通道冒烟（需要你自己配置 API Key，Key 不会离开本机）：

```bash
npm run test:llm
```

## 提交规范

- 保持 PR 小而聚焦，说明「为什么」而不仅是「改了什么」。
- 涉及引擎数值规则、结局判定、存档结构的改动，请在 PR 描述里说明对现有存档的兼容性。
- 不要提交 `dist-standalone/`、`bonto/`、`node_modules/`、`.env`。

## 行为准则

友好、务实、对玩家数据负责：本作不收集任何用户信息，所有配置与存档都在用户自己设备上。任何改动都应延续这一隐私承诺。
