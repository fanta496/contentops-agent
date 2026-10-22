# 架构说明

这份文档只讲"东西在哪、改动会波及哪里"。业务细节看代码注释与 `README.md`。

## 一句话

单进程 Node 服务：一个 HTTP 入口，一个 JSON 状态文件，前端是一个静态页面。没有框架、没有依赖、没有构建步骤（`node server.cjs` 就是全部）。

## 目录

| 路径 | 职责 | 备注 |
| --- | --- | --- |
| `server.cjs` | 进程入口：配置、状态读写、领域逻辑、HTTP 服务、定时调度 | 仍是最大的文件，见下方"剩余债务" |
| `lib/util.cjs` | 无状态工具（文本清洗、数字收敛、本地时间） | 任何模块可直接引用 |
| `lib/media.cjs` | 图片字节识别（PNG/JPEG/WebP） | 纯函数 |
| `lib/state.cjs` | 默认状态、schema 迁移、公开状态投影、进程锁 | 通过 `createStateModule(env)` 注入依赖 |
| `lib/platforms.cjs` | 平台注册表：标签、Agent、开关字段、采集器路径 | 加平台先改这里 |
| `lib/tempo.cjs` | 拟人节奏采样（对数正态） | 采集器里所有等待都走它 |
| `lib/actions/*.cjs` | HTTP 接口处理函数，按业务域分文件 | 由 `server.cjs` 注册成路由表 |
| `collector/*.cjs` | 平台采集器（小红书、抖音、创作后台） | 通过私有管道控制 Chrome |
| `ai/*.cjs` | 模型适配（文本、视觉、生图）、提示词、凭据加密 | 凭据走 DPAPI |
| `launcher/*.cs` | Windows 启动器 / 看门狗 / 图卡渲染器 | 由 `launcher/build.ps1` 用 csc 编译 |
| `tests/*.cjs` | 安全回归、接口行为快照、统一测试入口 | `node tests/run-all.cjs` |

## 请求怎么走

```
浏览器 (index.html + app.js)
  └─ POST /api/<name>  { json }
       └─ server.cjs: http.createServer
            ├─ 主机 / 来源校验（isAllowedHost、origin 白名单）
            ├─ readBody() 读 body
            └─ handleAction(route, body)
                 ├─ 7 条必须留在 server.cjs 的路由（会重新赋值 state / masterGeneration / workflowPromise）
                 └─ actionRoutes.get(route)          ← lib/actions/*.cjs 注册进来的
                      └─ 领域函数 → 改 state → saveState()
```

`GET /api/state` 返回 `publicState()`，它是"能暴露给前端的状态"，凭据一类的字段在这里被剥掉。

## ctx 契约（重要）

`lib/actions/*.cjs` 里的处理函数拿不到 `server.cjs` 的闭包，只能通过 `register(ctx)` 注入的 `ctx`：

- **可以拿**：`state`（getter，永远是当前的）、`saveState`、`addActivity`、`setAgent`、各领域函数、`SELF_TEST`、凭据存储实例。
- **故意不给**：`masterGeneration`、`workflowPromise`、`activeCollectors`。它们是 `server.cjs` 的模块级 `let`，跨模块拿到的是**过期快照**。引用它们的路由必须留在 `server.cjs`（目前是 `/api/source/add`、`/api/variant/scale`）。
- `profileKind` / `activeProfileKey` 是 `handleAction` 里的局部小工具，同样由 `ctx` 提供。

`tests/api-smoke.cjs` 会打到每一条接口，ctx 少给一个依赖会立刻暴露成 500。

## 加一条接口

1. 在 `lib/actions/<域>.cjs` 的 `register()` 返回值里加一项：`'/api/xxx': async (body) => { ... }`。
2. 处理函数第一行需要状态就写 `const state = ctx.state;`，需要别的依赖直接解构 `ctx`。
3. 在 `tests/api-smoke.cjs` 的 `STEPS` 里加一条请求，跑 `node tests/api-smoke.cjs --write` 更新基线。

不需要动 `handleAction`，也不会碰到别的域。

## 加一个采集平台

先改 `lib/platforms.cjs` 加一条描述（标签、Agent id、开关字段、关键词字段、采集器路径）。剩下的是这五处：

1. `collector/<平台>.cjs`：实现 `openLogin` / `collect` / `closeBrowser`（`probe` 建议有）。
   `node tests/collector-contract.cjs` 会告诉你缺什么。
