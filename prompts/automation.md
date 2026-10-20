# 无人值守自动化 runbook —— prompts/automation.md

> 给 AI agent 用：**定时任务 / 批量投递**这类没人盯着的场景，按本文件从采集一路跑到发送和报告。
> 常规会话（用户边聊边操作）按 `AGENTS.md` 的任务 A/B/C；**只有自动化任务读本文件**。
> 铁律仍然全部生效：默认只填不发、agent 禁 `mode:"auto"`、只写真实信息、一律走 HTTP API、写回类接口调完回读核对。

## 建任务前：先问齐，再动手（硬性前置）

本 runbook 是**通用模板**，但每个用户的个性化维度不同 —— 用户一说"给我弄个自动化/定时投递"，**先把下面这些问到答案，再建任务；不许带着疑问操作，也不许边跑边问**（完整清单与"常见默认值"见 `prompts/collaboration.md` 的「开跑前必问清单」）：

城市 / 关键词（沿用 config 还是覆盖）/ 来源组合与各源名额（`search` / `recommend` / `expect` / `fav`）/ 初筛筛选（求职类型 · 经验 · 学历 · 规模 · 融资 —— **三来源共用一份**）/ 岗位性质（只实习·实习+全职·只全职）/ 硬性筛选（活跃度·双休·薪资·行业）/ 排除项 / 匹配宽松度（海投·精选）/ 每轮与每日数量额度 / **发送模式**（`fillOnly` 或 `confirm`）/ 是否需在发送前过目招呼语 / 调度时间与频率（cron 5 字段；一次性定点不支持）/ 报告方式。

- 先 `GET /api/config` 把现有默认值摆给用户看，逐项确认"沿用默认"还是"本任务覆盖"。
- 选 `confirm` 时必须拿到用户"已授权无人直发、招呼语不用过目"的**明确答复**，否则退回 `fillOnly`。
- expect 源的城市（意向页签后缀）≠ 目标城市时，让用户决定：改 BOSS 简历期望城市，还是本轮不跑 expect。
- 问齐后建议先跑一轮小批量 `fillOnly` 探测实验验证链路，再正式建定时任务。

## 0. 前置检查（每次开跑先做，任一不满足就停）

| 检查 | 怎么查 | 不满足怎么办 |
|---|---|---|
| 服务在跑 | `GET http://127.0.0.1:7788/api/bootstrap` 通 | 让用户双击 `启动.bat` / 跑 `node server.js`；**不要**改走命令行 `greet.js` |
| BOSS 登录态 | 跑采集时观察是否 emit `kicked-login` | 被踢就中止并把原因写进报告（不要在未登录时硬跑，会爬回一堆空壳） |
| 额度 | `GET /api/config`（`dailyCap`/`dailyCollectCap`）+ `GET /api/records` | 今日剩余为 0 → 本轮直接收工，不采集、不发送（平台侧每天最多发 150 条；脚本遇到平台额度提示会自动读出数字，剩 0 立即停） |
| 参数 | 读 `data/config.json`：`cityCode`/`cityName`、`experience`、`keywords`、`sourceFilters` | 城市/关键词以配置为准；**不要在任务里写死城市**，也先不要用 `POST /api/config` 改它（会覆盖用户设置） |

## 1. 一筛：采集（四来源可选，按目标总量**分批连采到够**）

**开跑前先跟用户定「本轮目标总量」**（例 10 / 30 / 100）。单次采集量受 `config.maxJobsPerRun` 与服务端硬上限约束，目标大于单次上限时要**分批连采**；这样把「采集」和后面的「筛选 / 写招呼语 / 发送」解耦 —— **先把量采够，再统一处理**，别边采边筛：

