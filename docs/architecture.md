# 架构说明

一页讲清这个工具是怎么串起来的，方便你定位"要改的东西在哪"。

## 一句话

本地面板（网页） ↔ 本地服务（`server.js`） ↔ 自动化子进程（`greet.js`） ↔ 你本机的 Chrome ↔ BOSS 网页。

## 数据流

```
┌────────────┐   HTTP / SSE      ┌──────────────────┐  spawn + stdin/stdout(IPC)  ┌───────────┐
│ public/    │ ←───────────────→ │    server.js     │ ←─────────────────────────→ │  greet.js │
│  单页面板  │  127.0.0.1:7788   │ 装配 + 分发        │   @@IPC@@ + 一行 JSON       │ （入口+编排）│
└────────────┘                   │  ├ routes/*.js   │                             └─────┬─────┘
                                 │  └ lib/{http,state,│                                   │ lib/*
                                 │      store,runner} │                                   ▼
                                 └────────┬─────────┘                            你本机的 Google Chrome
                                          │ 读写                                  （独立 profile，不碰日常 Chrome）
                                          ▼
                                   data/*.json / prompts/
                                   logs/*.json / logs/*.txt
```

## 三个角色

| 角色 | 是什么 | 关键约束 |
|---|---|---|
| `public/` | 纯静态单页面板，只跟本机 `server.js` 通信 | 只能访问 `127.0.0.1` |
| `server.js` | **只做装配 + 分发**：静态文件 → 路由表 → 未命中 404 | 只监听 `127.0.0.1`，有 Host / Origin 白名单 |
| `greet.js` | 入口：`require` + 参数 + 单实例锁 + `main()` 编排；具体能力在 `lib/*` | 通过 stdin/stdout 的 `@@IPC@@` 行协议收发指令与日志 |

面板和 `greet.js` **不直接通信**：所有指令都经 `server.js` 中转（`PAUSE` / `RESUME` / `STOP` 从面板 → server → 子进程 stdin）。

## 服务端结构

| 文件 | 职责 |
|---|---|
| `server.js` | 装配依赖 → `http.createServer`（静态 → 路由分发 → 404）→ `listen`（≈ 110 行） |
| `routes/index.js` | 路由表：key = 「方法 + 空格 + 路径」，value = `(req, res, body) => ...` |
| `routes/*.js` | 每个 API 组一个文件（bootstrap / collected / checked / greetings / collect / send / config / prompt / knowledge / records / expects / pause / resume / stop / close-browser / open-browser / events） |
| `lib/http.js` | `json()` / `readBody()` / **Host·Origin 白名单** / 静态文件（含路径穿越防护） |
| `lib/state.js` | 可变 `state` + `broadcast` + SSE 订阅 + 事件缓冲（`seq` / `rid` 重放） |
| `lib/data-dir.js` | 数据目录（`data/`）常量 + 旧文件幂等自动迁移（模块加载即执行） |
| `lib/store.js` | 路径常量（指向 `data/`）+ `readJson` / `writeJson` + `settingsView` / `loadFilters` / `todayCount` 等 |
| `lib/runner.js` | 子进程编排（`startChild` / `sendCmd` / `stopChildAsync` / `killKeptBrowser`） |

加新接口：写一个 `routes/xxx.js`（导出 `(deps) => async (req,res,body) => {...}`），在 `routes/index.js` 挂上 key 即可。

## 自动化端结构

| 文件 | 职责 |
|---|---|
| `greet.js` | 入口（参数 / 单实例锁 / `main()` 编排，≈ 390 行） |
| `lib/ipc.js` | IPC 协议（`@@IPC@@` 行格式）+ 暂停 / 停止控制、检查点 |
| `lib/browser-session.js` | 连接 / 启动 Chrome、复用与保活、预热 |
| `lib/login-guard.js` | 登录检查、安全验证处理与熔断 |
| `lib/collect.js` | 采集：抓岗位卡片（按需翻页 / 补滚）、进详情、读 JD 与招聘者活跃度、过滤去重 |
| `lib/send.js` | 发送 / 填充流程（`fillOnly` 只填不发；`confirm` 直接逐条发送） |
| `lib/pool.js` | 候选池落盘、按岗位 ID 去重合并、增量配额 |
| 其余已有模块 | `data-dir`（数据目录·迁移）/ `args`（参数）/ `search`（搜索·收藏 URL 与翻页·意向·源头筛选拼参）/ `page-helpers`（拟人操作）/ `greeting`（招呼语）/ `knowledge`（知识库）/ `blacklist`（黑名单）/ `lock`（单实例锁）/ `chrome-kill` / `utils` |

> 约定：自包含子系统写成工厂函数 `module.exports = (deps) => { ... }`，由调用方注入依赖。

## 数据文件

| 文件 | 内容 | 是否进仓库 |
|---|---|---|
| `data/config.json` | 运行配置（默认值随仓库附带） | ✅ 是（默认值） |
| `data/knowledge.json` | 你的知识库 | ❌ 否 |
| `data/cities.json` | 城市列表（下拉数据源） | ✅ 是 |
| `data/filters.json` | 岗位初筛筛选项（选项 + 区县） | ✅ 是 |
| `prompts/*.md` | 招呼语 / 访谈提示词（面板可编辑） | ✅ 是 |
| `logs/last-collect.json` | 候选池 | ❌ 否 |
| `logs/run-*.log` | 运行日志 | ❌ 否 |
| `.chrome-profile/` | 浏览器登录态 | ❌ 否 |

## 关键约束（改代码前必读）

- **默认只填不发**；`mode:"auto"` 需要 `userApproved`（服务端 403 门禁）。
- **零遥测、零云依赖**：全部数据落本地明文文件。
- 浏览器自动化用 **patchright**（反检测），驱动的是**用户本机的 Chrome**（`lib/utils.js` 里按三个标准路径探测）。
- 测试分两层：`tests/unit/`（离线纯逻辑，`npm test`，CI 跑）、`tests/e2e/`（需本机 Chrome + 登录，维护者手工跑）。