2. `server.cjs`：`createXxxCollector` 构造器 + `runCollection` 里的采集分支（其余校验已走注册表）。
3. `lib/state.cjs` 的 `initialState()`：新增 Agent 条目与默认开关、关键词字段。
4. `app.js` + `index.html`：平台开关、关键词输入、状态卡片。
5. `tests/api-smoke.cjs`：新增接口的基线，跑 `--write` 更新。

前四步里，如果只是「已有平台的同类实现」，第 1、5 步是主要工作量；第 3 步容易漏，漏了的表现是新平台开关存不进去。

## 测试

```powershell
node tests/run-all.cjs        # 语法 + 安全回归 + 接口快照 + 离线自检
node tests/api-smoke.cjs --write   # 行为确实要变时，重新生成基线
```

`tests/baseline/api-smoke.json` 是行为契约：重构后如果快照不一致，说明有接口行为被改动了，先解释清楚再更新基线。

基线里做了归一化处理（时间戳、随机 id、端口、绝对路径），所以是稳定可比的。

## 状态与持久化

- 状态文件：`%APPDATA%\ContentOpsAgentV2\state.json`（测试用 `CONTENTOPS_DATA_DIR` 覆盖）。
- 写入路径：`saveState()`（直接存当前 state）/ `commitStateSnapshot(next)`（先用克隆对象算好再一次性提交）。
- `normalizeState()` 在 `lib/state.cjs` 里，**新增字段必须在这里给默认值**，否则旧状态读进来会是 `undefined`。
- 备份：`state.backup.json`，临时文件 `state.tmp.json`，进程锁 `server.lock.json`。

### 为什么 state.cjs 用 `createStateModule(env)` 而不是直接 require

`state` 这个变量本身留在 `server.cjs`（`let state` 会被 `data/reset` 和回滚逻辑重新赋值），模块不持有它，只拿参数。
模块里用到的、但在 `server.cjs` 里声明得比较晚的函数（`hasFeishuWebhook`、`aiReady`、`nextAutomaticRunAt` 等），
在适配层用箭头包一层 `(...args) => fn(...args)` 传进去——**不要改成直接传引用**，那会在启动瞬间踩到 TDZ。
容器类依赖（`imageJobLocks`、`creationJobLocks`）用 thunk，模块里写成 `env.imageJobLocks().size`。

## 采集器（小红书）的三条规矩

改 `collector/xiaohongshu.cjs` 之前先记住这三条，它们都是"降低被判定为自动化"的底线：

1. **取数先看结构化数据，再看 DOM**：搜索页的 `window.__INITIAL_STATE__.search.feeds` 是渲染前的源数据，
   DOM 抓取只作为补充。`searchStateScript()` 结构不认识时返回空数组，DOM 抓取不受影响。
   详情页同理，`detailExtractionScript()` 已经会遍历 `__INITIAL_STATE__` 等状态树找笔记对象。
2. **等的是状态，不是时间**：滚动后不要用固定 `sleep`，要轮询"卡片数有没有增加"，有增长立刻继续，
   没增长才等到原来的上限。上限沿用原配置，所以最坏情况不会比改造前更慢。
3. **节奏走 `lib/tempo.cjs`**：所有等待用 `tempo.actionDelay('betweenScroll'|'afterNavigate'|'reading', baseMs)`，
   对数正态采样、期望值等于 base。固定间隔是自动化最明显的特征。

### 浏览器兼容（Chrome / Edge）

采集器只要求 **Chromium 内核 + 支持 `--remote-debugging-pipe`**，Chrome 和 Edge 都可以用：

- 路径解析顺序：`CONTENTOPS_CHROME_PATH` → `runtime-config.json`（启动器保存的路径）→ 标准安装路径（Chrome、Edge）。
- `runtime-config.json` 不能带 BOM。带 BOM 时 Node 的 `JSON.parse` 会抛错，保存的路径被静默丢弃，
  表现成“选过浏览器却还是报找不到”。启动器已改用 `new UTF8Encoding(false)` 写出，读取侧也做了容错。
- 只认这些可执行文件名：`chrome.exe` / `msedge.exe` / `brave.exe` / `chromium.exe` / `vivaldi.exe`。

## 剩余债务（v2 优先处理）

1. `server.cjs` 仍有约 2100 行：工作流引擎、生图流水线、发布后分析、HTTP 服务都还在里面。
2. `app.js` 1043 行是单文件前端，整个包在一个 IIFE 里，没有模块边界（拆它需要先补前端验收）。
3. 平台相关的分支散落在 5 处（见"加一个采集平台"），没有适配器注册表。
4. 状态是单个 JSON 大对象，候选与版本多了以后读写会变慢。
