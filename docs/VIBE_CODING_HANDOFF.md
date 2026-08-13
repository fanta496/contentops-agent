# 图文内容增长 Agent 通俗交接文档

> 适用读者：会看代码、能运行 Node，但不一定熟悉后端、浏览器自动化或 AI 接口的接手人
>
> 当前版本：1.4.6（内容生命周期与二做闭环版）
>
> 核验日期：2026-08-11

## 1. 先用一句话理解它

这不是一个“让大模型自己乱点网页”的程序，而是一台本地工作流机器：确定性脚本负责抓页面、存数据、调接口和写文件；模型负责理解文本、看图、起草内容和写生图提示词；人在选款、确认、审核和发布处把关。

流程可以记成：

```text
抓公开图文 → 过滤低质量 → AI 分析 → 人工选款 → 一做文案/提示词
→ 人工确认生图 → 人工审核/导出/发布 → 读取小红书后台数据 → 二做
```

“Agent”是总管和各模块协作的工作流，不等于模型会凭空知道账号、素材库或平台页面。登录、Key、企业资料和人工闸门都必须真实存在。

## 2. 四个文件夹先认清

- 根目录源码：你开发和测试的地方。
- `ai`：三种模型连接的翻译层。供应商变化优先改这里，不要把供应商判断散落到业务代码。
- `collector`：浏览器采集器。它们使用专用 Chrome 登录态，不负责绕验证码。
- `launcher`：Windows 启动器、看门狗和离线图卡渲染器源码；先运行 `build.ps1` 再做完整自检。

最常改的页面文件是 `app.js`、`index.html`、`styles.css`；最核心的后端是 `server.cjs`。先看 `server.cjs` 的路由，再看前端对应的 `fetch('/api/...')`，不要只改按钮文字。

## 3. 开发时最重要的十条规矩

1. 不要直接改 `%APPDATA%\ContentOpsAgentV2\state.json`。它是运行结果，不是配置源码；要改状态必须通过 UI 或 API。
2. 不要把 Key、Cookie、真实链接、企业产品机密写进代码、测试夹具或文档。
3. 不要把 `qa` 目录、Chrome profile、状态目录放进 Git 仓库或预构建本体。
4. 前端改动要同步 `app.js`、`index.html`、`styles.css`；后端和适配器也要完整同步。
5. 每次改完先运行 `node --check app.js` 和 `node --check server.cjs`。
6. 修改状态结构时，同时更新默认值、归一化逻辑、备份恢复逻辑和相关测试。
7. 加一个按钮时，必须同时想清楚：正在运行时能不能点、重复点会不会重复请求、失败后怎么重试、停止总控后会不会写回旧结果。
8. 新模型供应商先放到连接档案和适配器里；不要在页面里硬编码某家供应商的 URL 或模型名。
9. 涉及图片时要考虑返回 URL、`b64_json`、`base64` 三种形式，以及 PNG/JPEG/WebP 的真实文件头。
10. 测试通过前不要封装，也不要用“本机能打开”代替健康检查和链路测试。

## 4. 每次新增功能的实际步骤

### 第一步：先写清楚状态

问自己：这个功能产生什么数据？数据放在 `settings`、`candidates`、`variants`、`publications`、`materials` 还是新字段？状态有哪些值？程序重启后要不要保留？任务中途停止后能不能恢复？

例如新增一个图片页状态，不能只在页面加一个“生成中”字样；它至少要能落到 `imageJob` / `imagePages`，这样刷新页面和后台重启后才知道是否完成。

### 第二步：写后端合同

在 `server.cjs` 中加入路由、输入校验、权限/闸门检查、幂等键、状态写入和错误结构。先让无模型、无登录的 QA 能测试“拒绝条件”和“成功状态”，再接外部 API。

### 第三步：接前端

在 `app.js` 加请求函数、加载状态、成功状态、错误状态和重试入口；在 `index.html` 只放结构，在 `styles.css` 处理布局。不要只在 catch 中 `console.error`，用户必须看到下一步该做什么。

### 第四步：加失败恢复

明确哪些失败只重试当前页、哪些失败暂停整步、哪些失败需要人工登录。一次 API 超时不应该让整条工作流从抓取重新开始。总控 stop 后，在途任务必须检查 generation。

### 第五步：写 QA

至少覆盖：正常、重复点击、空输入、缺配置、接口超时、服务重启、总控停止、恢复后继续、旧状态兼容。把测试数据放临时 QA 数据目录，不要碰正式 `%APPDATA%`。

### 第六步：构建并验证