```text
剩余 = 目标总量
while 剩余 > 0:
    本轮名额 = min(剩余, config.maxJobsPerRun)
    把本轮名额按来源分配（示例 search 4 / recommend 3 / expect 3，按比例缩放；收藏源一般另跑，见 ④）
    依次 collect(search) → waitIdle → collect(recommend) → waitIdle → collect(expect) → waitIdle（收藏源按需再加一轮 collect(fav)）
    每批后 GET /api/collected，按 url 去重算「本轮新增」→ 剩余 -= 新增
# 采够后停，进入第 2 节统一筛选
```

- 目标量小（≤ 单次上限）时，上面就是**一轮**，不必循环。
- **每批之间必须 `waitIdle`**（单实例锁，并发会报「已有任务在跑」）；一批跑完再开下一批。
- **全部采集完成后才做第 2 节**：二筛要拿完整候选池才能去重 / 排序 / 分级（例：目标 100 = 10 批 × 10 个采完，再一次性筛）。
- 几个来源互不重复、能提高覆盖；收藏源由用户自己挑进收藏，按需单独跑。

### ① 搜索源 `search`
```
POST /api/collect
{ "source": "search", "keywords": ["<config.keywords 里的词>"], "maxJobs": 4, "cityCode": "<config>", "cityName": "<config>" }
```
- `keywords` 来自 `config.keywords`（服务端**硬钳制**只取前 10 个，超出静默截断）；多个关键词串行。
- 严格按面板城市（URL city 参数）定位。

### ② 推荐源 `recommend`
```
POST /api/collect { "source": "recommend", "maxJobs": 3, "cityCode": "<config>", "cityName": "<config>" }
```
- **噪声大**：没有源头过滤 —— **跑完必须复看，人工/AI 剔除明显非技术岗**（会漏进维修学徒 / 施工员之类）。

### ③ 意向源 `expect`
```
POST /api/expects { "force": true }                  # ① 先强制刷新拿到真实页签（无 force 走缓存，会回放过期列表）
POST /api/collect { "source": "expect", "expectTab": "<页签名>", "maxJobs": 3,
                    "cityCode": "<目标城市code>", "cityName": "<目标城市>" }   # ② 传城市以覆盖 config 城市
```
- **页签名必须与 BOSS 实际页签逐字一致（含全角/半角括号）**：缓存里可能是半角 `xxx(A市)`、BOSS 实际渲染全角 `xxx（A市）` → 逐字比较失败、0 结果。真实页签以刷新后写入的 `logs/expects-cache.json` 的 `tabs` 数组为准。
- **传 `cityCode`/`cityName` 可覆盖 config 城市**（config 城市 A、传目标城市 B 时，expect 正常返回 B 的岗位）—— 这让"面板城市 ≠ 页签城市"不再必然冲突，但**页签自身的城市仍必须是目标城市**（页签来自 BOSS 简历期望城市，改不了）。
- ⚠️ **城市硬约束**：expect 的岗位来自 **BOSS 简历里的期望城市**，采集端用城市参数过滤地域。页签后缀（如 `（北京）`）与目标城市不符时，非该城市岗位会被全数丢弃（页签城市 ≠ 目标城市时几乎无新增）。→ 页签不是目标城市的选择时提醒用户去 BOSS 改简历期望城市。

### ④ 收藏源 `fav`（可选，按需单独跑）
```
POST /api/collect { "source": "fav", "maxJobs": 3 }
```
- **固定收藏页 URL，不套面板城市 / 经验档位 / 源头筛选** —— 收藏是用户自己衡量后加进去的，采集端一个门槛都不套；代价是**会返回多城岗位**（收藏里有外地岗也原样保留）。要限定城市请在二筛本地过滤。
- **不传 `cityCode` / `cityName` 也无所谓**（它压根不吃）；`experience` 同样不吃。
- **分页按需**：收藏页每页 15 条、页面不显示分页控件也不懒加载，采集端按「还差多少个新的」自动改 URL 的 `page=N` 逐页翻，**够了就停**（不遍历所有页）；某页一张卡片都没有 = 翻到底；上限 5 页兜底。
- **收藏岗默认过二筛**：这批新进池的收藏岗会自动打标 `src:'fav'`（面板岗位名前带「★」）并由服务端**自动勾选**——agent 对它们**不要重判匹配度**（视同已过二筛），但**招呼语照常写**；第 2 节用 `POST /api/checked` 提交勾选时是**整体替换**，必须把收藏岗 url **一并带上**，否则会被挤掉。

