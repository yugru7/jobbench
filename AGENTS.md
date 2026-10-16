# AGENTS.md —— 给 AI agent 的操作手册

> 你（AI agent）正在操作「Job Search Workbench / 求职助手」（仓库名 jobbench）：一个本地运行的 BOSS直聘 自动化工作台。
> 用户通过聊天把任务交给你，你按这份手册操作工具。所有路径都相对本项目根目录。

## ⚡ 30 秒速览（新 agent 先看这里）

- **这是什么**：本地运行的 BOSS直聘 岗位筛选工作台，面板在 http://127.0.0.1:7788
- **你能做什么**（智能部分）：补全用户知识库、逐条评判岗位匹配度并勾选、按 JD 写定制招呼语、调爬取节奏
- **你不能做什么**：调用 `mode:"auto"`（硬 403 门禁）、编造知识库/招呼语里的事实、绕过发送确认
- **怎么操作**：一律走 HTTP API `http://127.0.0.1:7788`，不要用命令行
- **先读铁律**（下一节），**再按任务 A / B / C 对号入座**开始干活

## 这个工具是什么

- **机械部分（工具负责）**：爬取岗位 → 读 JD 和招聘者活跃度 → 把招呼语填进输入框（默认不发送）
- **智能部分（你负责）**：补全用户的知识库、按 JD 写招呼语
- 用户的门户是本地面板：`http://127.0.0.1:7788`（服务没起就 `node server.js`，或让用户双击 `启动.bat`）

## 铁律（先看这个）

1. **默认不主动发送消息**。默认流程是「只填不发」：把招呼语填进输入框后停下，等用户自己在浏览器里点发送。接口层面默认只允许 `fillOnly`（只填不发）；`confirm` **实际会直接逐条发送给 HR**（详见下方「发送」一节），仅在用户明确同意发送、且招呼语已给用户过目确认后才可用；`mode:"auto"`（全自动发送）由服务端硬性要求 `userApproved:true`，而该字段只有用户本人在面板确认弹窗点「确定」时才会带上 —— **agent 永远不得调用 `mode:"auto"`，也不得自行传 `userApproved`**（传了会被服务端 403 拒绝）。
2. **只写真实信息**。知识库、招呼语里的每个字都会发给真人 HR，面试可能被追问。只能写用户真实说过的事，严禁编造经历/技能/数字。
3. 这是用户自己电脑上的私人工具，知识库、聊天内容等不要上传到任何地方。
4. **操作一律走 HTTP API（http://127.0.0.1:7788），不要用命令行跑 `node greet.js`**。命令行跑任务面板完全不动（进度/结果面板都看不到），还可能和面板发起的任务抢浏览器。只有服务没起、面板没开时才允许命令行，且跑完要提醒用户刷新页面。服务端有 **Host / Origin 白名单**，只受理来自本机的请求（只认 `127.0.0.1` / `localhost`），所以调接口一律用 `http://127.0.0.1:7788`，不要换成别的域名或内网 IP。另：**面板发起的任务统一走 CDP 模式** —— 复用一个常驻的调试 Chrome + 已有的 BOSS 标签页，每轮只是原地翻页，不再「关掉再重开」（详见「常见坑」里那条）；命令行跑的是独立模式（自己起浏览器），会和常驻 Chrome 抢同一个 profile，所以面板开着时更不要用命令行。

5. **调「写回类」接口后必须回读核对；body 绝不能带 BOM**。`/api/knowledge`、`/api/config`、`/api/prompt` 是**把数据写回文件**的接口 —— 如果 body 解析失败（最常见原因：**带了 UTF-8 BOM**），服务端会把**空对象照样写进去**，等于**静默清空用户数据**（真实事故：一次带 BOM 的 `/api/knowledge` 把整份知识库覆盖成了 `{}`）。而且它**照样返回 `{"ok":true}`** —— 所以「接口返回 ok」**不等于**「写成功了」。**规矩**：① 用文件传 body 时必须是无 BOM 的 UTF-8（PowerShell 用 `[IO.File]::WriteAllText($p,$s,(New-Object Text.UTF8Encoding $false))`，**不要**用 `[Text.Encoding]::UTF8`，后者会带 BOM）；② 每次写回后**必须**用对应的 `GET`（如 `GET /api/knowledge`）**回读核对**内容真的对上了，不能只看 `ok`。
6. **遇到坑要主动沉淀进本文档**。操作中遇到的任何报错、混淆、用户纠正、反直觉设计 —— 只要满足「① 真实踩过 ② 下次可能再犯」，都有义务在收尾前把它补进下方「常见坑」一节（格式见节首说明），防止你自己下次再踩。一次性噪音（临时网络波动、偶发超时等）不要记。

