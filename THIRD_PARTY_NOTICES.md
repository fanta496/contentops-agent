# 第三方声明

本文件说明开源目录中不由本项目原创、但可能随本体包分发或在运行时使用的第三方组件。它不是法律意见；发布到 GitHub 前应由项目权利人按实际分发方式复核供应商和组件的最新许可证。

## Node.js 运行时

若 GitHub Release 提供包含 Node.js 运行时的 Windows 本体，Node.js 及其内置组件有各自的许可证和版权声明，不受本项目 MIT License 单独覆盖。公开发布本体包时，应同时保留 Node.js 官方发行包中的许可证/声明，并以官方页面为准：

- <https://nodejs.org/en/about/legal>
- <https://github.com/nodejs/node/blob/main/LICENSE>

如果不希望分发该二进制，可不上传本体包，只发布源码，并要求用户自行安装兼容的 Node.js 版本；现有 BAT/EXE 本体不能直接运行，需要另行调整启动方式。

## Windows 构建产物

`图文爆款Agent.exe`、`ContentOpsWatchdog-v2.exe` 和 `CardRenderer.exe` 的源码在 `launcher/`，并可通过 `launcher\\build.ps1` 使用 Windows .NET Framework C# 编译器构建。该脚本没有锁定编译器版本、代码签名或逐字节可复现保证，因此预构建文件仍应作为已标注版本的 GitHub Release 附件，而不是作为可复现或已签名构建产物宣传。

## Chrome 与平台页面

程序调用用户本机 Chrome 进行人工登录和页面读取，不捆绑 Chrome。小红书、抖音及其创作者后台的名称、页面、内容和服务条款属于各平台；本项目不声称与这些平台存在官方合作关系。

## AI 供应商

文本、视觉和生图请求通过 OpenAI-compatible 适配器发送到用户自行配置的供应商。供应商的模型、接口、额度、价格、内容政策和返回格式由供应商负责；本项目不包含任何供应商 API Key。

## 测试资产

`qa/fixtures` 中的 HTML 是结构化测试夹具，`qa/*.png` 是历史界面验收截图，不应当被视为当前产品架构或当前 UI 的完整证明。QA 目录中没有随包分发真实账号 Cookie、业务状态或企业素材；若新增夹具，应先确认不存在个人信息和凭据。