### 采集中几个要点
- **初筛筛选（源头过滤）**：`config.experience`（经验要求，**可多选**，如 `108` 在校生 / `108,102` 在校生+应届）+ `config.sourceFilters`（求职类型 / 学历 / 规模 / 融资）—— 这几项**三来源共用一份**（改一处，search / recommend / expect 同步；切来源不变）；**收藏源一个都不吃**。
- **加载深度按需**：单次"爬 N 个"就是「要拿到 N 个**新的**（不在候选池里的）」—— 搜索 / 推荐 / 意向按缺口滚动、收藏按缺口翻页，**够了就停**，不会把每页都遍历完。所以同一关键词重复跑时，已在池里的岗位不占名额、会继续往深了找。
- **数量约束别当固定常量**：`maxJobsPerRun`（每轮上限）、`dailyCollectCap`（每日采集上限）、`dailyCap`（每日发送上限）都在 `data/config.json`，**以实际 config 为准**；服务端另有内部硬钳制（单次请求量、关键词条数超上限会被静默压回）。本文出现的 10 / 80 / 60 等都只是**默认示例**。
- **节奏**：采集是浏览器自动化，一轮几十秒到几分钟。**一轮跑完先 `GET /api/collected` 看结果再开下一轮**，不要并发重复触发（会撞单实例锁，报「已有任务在跑」）。

## 2. 二筛：系统判据复刻 + AI 匹配（**等全部采集完成后**统一做）

> 上游已把量采够，这一步一次性处理**整个候选池**：机械判据过一遍 + AI 按 `data/knowledge.json` 分级勾选，**勾选结果一次性写回**。

面板的「二次筛选」是**纯前端**过滤（`public/js/render.js` 的 `visibleCands`），无人值守时**浏览器里没人点控件**，所以过滤规则必须由 agent 在本地复刻。判据如下（数据全在 `GET /api/collected` 的每条岗位里）：

| 维度 | 判据 |
|---|---|
| 活跃度 | **互斥档：选哪档只看哪档，各档之间互不包含**（唯一例外：「今日活跃」与「在线」合成一档）。今日活跃 = `在线\|刚刚活跃\|今日活跃`；3日内 = `1~3日内活跃`；本周 = `本周活跃\|1周内活跃\|4~7日内活跃`；半年内 = `2周及以上周内活跃\|8日及以上日内活跃\|本月活跃\|N月内活跃\|近期活跃\|近半年活跃\|半年内活跃\|半年前活跃`。没被任何档覆盖的文案（如「一周内活跃」）不落档，只在「不限」下出现。复刻 `public/js/render.js` 的 `ACTIVE_TIERS` |
| 双休 | `daysPerWeek` ∈ 1..5 → 有双休；≥6 → 无；`0`（没爬到）只在「不限」下出现 |
| 薪资下限 | `salaryDaily(工资文本)`：带「天/日」直接取区间均值；月薪（含 K/千/万）先折月薪再 `/22`。解析不出返回 0 → **不受限** |
| 行业 | `industry` 子串包含匹配 |

**AI 匹配（读 `data/knowledge.json` 当标尺）**：
- 标尺 = `profile.identity` + `skills` + `entries`，但**别当严格审核**：扫一眼 JD，**和用户背景沾边就够**（例：用户是计算机相关，岗位是测试 / 运营 / 产品类实习，就算够格），**不要求技能栈逐条对上、不要求全部符合**。
- **分级（海投场景）**：明显不匹配才排除（行业/岗位性质冲突、只要全职、硬性条件如到岗/天数明确不满足、薪资离谱）；**沾边就勾** —— 机会比完美匹配重要，宁可多勾让用户划掉，不要替用户把门。
- 结合用户画像剔掉明确跑偏的方向（与**用户求职主线**无关的方向；主线由用户在开跑前确认）；**用户点名排除过的方向必须遵守**。