## 目录速查

| 文件 | 是什么 |
|---|---|
| `knowledge.json` | 用户的知识库（profile / skills / entries）——结构见文件内 `_说明` |
| `cities.json` | BOSS 支持的城市列表（34 省 / 373 城，省份→城市两级；面板「省份/城市」下拉的数据源） |
| `update-cities.js` | 刷新城市列表（抓 BOSS 城市接口 → 重写 cities.json，一般不用动） |
| `logs/last-collect.json` | **候选池**：跨批次累积（按岗位 ID 去重合并，不覆盖）；含 JD、活跃度、招呼语、sent 标记。面板「获取岗位」页勾选后点「删除选中」可删岗位（先备份 .bak）；「设置」页有「清理已发送的岗位」 |
| `prompts/greeting.md` | **写招呼语前必读**：生成规则 + 写回方式。用户可在面板「设置」页 →「修改招呼语提示词」编辑 —— 以文件最新内容为准 |
| `prompts/greeting.default.md` | 出厂默认招呼语提示词（设置页「恢复默认」会用它覆盖 `prompts/greeting.md`） |
| `prompts/knowledge-interview.md` | **补知识库前必读**：访谈流程 + 红线 |
| `logs/run-*.log` | 每次运行的日志（排查问题先看它） |
| `server.js` | 本地服务（端口 7788）：HTTP 接口、任务编排、静态文件。只监听 127.0.0.1，改完必须重启才生效 |
| `greet.js` | 浏览器自动化主脚本（爬取 / 发送），一般不用改 |
| `lib/` | 后端模块（**保持分文件**，不要把逻辑塞回 `greet.js`）：`args` 参数、`search` 搜索/意向、`page-helpers` 拟人操作、`greeting` 招呼语、`knowledge` 知识库、`blacklist` 黑名单、`lock` 单实例锁、`chrome-kill`、`utils` |
| `public/` | 前端：`index.html` + `js/core.js`（状态与工具）→ `js/render.js`（渲染）→ `js/actions.js`（动作，按此顺序加载，全局函数互相调用）+ `style.css` |

## 三个常见任务

### 任务 A：帮用户补全知识库
1. 读 `knowledge.json`，看现在已有什么（首次使用可能没有这个文件 → 参考 `knowledge.example.json`）
2. 按 `prompts/knowledge-interview.md` 对用户做访谈 —— 一次问一块，一段经历聊透再问下一段
3. 把答案整理成完整的 knowledge.json，写回：`POST /api/knowledge`（面板实时刷新）
4. 收尾：让用户去面板「知识库」页签核对

### 任务 B：帮用户智能二筛 + 写招呼语（一条龙）
1. `GET /api/collected` 拿候选池 —— 关注**没勾选、没发送**（`checked:false` 且 `sent` 不存在）的岗位
2. 读 `knowledge.json`（用户画像：身份/技能/经历）—— 这是匹配度评判的标尺
3. 逐个评判岗位与用户的匹配度：JD 要求 vs 用户技能栈、薪资合理性、活跃度（刚刚/今日活跃优先）、公司背景（需要时可以用你的联网搜索查公司信息）
4. **勾选匹配度高的岗位**：`POST /api/checked { "urls": [...匹配度高的岗位 url...] }` —— 面板会实时跟着勾上
   - **分级策略（海投场景，实测 10 留 2 太严格后定）**：明显不匹配才排除（行业/岗位性质冲突、只要全职、硬性条件如到岗/天数明确不满足、薪资离谱）；**沾边就勾**——机会比完美匹配重要，宁可多勾让用户划掉，不要替用户把门
   - 勾完告知用户分级结果（哪些高匹配、哪些是沾边可试试），用户随时可以推翻你
5. 给勾选的岗位写定制招呼语：读 `prompts/greeting.md`（规则），逐条检查——两条调换岗位还能用 = 不合格
6. 写回：`POST /api/greetings`（面板实时显示）
7. 收尾：告诉用户你勾了哪几个、为什么（一句话/条），让用户去面板「编辑招呼语」页过目、改、决定发不发
- 匹配度判断宁缺毋滥：拿不准的不要勾，用户勾选权在自己手里随时可以推翻你

