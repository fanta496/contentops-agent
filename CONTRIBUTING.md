# 贡献指南

## 开始之前

请先阅读 `docs/TECHNICAL_HANDOFF.md`、`docs/ARCHITECTURE_AND_IMPLEMENTATION.md` 和 `docs/VIBE_CODING_HANDOFF.md`。当前项目是 Windows 本地工作流，不要把平台验证码绕过、账号盗用、隐私数据采集或密钥硬编码作为贡献内容。

## 修改规则

1. 先说明要改变的状态、API、失败恢复和人工闸门。
2. 文本、视觉、生图供应商差异放到 `ai/` 适配器，不散落到业务路由。
3. 采集器必须保持低频、可暂停、可恢复，不绕过验证码。
4. 新字段要更新默认状态、归一化、持久化恢复、前端显示和测试。
5. 重复点击、请求超时、服务重启、总控停止和缺少 Key 都要有明确结果。

## 本地检查

```powershell
node --check app.js
node --check server.cjs
.\launcher\build.ps1
$env:CONTENTOPS_CARD_RENDERER = (Resolve-Path .\launcher\bin\CardRenderer.exe)
node server.cjs --self-test
```

按修改范围运行 `qa/` 中的专项测试。不要把正式 `%APPDATA%\ContentOpsAgentV2`、Chrome profile、企业素材或真实导出目录用作测试目录。

## 提交前检查

- 没有 API Key、Cookie、访问令牌、真实链接或企业数据。
- 没有把 `state.json`、`state.backup.json`、`server.lock.json` 或 `runtime-config.json` 提交进仓库。
- 文档中的版本、能力边界和测试命令与代码一致。
- 若发布预构建本体，已在干净 Windows 环境重建、核验哈希，并作为 GitHub Release 附件上传。