**勾选写回**：`POST /api/checked { "urls": [...匹配项 url...] }`（面板实时同步）。
- 只处理「没勾选、没发送」（`checked:false` 且无 `sent`）的岗位；已 `sent` 的不用管。

## 3. 写招呼语（可**分批**，每批 N 条）

> 勾选是整批的，但招呼语可一批一批写：每批取 N 个已勾选岗位，逐条按 JD 定制后 `POST /api/greetings`。分批只为控制单次 body 体积、缩小失败影响面；写回是同步的，**批间不需要 waitIdle**。

1. 读 `prompts/greeting.md`（**以文件最新内容为准**，用户可能改过）—— 里面是生成规则 + 红线 + 写回方式。
2. **只为已勾选（`checked:true`）的岗位写**，未勾选的不动。
3. 逐条按 JD 定制：两条调换岗位还能用 = 不合格；≤130 字符；只写知识库里真实有的信息，**禁编造**。
4. 写回：`POST /api/greetings { "items": [ { "url": "<岗位 url>", "greeting": "<正文>" } ] }`（面板实时刷新）。
5. ⚠️ **数字/范围类事实（项目个数、代码行数、实习月数、并发数）必须回 `data/knowledge.json` 的 `entries` 逐条核对，不要从 `profile.identity` 的概括句直接取** —— 曾出现过：`profile` 概括句写"两个全栈项目…公网部署上线"，但 `entries` 明细里实际只有一个，照抄概括句导致招呼语失实（已发出的消息撤不回，只能靠后续轮次修正）。

## 4. 发送（可**分批**）

> 拿已勾选且有招呼语的岗位拼 `items`；量大时分批发，**每批 ≤ 单次上限、批间 `waitIdle`**。发送模式与护栏见下。

```
POST /api/send
{ "items": [ {"url":"...", "job":"...", "company":"...", "greeting":"...", "jd":"..."} ],
  "mode": "fillOnly" }
```
- `items` 从 `GET /api/collected` 里**取已勾选的岗位**拼装（带上 greeting）。
- `mode`：
  - **`fillOnly`（默认、最稳）** —— 只填进输入框，绝不点发送键；适合"用户随后自己在浏览器里发"。
  - **`confirm`** —— **会真的逐条点发送键、直接发给 HR**（`routes/send.js` 给 confirm/auto 传的参数一样，不存在"停下等你确认"）。**仅在用户已明确授权、且招呼语已给用户过目确认后**才用；无人值守任务若用户已授权直发，可用它。
  - **`auto`** —— agent **永远不调**（服务端强制 `userApproved:true`，只有用户本人面板确认才带，agent 传了被 403）。
- **护栏**：单次发送有服务端硬上限（默认示例 60，**以实际为准**）+ 按今日剩余额度截断（响应里返回 `capped`/`remaining`，如实写进报告）。**量大时分批发**：每批 ≤ 单次上限，批间 `waitIdle`。
- 发送**真消耗投递机会**；confirm 会真的发消息，调用前务必确认授权范围。

## 5. 收尾：报告 + 异常中止

**报告至少含**：本轮各来源新增数 → 二筛后勾选数 → 写招呼语数 → 发送成功/跳过/失败数 → 今日已用/上限 → 被跳过岗位的原因摘要。