### 任务 C：爬取岗位
HTTP（推荐，面板开着时实时显示进度）：
```
POST /api/collect
{ "source": "search", "keywords": ["前端开发实习"], "maxJobs": 10,
  "cityCode": "101010100", "cityName": "北京" }
```
或命令行（**仅当服务没起、面板没开时**；面板开着时禁止 —— 面板看不到进度，还可能抢浏览器锁）：
```
node greet.js --mode=collect --keywords "前端开发实习" -n 10 --no-pause --city-code 101010100 --city-name 北京
```
- 三种来源：`search`（关键词）/ `recommend`（推荐流，不用关键词）/ `expect`（意向页签，需先 `--mode=expects` 读出方向让用户挑一个）
- **城市注意**：`search`/`recommend` 严格按面板城市定位（URL city 参数）；`expect` 源的意向页签来自 BOSS 按用户简历期望城市出的岗位——**面板城市对 expect 源不生效**，页签后缀（如「(北京)」）就是实际城市，如果和用户要的城市不符，提醒用户去 BOSS 上改简历期望城市
- 服务端钳制：单次爬取 ≤30 个岗位、关键词 ≤10 个（传大参数会被静默压到上限）
- 跑完用 `GET /api/collected` 或读 `logs/last-collect.json` 拿结果
- 注意：爬取是浏览器自动化，一次要几十秒到几分钟，别重复触发

### 发送（由用户主导，你只搭手）
```
POST /api/send
{ "items": [ {"url": "...", "job": "...", "company": "...", "greeting": "...", "jd": "..."} ],
  "mode": "fillOnly" }
```
`mode` 三选一，**以代码为准的真实语义**如下（别被名字骗了）：

| mode | 实际行为 | agent 可用性 |
|---|---|---|
| `fillOnly` | 只把招呼语填进输入框，**绝不点发送键**（就是你「只填不发」的状态） | ✅ 默认、最稳 |
| `confirm` | **会直接逐条点发送键、真的发给 HR**（不是"逐条停下等你确认"——`routes/send.js` 给它和 `auto` 传的参数一模一样） | ⚠️ 见下 |
| `auto` | 全自动发送 | ❌ agent 不得调用 |

- **`fillOnly`（默认、最稳）**：招呼语填进输入框后停下，等用户自己在浏览器里点发送；接口绝不消耗投递机会。
- **`confirm`**：⚠️ **它会真的发出去**，和 `auto` 在子进程层面完全等价 —— `lib/args.js` 的 `CONFIRM_EACH` 只认 `--confirm-each`（命令行用），而 `routes/send.js` 从不传它，所以"confirm"实际等于直接发送。**只有用户已明确同意发送之后**才可用，且**调用前必须先把要发的招呼语逐条给用户过目并确认**。
- **`auto`（全自动）**：**agent 永远不要用**。服务端强制要求 `userApproved:true`，该字段只有用户本人在面板确认弹窗点「确定」才会带上；agent 自己传会被 403 拒绝。
- 数量由服务端护栏限制：单次硬顶 60 条 + 按「今日剩余额度」截断（超出会返回 capped 信息，如实告知用户即可）。
- 发送方式的选择权永远在用户；只在用户**明确要求**时调这个接口。

### 标记与「表里可见性」规则（重要，别搞错）

| 状态 | 谁写的 | 岗位在表里的表现 | 算今日额度吗 |
|---|---|---|---|
| 池子里 `sent: true` | `lib/state.js` 收到子进程的 `{t:"sent"}` 事件时 | **三个视图都 hide**（获取岗位 / 二次筛选 / 编辑招呼语） | ✅ 算 |
| 记录页一行「已填入到输入框」 | `lib/send.js` 填完就写 | 池子**不动** —— 岗位照旧留在表里、能勾选、能改招呼语 | ❌ 不算 |

