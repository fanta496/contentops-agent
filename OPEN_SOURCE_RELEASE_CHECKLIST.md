# GitHub 开源发布检查清单

> 当前目录版本：1.4.6
>
> 本清单核验日期：2026-08-12

## 当前判断

当前目录可以作为个人开发者项目的源码预览、技术交流和本地试用包发布；在点击 GitHub 的正式 Release 前，还要完成“个人权利边界、第三方二进制许可、构建来源和真实环境验收”四项人工确认。

## 已完成

- 已移除没有运行时依赖的 `assets/editing-workflow.jpg`。
- 已排除 API Key、Cookie、企业真实素材、账号状态和浏览器登录资料。
- 已包含源码、QA、四份交接/使用文档、许可证、安全说明和贡献指南。
- 已包含可选的 Windows 本体包和独立源码 ZIP。
- 已生成源码、本体和完整目录的 SHA-256 清单。
- 本体 `server.cjs --self-test`、源码语法检查和本体内部哈希已通过。

## 发布前必须人工确认

### 1. 个人权利人和许可证

- `LICENSE` 使用项目名 `ContentOps Agent Project`，不要求公开开发者实名；如需证明权利，可由开发者私下保留创作记录、提交记录和交付记录。
- 确认公开目录中的源码、提示词、测试夹具、截图和二进制均属于可公开内容。
- 确认源码、提示词、测试夹具、截图和二进制均有权公开。
- 确认企业素材、平台页面截图和第三方图片没有被误放入 Git 历史。

### 2. Node.js 和二进制

- `release/成品/runtime/node.exe` 是 Node.js v24.16.0 二进制，公开分发前保留 Node.js 官方许可证和声明，并复核 Node.js 官方分发条款。
- `图文爆款Agent.exe`、`ContentOpsWatchdog-v2.exe` 和 `CardRenderer.exe` 可由 `launcher\\build.ps1` 使用 Windows .NET Framework C# 编译器构建；当前仍未锁定编译器版本、代码签名和逐字节可复现性。
- 若追求可复现开源，应补充目标框架、SDK/编译器版本、代码签名和产物哈希；在此之前把这些 EXE 作为“预构建可选附件”，不要宣称逐字节可复现或已签名。

### 3. 真实环境验收

- 在干净 Windows 虚拟机解压 `release/成品`，完成启动、Chrome 路径发现、`/health`、停止和重启验收。
- 使用测试账号和测试 Key 做最小小红书采集、文本/视觉连接测试和一做流程。
- 不要把企业正式账号、Cookie 或 Key 作为公开复现步骤。
- 抖音真人页面、抖音 24 小时压力和抖音发布后二次分析仍是未完成边界，必须保持说明一致。

### 4. GitHub 仓库卫生

- 新建 Git 仓库后再提交，不要把桌面工作目录现有的未知 Git 历史直接推送。
- 提交前运行 `git diff --cached --name-only` 和敏感信息扫描。
- 不要把 `release/` 本体 ZIP 强行塞进 Git 历史；建议作为 GitHub Release 附件发布。
- 运行 CI：语法检查、服务自检和不需要真实账号的 QA。
- 为每个 Release 发布源码提交哈希、本体 ZIP SHA-256 和已知限制。

## 推荐的公开结构

```text
GitHub 仓库：源码、ai、collector、launcher、qa、docs、LICENSE、README
GitHub Release：Windows 本体 ZIP、源码 ZIP、SHA-256、第三方声明
```

公开仓库应把“代码可读性”和“企业本体下载”分开，避免用户误以为下载本体就获得企业 Key、登录态或平台权限。