开发目录通过后，运行 `.\launcher\build.ps1`，设置 `CONTENTOPS_CARD_RENDERER` 指向生成的 `CardRenderer.exe`，执行 `node server.cjs --self-test`。若另行发布 Windows 本体，在干净目录组装、访问 `/health`、启动和关闭一次，最后生成 SHA-256 清单。

## 5. 用大白话看关键模块

### `server.cjs`

它是“总电闸 + 仓库 + API + 调度器”。启动时加载状态，收到前端请求，调用采集器或 AI 适配器，写回状态。这里最容易出现“页面看着完成、实际没保存”的问题，所以任何新流程都要确认写入后再次读取。

### `app.js`

它是工作台，不应该自己决定业务真相。页面显示以 `/api/state` 返回为准；不要在前端用一个临时布尔值假装任务完成。总控台大约每 3 秒同步运行态。

### `ai/*.cjs`

它们是“插头转换器”。文本、视觉、生图分别配置、测试、激活。供应商返回结构不一样时，在对应适配器归一化成内部结果，业务层不要到处写 `if (tuzi)`、`if (deepseek)`。

### `collector/*.cjs`

它们是“浏览器工具”，不是模型 Agent。总管决定什么时候调用、关键词是什么、失败怎么办；采集器只在允许的页面和 Chrome profile 内执行。登录失效、验证码和结构变化应暂停并告警。

### `launcher` 和脚本

它们解决“怎么找到正确包、只关闭自己的进程、后台崩了如何拉起”。不要改成 `Stop-Process -Name node` 这种全局粗暴命令，会误伤同事电脑上的其他服务。

## 6. 如何验证你真的改对了

先静态检查：

```powershell
node --check app.js
node --check server.cjs
```

再跑服务自检和对应测试：

```powershell
.\launcher\build.ps1
$env:CONTENTOPS_CARD_RENDERER = (Resolve-Path .\launcher\bin\CardRenderer.exe)
node server.cjs --self-test
node qa\validate.mjs
node qa\workflow-v2-integration.mjs
```

如果改的是一做/生图，再补跑：

```powershell
node qa\first-creation-workbench.mjs
node qa\enterprise-reference-image-flow.mjs
node qa\generations-reference-json.mjs
node qa\image-reference-policy.mjs
node qa\generated-image-lifecycle.mjs
```

如果改的是企业库，再跑：

```powershell
node qa\enterprise-image-library.mjs
node qa\enterprise-library-export.mjs
node qa\enterprise-production-guard.mjs
```

如果改的是总控/停止，再跑：

```powershell
node qa\master-control.mjs
node qa\master-stop-all-stages.mjs
node qa\inflight-master-stop.mjs
node qa\single-instance.mjs
```

## 7. 预构建本体为何会“明明有代码却是旧版本”

源码仓库和预构建本体是两份产物。用户运行的是本体，不是仓库根目录的 `app.js`。最稳妥的发布动作是：

1. 停止运行中的当前包。
2. 在新目录组装全部源码对应文件和运行时，不复制状态、Key、Cookie、Chrome profile 或 QA 输出。
3. 确认本体没有旧的重复文件或两个完整包嵌套。
4. 用本体内的 Node 运行 `server.cjs --self-test`。
5. 双击本体启动 BAT，访问 `http://127.0.0.1:17851/health`。
6. 双击本体关闭 BAT，确认 health 不再返回当前服务。
7. 更新 SHA-256 清单并记录版本、日期和测试结果。

不要只把新 `server.cjs` 拷进去；前端、AI、采集器和脚本也可能必须同步。

## 8. 出问题时先问三件事

1. **这是程序错误，还是外部条件不满足？** 例如 Key 资源不足、Chrome 未登录、平台验证码，不要先改代码。
2. **状态有没有写入？** 看 UI、`/api/state` 和运行日志，不要只看浏览器页面。
3. **能否只重试当前阶段？** 生图失败通常重试页，后台数据未匹配通常重新登录/读取，不应删掉整库重来。

## 9. 不要对接手人隐瞒的边界

- 抖音真人页面和 24 小时压力验收仍未完成。
- 抖音发布后二次分析未接入。
- 飞书当前主要是单向 Webhook 告警。
- 公开页面会变化，采集器不是永久稳定的 API。
- 模型供应商兼容的是约定的 OpenAI-compatible 形态，具体模型能力、限流和返回格式仍以供应商文档为准。

接手人如果无法确认某个事实，应先标注“未验证”，运行最小可复现测试，再改代码；不要用猜测补齐系统行为。