- **只有"真发出去了"才标 `sent`**。来源有四种，都汇到同一条路（`{t:"sent"}` → 池子 `sent=true`）：① 子进程自己点发送（confirm/auto）② 用户**在浏览器里手动点**发送 ③ 兜底检测到输入框已清空 ④ agent 再调一次 `/api/send`。
- **"用户手动发"的识别有个窗口**：脚本停在那一行时用 `pollManualSend` 盯着输入框被清空，**约 30 分钟**内识别到才补记「已发送」并标 `sent`（面板日志会标「（你手动点的）」）。**脚本早跑完 / 已退出，之后用户才去点发送 → 不会被标记**，岗位**仍留在表里**。
- **「已填入到输入框」是过渡态**：招呼语只在输入框里、还没发；脚本再跑一次或刷新 BOSS 页面它就没了。所以**填完要尽快在浏览器里点发送**（面板按钮的悬浮提示也是这句）。
- **"隐藏" ≠ "删除"**：标了 `sent` 只是被视图过滤掉；要**真从池子文件里删**得走面板「设置」页的「清理已发送的岗位」按钮（`POST /api/collected/clear-sent`，会先备份 `.bak`）。想删**指定**的岗位（不限于已发送）用 `POST /api/collected/delete {urls:[...]}` —— 面板「获取岗位」页勾选后点「删除选中的 N 个」就是走它（勾选状态只在页面上、与二筛勾选各独立，别当 `checked` 用）。
- **没有"只补标记"或"只按发送键"的接口**：想让 AI 把已填的那些发出去，只能再调 `POST /api/send`（会**重新**走 点立即沟通 → 填入 → 发送，**真的发消息**）；想补标记目前只能靠上面②③的自动识别。
- 已知局限（后续再改）：窗口外的"手动发送"不会被自动标记。

## 常见坑（都来自真实踩过的）

> 本节是**活的文档** —— 每次你踩了新坑、发现反直觉行为、或被用户纠正了，**必须主动追加到本节末尾**。记录格式三段式：
> - **现象**：你看到了什么（报错信息 / 异常行为 / 用户纠正的原话）
> - **根因**：为什么会这样（读代码或看日志得出的真实原因，别瞎猜）
> - **规避/解决**：下次怎么避免、或正确做法是什么
>
> ✅ 记「真实踩过且可能复发」的  ❌ 不记一次性噪音（临时网络、偶发超时等）

- **POST 的 body 不要带 BOM（会静默清空数据）**：body 若以 UTF-8 BOM（`\uFEFF`）开头，服务端 `lib/http.js` 的 `readBody` 直接 `JSON.parse(buf)`（不剥 BOM）会解析失败、被当成**空 body**。后果分两类：
  - 只读/动作类（`/api/send`、`/api/checked`）→ 返回「没有勾选任何岗位」这类**误导性错误**；
  - **写回类（`/api/knowledge`、`/api/config`、`/api/prompt`）→ 把空对象直接写进文件，等于静默清空用户数据**（真实事故：带 BOM 的 `/api/knowledge` 把整份知识库覆盖成 `{}`），而且**照样返回 `{"ok":true}`** —— 别被 ok 骗了。
  **规避**：用 Node `fetch` + `JSON.stringify` 拼 body（天然无 BOM）；必须"先写文件再 POST"时，用**无 BOM 的 UTF-8**（PowerShell：`[IO.File]::WriteAllText($p,$s,(New-Object Text.UTF8Encoding $false))`，**别用** `[Text.Encoding]::UTF8`）；**并且写回后一定回读核对**。
- **遇到「已有任务在跑（pid xxx）」先别硬重试**：多半是**上一个任务的保活进程**还没退 —— 任务干完后会进入"保持浏览器开着"的等待（非 CDP 模式最长 1 小时），期间进程仍活着。先确认那是不是一个已干完活的只读/保活进程；必要时让用户在面板点「停止」或「关闭浏览器」，再重新发起（别反复触发新任务）。
- **面板开着时不要用命令行直接跑 `greet.js`**：会和面板发起的任务抢浏览器锁，且面板看不到进度/结果。一律走 `http://127.0.0.1:7788` 的接口。
- **clone 开源版后「目录不全」跑不了——八成是忘了装依赖**
  - **现象**：用户说"git clone 下来直接用，结果用不了 / 没 node_modules / 没 .chrome-profile / 跑 server.js 报找不到模块"
  - **根因**：`node_modules/`、`.chrome-profile/`、`.workbuddy/`、`.screenshots/` 这几个目录**全都在 `.gitignore` 里**，不会被 git 追踪。clone 下来只有源码文件（server.js / greet.js / routes/ / lib/ / public/ 等）
  - **规避/解决**：**Windows 用户双击 `启动.bat` 就会自动装依赖（`npm install`），全程不用碰命令行**。如果用命令行启动或其他系统，手动跑 `npm install → node server.js`。`.chrome-profile/` 会在首次浏览器自动化时自动创建（会让用户扫码登录 BOSS）
