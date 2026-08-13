# 图文内容增长 Agent 技术交接文档

> 适用读者：后端、前端、自动化、运维工程师
>
> 当前版本：1.4.6（内容生命周期与二做闭环版）
>
> 核验日期：2026-08-11

## 0. 先读这段

本文描述当前工作区源码的真实实现，不等同于产品规划。文中使用以下标记：

- **已确认**：已从源码、交付 README、测试或运行检查中确认。
- **外部依赖**：需要企业账号、Chrome 登录态、模型供应商或平台页面正常。
- **未验收边界**：代码存在适配，但尚未宣称完成真人生产验收。

当前最重要的边界是：小红书公开图文抓取、文本/视觉分析、一做、生图、人工发布后的“小红书创作者后台”二次分析已经有代码闭环；抖音目前有公开图文抓取、分析和一做适配，但抖音真人页面与 24 小时压力验收未完成，抖音发布后的创作者后台二次分析未接入。验收前必须保持抖音自动模式关闭。

不要把 API Key、Cookie、企业真实素材、真实状态文件提交到 Git 或写进本文档。

## 1. 交接检查清单

接手人第一次接管时，按顺序完成：

1. 阅读本文件、`VIBE_CODING_HANDOFF.md`、`ARCHITECTURE_AND_IMPLEMENTATION.md` 和 `USER_GUIDE.md`。
2. 在仓库根目录开发，不要在预构建运行包内直接修改代码。
3. 执行 `node --check app.js`、`node --check server.cjs` 和 `.\launcher\build.ps1`。
4. 运行无外部写入的服务自检：`$env:CONTENTOPS_CARD_RENDERER = (Resolve-Path .\launcher\bin\CardRenderer.exe); node server.cjs --self-test`。
5. 运行与本次修改直接相关的 `qa\*.mjs`，再运行一组集成测试。
6. 用 `GET http://127.0.0.1:17851/health` 确认当前服务的 `root` 指向目标目录。
7. 若要发布 Windows 本体，在独立的干净目录组装、验收并生成 SHA-256；不要将本体写入 Git 历史。

## 2. 目录和职责

```text
源码根目录/
├─ app.js                         原生 JS 单页工作台与交互
├─ index.html                     页面骨架、导航、表单容器
├─ styles.css                     工作台样式
├─ server.cjs                     本地 HTTP 服务、状态、工作流、API
├─ ai/
│  ├─ openai-compatible.cjs       文本模型适配
│  ├─ vision-compatible.cjs       视觉模型适配
│  ├─ image-compatible.cjs        生图与参考图适配
│  └─ prompts.cjs                 提示词和结构化输出约束
├─ collector/
│  ├─ xiaohongshu.cjs             小红书公开图文采集
│  ├─ douyin.cjs                  抖音公开图文采集
│  ├─ xhs-creator-center.cjs      小红书创作者后台数据读取
│  ├─ chrome-session.cjs          专用 Chrome 会话/登录态
│  └─ chrome-runtime.cjs          Chrome 路径发现与进程运行时
├─ launcher/
│  ├─ ContentOpsLauncher.cs       启动器源码
│  ├─ ContentOpsWatchdog.cs       看门狗源码
│  ├─ CardRenderer.cs             离线图卡渲染器源码
│  └─ build.ps1                   Windows 辅助程序构建脚本
├─ qa/                             单元、集成、恢复和安全边界测试
└─ docs/                           技术、使用和维护文档
```

Windows 运行包不属于源码仓库。若发布者提供预构建附件，其中不应包含 `qa`、开发夹具、真实状态或登录资料。

## 3. 运行拓扑

- 前端和本地 API：`http://127.0.0.1:17851/`。
- 源码运行时：Node.js 18 或更高版本。
- 开发启动入口：`node server.cjs`。
- Windows 辅助程序：`launcher\build.ps1` 构建 `CardRenderer.exe`、`图文爆款Agent.exe` 和 `ContentOpsWatchdog-v2.exe`。
- 看门狗：`ContentOpsWatchdog-v2.exe` 只监控当前包 root 的后台。
- UI 专用 Chrome profile 默认在 `%LOCALAPPDATA%\ContentOpsAgentV2\ChromeProfile`。
- 小红书采集 profile 默认在 `%APPDATA%\ContentOpsAgentV2\browser-profiles\xiaohongshu`。
- 抖音采集 profile 默认在 `%APPDATA%\ContentOpsAgentV2\browser-profiles\douyin`。

预构建运行包的启动脚本会向下最多搜索两层完整包，要求同一目录存在 `runtime\node.exe` 和 `server.cjs`。发现多个包时会拒绝猜测。启动前会调用关闭脚本安全清理已确认属于 ContentOps 的旧版本 watchdog、launcher 和 Node backend，然后检查 17851 的健康服务 root 是否属于当前包。

