# 构建与验证说明

> 当前版本：1.4.6
>
> 核验日期：2026-08-13

本项目由个人开发者独立维护，以个人知识和 Vibe Coding 方式实现，并以个人项目形式开源。公开时不要求在仓库中暴露个人实名。

## 源码运行时

业务源码只使用 Node.js 内置模块，没有 `package.json` 或第三方 Node 依赖安装步骤。开发机需要 Node.js 18 或更高版本；本地自检：

```powershell
node --check app.js
node --check server.cjs
.\launcher\build.ps1
$env:CONTENTOPS_CARD_RENDERER = (Resolve-Path .\launcher\bin\CardRenderer.exe)
node server.cjs --self-test
```

`server.cjs --self-test` 使用隔离的临时状态目录，不应写入正式 `%APPDATA%\ContentOpsAgentV2`。它会导出离线图卡，因此需要由构建脚本生成的 `CardRenderer.exe`；CI 显式传入该路径，不依赖预构建运行包。

## Windows 启动器

`launcher\build.ps1` 使用 Windows .NET Framework 4.x 的 C# 编译器，在 `launcher\bin` 生成 `CardRenderer.exe`、`图文爆款Agent.exe` 和 `ContentOpsWatchdog-v2.exe`。构建产物已被 `.gitignore` 排除，不写入 Git 历史。

当前构建脚本不锁定编译器版本，也不包含代码签名或逐字节可复现保证。因此本版本可以：

- 阅读、修改和验证 JavaScript/采集器/适配器源码；
- 构建三个 Windows 辅助程序并用 `CardRenderer.exe` 完成隔离自检；
- 使用 `server.cjs --self-test` 做跨环境基础验证。

本版本不能诚实地宣称三个 EXE 可逐字节复现或已签名。若需要正式企业发布，应补充 SDK/编译器锁定、代码签名、产物哈希和干净 Windows 验收。

## QA 目录说明

`qa/` 中部分历史集成脚本按完整运行包路径寻找本体，并依赖 Windows Chrome/平台夹具。它们适合在完整开发工作区或发布附件中运行，不应被 GitHub CI 当作无条件的跨环境测试。

公开 CI 只执行不依赖账号、Chrome 和本地成品目录的检查。需要运行交付包专项 QA 时，请在完整工作区执行，并使用独立临时数据目录。

## 运行包发布

推荐把源码提交到 GitHub 仓库，把可选本体 ZIP、SHA-256 清单和第三方声明作为 GitHub Release 附件，不把运行时或 ZIP 写入 Git 历史。发布前必须阅读 `OPEN_SOURCE_RELEASE_CHECKLIST.md` 和 `THIRD_PARTY_NOTICES.md`。