**命中以下任一条件立即中止**（不要硬重试，把原因写进报告）：
- 被踢登录（`kicked-login`）
- 今日额度用尽（发送/采集）
- 已有任务在跑（单实例锁，报 `已有任务在跑（pid xxx）`）—— 多半是上一个任务的保活/Cdp 残留，先确认它是不是已干完活的只读进程，必要时让用户面板点「停止」「关闭 BOSS」再重来。
- 服务未启动

## 已知硬约束（复述，务必记住）

1. **expect 城市冲突**：见 1.③。
2. **recommend 噪声大**：见 1.②。
3. **前端筛选是纯前端**：无人值守必须在本地复刻判据（见第 2 节）。
4. **面板任务走 CDP 常驻浏览器**：复用同一个 Chrome + 同一个 BOSS 标签页，每轮只原地翻页 → **上一轮「只填不发」的内容会被下一轮翻页冲掉**；要用窗口手动补发，就先把这一批发完再开下一轮。
5. **「手动发送」识别窗口约 30 分钟**：脚本退出后再去点发送不会被标记 `sent`，岗位仍留在表里。
6. **写回类接口（`/api/knowledge`、`/api/config`、`/api/prompt`）body 绝不能带 BOM**，且调完**必须 GET 回读核对**（返回 `ok` 不代表写成功）。
7. **expect 页签会变、缓存会过期**：新页签不会自动进缓存，且页签名括号全/半角不统一（见 1.③）→ 跑 expect 前先 `POST /api/expects {force:true}` 刷新，从 `logs/expects-cache.json` 取真实页签名。
8. **收藏源 `fav` 不吃城市 / 经验 / 筛选**：固定收藏页 URL，会返回多城岗位（见 1.④）；分页按需、每页 15 条，要限定城市请在二筛本地过滤。

## 参考：分批流水线的调用骨架

> **量小（目标 ≤ 单次上限）时，每个阶段就是一轮，"循环"退化成单次**；量大时按 `while` 连采到够、再统一筛、分批写、分批发。
> `waitIdle` = 每批之间先等上一轮任务跑完（单实例锁，并发会报「已有任务在跑」）。

```text
# 阶段 1：采集（循环到够）—— 目标总量由用户开跑前定
GET  /api/bootstrap / GET /api/config / GET /api/records      # 前置检查：服务在跑 / 额度 / 配置
POST /api/expects {force:true}                                # 只有要跑 expect 源时才需要；刷新后从 logs/expects-cache.json 取真实页签名
while 剩余 > 0:
    本轮名额 = min(剩余, config.maxJobsPerRun)                 # 再按来源分配（示例 search 4 / recommend 3 / expect 3；收藏按需另跑）
    POST /api/collect {source:search,    keywords:[...], maxJobs:N, cityCode, cityName} → waitIdle
    POST /api/collect {source:recommend, maxJobs:N, cityCode, cityName}                 → waitIdle
    POST /api/collect {source:expect, expectTab:"<真实页签名>", maxJobs:N, cityCode, cityName} → waitIdle
    # 可选：POST /api/collect {source:fav, maxJobs:N} → waitIdle   # 只爬「我的收藏」（不吃城市/经验/筛选，可能返回多城）
    GET  /api/collected                                       # 按 url 去重算「本轮新增」→ 剩余 -= 新增

# 阶段 2：统一筛选（等全部采集完成后一次性做）
GET  /api/collected                                           # 拿完整候选池
（本地复刻系统判据 + AI 按 data/knowledge.json 分级勾选）
POST /api/checked {urls:[...]}                                # 勾选结果一次性写回

# 阶段 3：写招呼语（可分批，批间不需 waitIdle）
for batch in 已勾选:
    读 prompts/greeting.md → 逐条按 JD 定制 → POST /api/greetings {items:[{url,greeting}, ...]}

# 阶段 4：发送（可分批，批间 waitIdle）
for batch in 已勾选且有招呼语:
    GET /api/collected → 拼 items
    POST /api/send {items:[...], mode:"fillOnly"} → waitIdle   # 已授权无人直发才用 "confirm"
```