关闭脚本只终止 root、命令行和 lock 文件都能确认属于 ContentOps 的进程；不会关闭用户其他 Chrome 或其他 Node 服务。`-KeepRoot` 只供版本接管使用，会保留专用 Chrome 登录态。

### 环境变量

| 变量 | 用途 | 默认值 |
|---|---|---|
| `CONTENTOPS_DATA_DIR` | 业务状态、锁、凭据索引和资产目录 | `%APPDATA%\ContentOpsAgentV2` |
| `CONTENTOPS_XHS_PROFILE_DIR` | 小红书采集 Chrome profile | 数据目录下 `browser-profiles\xiaohongshu` |
| `CONTENTOPS_DOUYIN_PROFILE_DIR` | 抖音采集 Chrome profile | 数据目录下 `browser-profiles\douyin` |
| `CONTENTOPS_UI_PROFILE_DIR` | 工作台 Chrome profile | `%LOCALAPPDATA%\ContentOpsAgentV2\ChromeProfile` |
| `CONTENTOPS_CHROME_PATH` | 临时指定 `chrome.exe` | 自动发现 |
| `CONTENTOPS_PORT` | 本地服务端口 | `17851`（自检为 `17832`） |
| `CONTENTOPS_COLLECTOR_ERROR_DIR` | 采集技术错误存档 | 数据目录下 `collector-errors` |

首次启动会按环境变量、已保存路径、注册表、Program Files 和用户目录查找 Chrome；找不到时显示已检查路径和文件选择，不会静默猜错。发现路径会写入 `runtime-config.json`。

## 4. 持久化、凭据和恢复

默认数据目录为 `%APPDATA%\ContentOpsAgentV2`：

```text
state.json                 当前业务状态
state.backup.json          上一个有效状态备份
server.lock.json           单实例和服务 root 证明
generated-images\          生图结果文件
enterprise-assets\         企业素材原图
profiles\                  模型连接档案元数据
browser-profiles\         平台专用 Chrome 资料
runtime-config.json        Chrome 等运行时发现结果
collector-errors\         采集技术错误
```

状态通过临时文件、原子替换和双备份写入。启动时会校验并归一化状态；主状态损坏时可从备份恢复。服务退出时，处于 `queued` 或 `running` 的生图任务会标为 `interrupted`，保留已完成页供人工重试，不会伪装为完成。

API Key 由当前 Windows 用户加密保存，Key 不写入 `state.json`，也不由 API 返回到前端。不要复制整个 `%APPDATA%\ContentOpsAgentV2` 给其他人；迁移应由企业重新录入 Key 和登录态。

## 5. 状态模型和生命周期

`initialState()` 的顶层主要字段：

- `settings`：平台、模型档案、预算、并发、采样和图片规则。
- `agents`：`orchestrator`、`supervisor`、`xhs-collector`、`douyin-collector`、`analyst`、`creator`、`data-agent` 的心跳与状态。
- `candidates`：采集和分析后的候选；常见状态为 `new`、`selected`、`generated`、`ignored`。
- `variants`：一做、二做和生图页；通过 `parentVariantId` 建立二做关系。
- `publications`：人工发布登记和二次分析绑定。
- `materials`、`enterpriseProfiles`：成功素材和企业资料库。
- `workflowRuns`、`activity`：运行记录和审计事件。

1.4.6 的页面分流规则：候选页只显示 `new`、`selected`；一做待生产页只显示仍待生产的 `selected` 候选；一做和二做成品进入“已生产内容库”；已登记但尚无后台快照的发布内容仍保留在“分析与二做”。

工作流步骤固定为：

```text
collect → analyze → select → create → publish → performance → scale
```

`select`、`create` 的人工编辑、生图确认、`publish` 和 `scale` 是人工闸门。自动模式只执行可自动执行的阶段，遇到闸门安全暂停。

## 6. 总控、并发、重试和幂等

- `POST /api/master/start` 开启人工总控；`POST /api/master/stop` 关闭人工总控。
- 停止时递增 `masterGeneration`。在途任务在写回结果前校验 generation，停止后不会把旧结果写回状态。
- 自动调度只有在 `masterEnabled && workflowAutoEnabled` 时运行；默认早、晚两个时段由设置决定。
- 采集器按平台 key 串行锁定，公开抓取、链接导入、创作者后台和登录检查不能并行抢同一个专用 Chrome。
- 分析默认并发 3；生图页默认并发 4，实际仍受供应商限流和预算约束。
- 文本分析、策划和图片任务各有自动重试次数；超时会保留结构化错误，可人工重试，不要求整条工作流重来。
- 生成接口有任务锁和重复点击保护；重新打开页面会从 `imageJob`、`imagePages` 读取现状。
- 预算、每日候选、每日分析和每日生图有熔断；失败不会偷偷扣除未发生的调用。

