# 安全说明

本项目会读取本机 Cursor 登录态，并在本地保存用量历史。请不要在 Issue、Pull Request 或截图里粘贴 token、Cookie、账单明细或 `session.json`。

## 数据如何存放

- Cursor 登录态来自本机 Cursor 的 `state.vscdb`，本应用只读取，不修改该文件。
- 刷新后的 access token 可能明文写入 `%APPDATA%\cursor-usage-widget\session.json`。
- 用量事件写入 `%APPDATA%\cursor-usage-widget\usage-history.sqlite`。
- Codex 只解析会话元数据和 token 计数，不读取或保存对话正文。
- 除 Cursor / OpenAI 的官方接口和价目表外，用量数据不会上传到第三方。

卸载或停止使用时，可删除 `%APPDATA%\cursor-usage-widget` 目录以清除本应用保存的本地数据。

## 报告漏洞

请不要公开开 Issue 描述可利用的漏洞。通过 GitHub 仓库的 Security Advisory，或给维护者发私信。请包含：

- 受影响版本或提交
- 复现步骤（不要附带真实 token）
- 预期影响

我们会尽快确认，并在修复发布后公开摘要。