- **BOSS 把登录态踢掉后继续跑 = 白跑**
  - **现象**：用户没登录就启动脚本 → BOSS 跳登录页 → 用户关了登录页 → 脚本继续执行 → 爬到的全是空壳（JD 不全、活跃度空）
  - **根因**：两个竞态：① BOSS 弹新 tab 登录，用户关的是新 tab 但 `rt.page` 还指向原 tab，原 tab bodyLen 可能还 > 300（缓存），`ensureLogin` 误判为已登录；② 爬取中途 BOSS 风控踢掉登录态，collect 循环里原来完全不查登录态，继续跑完但所有岗位数据都是阉割版
  - **规避/解决**：① `ensureLogin` 加了 URL 闸门 —— 必须真的离开 `/web/user/` 等登录路径才判定可能已登录；② `isKickedToLogin()` 双路径检测在 `collect.js` 的两个关键位置：**goto 后用快速路径**（只查 URL，不查 bodyLen —— 页面还没加载完 bodyLen 小会误判，自己踩过）；**每个 job 前用严格路径**（URL + bodyLen + 登录入口三重检测，此时页面已稳定渲染完）。被踢就 emit `kicked-login` 事件 + 面板警告 + 中止流程

- **面板「关闭浏览器」点了没反应（`closed:false`）而 Chrome 还活着**
  - **现象**：面板顶栏点「关闭浏览器」→ 接口返回 `{"ok":true,"closed":false}`，那个自动化 Chrome 继续跑、9222 端口还在
  - **根因**：`runner.js` 的 `killKeptBrowser()` 和 `chrome-kill.js` 的 `killChromeUsingProfile()` 都是「写一个 `logs/_kill-*.ps1` 再 `powershell -File` 执行」，脚本用 `writeFileSync(p, script, 'utf8')` 写出**无 BOM** 的 UTF-8。而 **PowerShell 5.1 读无 BOM 的 `.ps1` 时按系统 ANSI 代码页解码**（中文 Windows = GBK），项目路径只要含中文（如 `D:\...\求职助手\.chrome-profile`），`$prof` 整串变乱码 → `.Contains($prof)` 永远匹配不上 → **静默杀 0 个进程**（不报错、返回 0）。英文路径不触发，所以长期没暴露
  - **规避/解决**：这两个 `.ps1` 必须写成**带 UTF-8 BOM**（`fs.writeFileSync(psFile, '\uFEFF' + script, 'utf8')`）。实测：无 BOM 匹配到 0 个 chrome 进程，带 BOM 匹配到 8 个。⚠️ 别和「HTTP 写回接口的 body 绝不能带 BOM」搞反 —— 判据是**"谁来读这个文件"**：HTTP body 走 `JSON.parse`（怕 BOM，带了会静默清空数据）；PowerShell 5.1 读脚本走 ANSI（缺 BOM 就乱码）

- **面板任务改走 CDP 常驻浏览器（2026-10-16 起，认这个行为别当 bug）**
  - **现象**：面板发起的任务现在都带 `--use-cdp`；日志里出现「复用已在运行的调试 Chrome」「复用已有的 BOSS 标签页（下一轮就地翻页）」「浏览器已是热的（复用来的），跳过预热」；**每次跑任务都会复用同一个浏览器窗口和同一个标签页，只换页面内容**
  - **根因**：为了让"再爬一次"不再关掉浏览器又重开（费时、且像机器行为），`lib/runner.js` 给面板 spawn 的参数统一加了 `--use-cdp`；`lib/browser-session.js` 的 CDP 分支改为「复用已有 BOSS 标签页 + 收尾不关页面 + 只发 `browser-kept` 事件」。Chrome 是 detached（`--remote-debugging-port` + `unref`）起的，**node 进程退出浏览器不死**，所以任务结束后子进程直接退出，**不再有 1 小时保活**（保活只存在于命令行/独立模式）
  - **规避/解决**：① 「填进输入框、还没点发送」的招呼语会被下一轮的原地翻页冲掉 —— 想在窗口里手动补发送，就**先把这一批发完再开下一轮**；② 「关闭浏览器」现在没有子进程可发 CLOSE，改走 `killKeptBrowser()`（所以上面那条 BOM 修复是它的前提）；③ 命令行手敲 `node greet.js` 仍是独立模式（自己起浏览器），会和常驻的调试 Chrome 抢同一个 profile —— **面板开着时别混用**；④ 想回到旧行为：去掉 `--use-cdp` 即走独立模式