## 7. AI 适配边界

### 文本模型

文件：`ai/openai-compatible.cjs`、`ai/prompts.cjs`。

连接档案保存 Base URL、模型名、Key、价格和预算。默认请求 OpenAI-compatible `/v1/chat/completions`，要求 `response_format: { type: 'json_object' }`，并校验返回内容可解析为 JSON。供应商切换应通过新建/测试/激活连接档案完成，不要在业务代码中写供应商特例。

### 视觉模型

文件：`ai/vision-compatible.cjs`。

支持 chat completions 图片输入和 Responses `/responses`。小红书、抖音图片只允许经过 allow-list 的公开 CDN URL，禁止把任意用户输入 URL 当代理请求，避免 SSRF 风险。候选分析顺序为“文本模型初析 → 逐图视觉拆解 → 文本模型综合复审”。视觉不可用时工作流阻塞，不伪造分析结果。

### 生图模型

文件：`ai/image-compatible.cjs`。

- 文生图：`/images/generations`。
- 参考图 JSON 模式：把 `image` 数组以 base64 data URL 放入 generations JSON，适配支持该协议的供应商。
- 标准编辑模式：multipart `/images/edits`。
- 响应支持 `b64_json`、`base64` 和 HTTPS URL。
- URL 下载仅接受 HTTPS，拒绝内网地址，限制 25 MB，并校验 PNG/JPEG/WebP 文件头。

工作台提示词在人工确认后逐字发送；企业图片是否附带由 `imageReferencePolicy` / `imageInputMode` 决定，不在后端偷偷追加创作要求。生成文件按实际格式保存，不把 JPEG 或 WebP 伪装成 PNG。

## 8. 采集器和二次分析

### 小红书公开图文

`collector/xiaohongshu.cjs` 使用专用 Chrome 和人工登录态，搜索关键词、滚动、读取详情，保存标题、作者、正文、话题、发布时间、图片引用和公开互动快照。视频、无图、低相关、低互动和详情残缺内容会过滤。遇验证码、登录失效或结构不识别时暂停并告警；详情连接超时最多恢复 2 次。

### 抖音公开图文

`collector/douyin.cjs` 支持公开图文采集和单条链接导入，并过滤视频、无图和残缺内容。当前真人页面和 24 小时压力验收未完成；不要因为离线夹具测试通过就开启自动模式。

### 小红书创作者后台

`collector/xhs-creator-center.cjs` 通过专用 Chrome 读取可见的“数据看板 → 内容分析 → 笔记数据”表，不逆向后台 API。发布后登记笔记链接和实际发布时间，按笔记 ID 或“标题 + 时间”匹配；标题歧义拒绝写入。默认采样节点为 2、24、72 小时。只有真实后台观察节点才允许触发二做；人工补录仅作兜底，不直接触发二做。

## 9. 主要 API 路由

接口实现都在 `server.cjs`。完整参数以源码校验为准，下面按领域列出稳定入口：

| 领域 | 路由 |
|---|---|
| 模型档案 | `/api/model-profile/save`、`/api/model-profile/test`、`/api/model-profile/activate` |
| 旧兼容入口 | `/api/ai/credential/save`、`/api/ai/test`、`/api/vision/credential/save`、`/api/vision/test` |
| 总控工作流 | `/api/master/start`、`/api/master/stop`、`/api/workflow/run`、`/api/workflow/resume`、`/api/workflow/pause-auto` |
| 采集 | `/api/collection/run`、`/api/collector/xhs/open-login`、`/api/collector/xhs/probe`、`/api/collector/douyin/open-login`、`/api/source/add` |
| 候选和一做 | `/api/candidate/status`、`/api/candidate/analyze`、`/api/candidate/delete`、`/api/candidate/cleanup`、`/api/variant/generate`、`/api/variant/status`、`/api/variant/update`、`/api/variant/image/generate`、`/api/variant/export`、`/api/variant/delete`、`/api/variant/cleanup` |
| 企业素材库 | `/api/enterprise-profile/save`、`/api/enterprise-profile/export`、`/api/enterprise-profile/activate`、`/api/enterprise-profile/archive`、`/api/enterprise-profile/restore`、`/api/enterprise-image/upload`、`/api/enterprise-image/delete` |
| 发布和二做 | `/api/metrics/save`、`/api/collector/xhs-creator/open-login`、`/api/performance/collect`、`/api/variant/scale`、`/api/agent/restart` |
| 运维 | `/api/state`、`/api/collector/status`、`/api/supervisor/inspect`、`/api/data/reset`、`/health` |

