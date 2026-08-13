# 图文内容增长 Agent

当前版本：1.4.6（内容生命周期与二做闭环版）  
整理日期：2026-08-11

这是一个 Windows 本地运行的图文内容工作流：公开图文采集、低质量过滤、文本/视觉分析、人工选款、一做、生图、人工审核、导出、发布后的数据观察和受控二做。

本项目由个人开发者独立维护，以个人知识和 Vibe Coding 方式实现，并以个人项目形式开源。公开时不要求披露开发者实名。

## 目录

- 根目录源码：`server.cjs`、`app.js`、`index.html`、`styles.css`。
- `ai/`：文本、视觉、生图的 OpenAI-compatible 适配器。
- `collector/`：小红书、抖音公开图文和小红书创作者后台采集器。
- `launcher/`：Windows 启动器、看门狗、图卡渲染器源码和本地构建脚本。
- `assets/`：当前版本预留目录；本版本没有运行必需的业务资产。
- `qa/`：无真实账号依赖的测试脚本和静态夹具。
- `docs/`：技术交接、Vibe Coding 交接、完整架构和员工使用教程。

## 源码运行

开发机需要 Windows 和 Node.js 18 或更高版本。运行：

```powershell
node server.cjs
```

工作台默认地址为：

`http://127.0.0.1:17851/`

实际采集还需要本机 Chrome、人工完成的平台登录、模型供应商 Key 和企业素材库资料。平台验证码、登录保护和服务条款不绕过。

预构建 Windows 本体不提交到 Git 历史；若发布者提供了附件，请从 GitHub Releases 下载，并按其 SHA-256 清单核验。

## 当前能力边界

- 小红书公开图文抓取、文本/视觉分析、一做、生图、小红书创作者后台二次分析有代码闭环。
- 抖音目前有公开图文采集、分析和一做适配；真人页面、24 小时压力验收和抖音发布后二次分析尚未完成。验收前保持抖音自动模式关闭。
- 平台验证码、登录保护和服务条款不绕过；采集只针对允许读取的公开内容和企业自有后台。

## 开发检查

```powershell
node --check app.js
node --check server.cjs
.\launcher\build.ps1
$env:CONTENTOPS_CARD_RENDERER = (Resolve-Path .\launcher\bin\CardRenderer.exe)
node server.cjs --self-test
```

CI 运行上述语法检查、Windows 启动器构建和隔离自检。`qa/` 中部分脚本需要 Chrome、预构建本体或平台夹具，按修改范围在完整 Windows 环境运行。真实 Key、Cookie、状态文件、企业素材和 Chrome profile 不应进入仓库。

## 文档入口

- [技术交接](docs/TECHNICAL_HANDOFF.md)
- [通俗 Vibe Coding 交接](docs/VIBE_CODING_HANDOFF.md)
- [架构与实现](docs/ARCHITECTURE_AND_IMPLEMENTATION.md)
- [员工使用教程](docs/USER_GUIDE.md)
- [贡献指南](CONTRIBUTING.md)
- [安全说明](SECURITY.md)
- [开源发布检查清单](OPEN_SOURCE_RELEASE_CHECKLIST.md)
- [构建与验证说明](BUILDING.md)

## 许可证

本项目源码使用 MIT License，第三方运行时和依赖不自动继承本项目许可证；详见 `LICENSE` 和 `THIRD_PARTY_NOTICES.md`。