## HTTP 接口速查（本地 7788）

> 「agent 可用性」列标明 agent 能调的范围（这就是本工作台开放给 agent 的全部接口权限）。

| 接口 | 用途 | agent 可用性 |
|---|---|---|
| `GET /api/bootstrap` | 首屏全量（config / 知识库 / 状态 / 候选池） | ✅ 读 |
| `GET /api/collected` | 候选池；**每条带 `checked` 字段（用户过二筛勾选）—— 任务 B 只写 checked:true 的** | ✅ 读 |
| `POST /api/collected/delete` | 删除指定岗位 `{urls:[...]}`（面板「获取岗位」页勾选删除走它；先备份 `.bak`） | ✅ |
| `POST /api/collected/clear-sent` | 清理已发送岗位（先备份 `.bak`；面板在「设置」页） | ✅ |
| `POST /api/collected/clear` | 清空候选池（先备份 `.bak`；**无面板入口**，仅 agent 可用） | ✅（无 UI 入口） |
| `POST /api/checked` | 勾选同步（面板自动同步；任务 B 智能二筛用它勾选 `{urls:[...]}`） | ✅ |
| `GET /api/events` | SSE 事件流（面板实时更新用） | ⚠️ 一般不用 |
| `POST /api/collect` | 爬取岗位（见任务 C） | ✅ |
| `POST /api/expects` | 读「意向页签」方向列表（配合 source=expect） | ✅ |
| `POST /api/greetings` | **写回招呼语** `{items:[{url, greeting}]}` | ✅ |
| `GET /api/knowledge` | 读知识库 | ✅ 读 |
| `POST /api/knowledge` | 写回知识库（body = 完整 knowledge.json；**必须回读核对**） | ✅ |
| `GET /api/prompt` | 读招呼语提示词（`prompts/greeting.md`） | ✅ 读 |
| `POST /api/prompt` | 写回招呼语提示词（**必须回读核对**） | ✅ |
| `GET /api/config` | 读配置（城市 / 投递方向 / 经验档位 / 爬取节奏等） | ✅ 读 |
| `POST /api/config` | 写回配置（**必须回读核对**） | ✅ |
| `POST /api/send` | 发送（`fillOnly` 只填不发；`confirm` 真发；`auto` 禁用） | ⚠️ 仅 `fillOnly`，且需用户明确同意 |
| `POST /api/stop` | 停止当前任务 | ✅ |
| `POST /api/pause` | 暂停当前任务 | ✅ |
| `POST /api/resume` | 继续当前任务 | ✅ |
| `POST /api/close-browser` | 关闭自动化浏览器 | ✅ |
| `GET /api/records` | 记录统计（爬取 / 发送 / 填入输入框） | ✅ 读 |

> —— 接口权限说明 ——
> ① 所有接口只受理本机来源（Host / Origin 白名单：仅 `127.0.0.1` / `localhost`，命令行调不受影响）；
> ② **唯一硬门禁是 `mode:"auto"`**：服务端强制 `userApproved:true`，该字段只有用户本人在面板确认弹窗才会带上，agent 传了也会被 403 拒 —— 发送权永远在用户手里；
> ③ 写回类（`/api/knowledge`、`/api/config`、`/api/prompt`）调完必须**回读核对**（见铁律 5）；
> ④ 上表只覆盖 HTTP 接口。**文件层**agent 还能直接读写 `knowledge.json`、`logs/last-collect.json`、`prompts/*`、`config.json` —— 改动前一样要先经用户确认。

## 排查

- 报错先看 `logs/run-*.log` 最新一个文件（同时对比终端输出）
- 面板打不开 → 服务没跑：`node server.js`；改过 `server.js` 必须重启才生效
- 浏览器自动化异常 → 可能有残留浏览器占着 profile，等几秒重试