对外调用只绑定本机 loopback；没有远程管理 API。若要接入飞书，当前实现是单向 Webhook 告警；双向命令需要另行创建飞书应用并设计鉴权，不能假设 Webhook 已具备管理能力。

## 10. 测试和发布

### 静态检查

```powershell
node --check app.js
node --check server.cjs
```

### 关键自检

```powershell
.\launcher\build.ps1
$env:CONTENTOPS_CARD_RENDERER = (Resolve-Path .\launcher\bin\CardRenderer.exe)
node server.cjs --self-test
node qa\validate.mjs
node qa\workflow-v2-integration.mjs
node qa\first-creation-workbench.mjs
node qa\creator-center-performance.mjs
CONTENTOPS_QA_PRODUCT=1 node qa\v146-content-lifecycle.mjs
node qa\reliability.mjs
node qa\recovery.mjs
node qa\watchdog.mjs
node qa\v2-isolation.mjs
```

按修改范围补跑：

- 企业图片和导出：`enterprise-image-library.mjs`、`enterprise-library-export.mjs`、`enterprise-production-guard.mjs`、`enterprise-reference-image-flow.mjs`。
- 生图：`generations-reference-json.mjs`、`image-reference-policy.mjs`、`image-page-concurrency.mjs`、`generated-image-lifecycle.mjs`、`image-text-freedom.mjs`。
- 总控和停止：`master-control.mjs`、`master-stop-all-stages.mjs`、`inflight-master-stop.mjs`、`single-instance.mjs`。
- 小红书登录/采集：`collector-unit.mjs`、`collector-detail-fixture.mjs`、`collector-integration.mjs`、`chrome-runtime-discovery.mjs`、`chrome-session-recovery.mjs`。

### 交付同步

源码修改后，先完成源码自检；若要发布 Windows 本体，再在独立的干净目录确认 `app.js`、`server.cjs`、`index.html`、`styles.css`、`ai`、`collector` 和启动脚本同步，确保不含 `qa`、真实状态或登录资料。重新生成 SHA-256，再做一次启动、`/health`、关闭和重启后的健康检查。不要只替换一个 `.js` 文件后直接交付。

## 11. 常见故障定位

### 启动提示找不到完整应用包

确认启动 BAT 位于包含 `runtime\node.exe` 和 `server.cjs` 的包内，或最多只隔一、两层外壳目录。不要把 BAT 单独复制到桌面。若发现多个完整包，删除/移开歧义目录后再启动，不要改脚本为全盘搜索。

### 17851 已占用

开发时先停止当前 `node server.cjs` 进程，再访问 `/health`。运行预构建本体时使用其关闭脚本；如果 health 的 `root` 不是当前包，说明旧包仍在运行。不要直接杀所有 `node.exe`。

### 抓取 Page.enable 超时

先在设置页做“检查登录状态”，确认平台专用 Chrome 已登录。采集器会尝试恢复会话，最多恢复 2 次；页面已渲染但导航事件超时会继续读取。连续失败应查看 `collector-errors` 和页面告警，不要把同一任务反复点击几十次。

### AI 连接测试 400/500/502

检查 Base URL 是否是供应商公开的 OpenAI-compatible 根地址、模型名和 Key 是否匹配；连接档案必须测试成功后才能激活。不要为了绕过报错修改业务请求体；先看供应商要求的是 chat、responses、generations 还是 edits。资源不足和渠道不存在属于供应商侧错误，应使用已验证档案或稍后重试。

### 生图任务看似卡住或重复生成

查看一做页面的任务状态、`imageJob` 和服务日志。重新打开页面应恢复状态；已有 `queued/running` 任务受防重保护。任务超时可在设置中调整单图和整任务超时，完成的页面会保留，失败页可单独重试。

### 创作者后台没有数据

确认发布链接、实际发布时间和专用 Chrome 登录态。后台表未出现、标题被截断或同标题歧义时系统会拒绝匹配；这不是可以盲写数据的情况。先检查后台登录和单条读取结果，再等待下一采样节点。

## 12. 明确未完成和禁止事项

- 抖音真人页面和 24 小时压力验收未完成。
- 抖音发布后的创作者后台二次分析未接入。
- 飞书当前不是双向运维控制台。
- 平台验证码、登录保护和服务条款不应被绕过。
- 不要把任意 URL 作为视觉或生图代理地址。
- 不要手改 `state.json`、删除 `server.lock.json` 来“解卡”，也不要把生产数据放进 QA 目录。
- 不要把模型 Key 写进 `app.js`、`server.cjs`、批处理或文档。

接手人如需扩展能力，先在 `ARCHITECTURE_AND_IMPLEMENTATION.md` 中补充状态、权限、失败恢复和测试设计，再改代码。
