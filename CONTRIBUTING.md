# 参与贡献

感谢你愿意改进这个非官方用量挂件。提交代码即表示你同意以 [MIT License](LICENSE) 授权该贡献，版权声明可保留你的名字。维护者可能在后续版本更换许可证；你提交的代码仍按 MIT 再许可。

## 开发环境

- Windows 10/11 x64
- Node.js 22 或更高（测试依赖 `node:sqlite`）
- 本机已登录 Cursor；Codex 功能需要本机有 `.codex` 会话记录

```bash
npm install
npm start
npm test
```

也可以双击 `start-widget.bat` 或 `启动挂件.bat`。

## 目录

- `src/main.cjs`：Electron 主进程、托盘和窗口
- `src/lib.cjs`：Cursor 鉴权、拉取与汇总
- `src/codex.cjs`：Codex 本地日志解析
- `src/history.cjs`：本地 SQLite 历史库
- `src/renderer/`：界面
- `test/`：`node --test` 用例
- `scripts/audit-local-data.cjs`：开发诊断脚本，会扫描本机 Codex 日志，不要把输出提交进仓库

## 提交前

- 为行为变更补测试，并确保 `npm test` 通过
- 不要提交 `node_modules`、`*.sqlite`、`session.json` 或真实用量数据
- 不要在代码、测试夹具或截图中写入真实 token、邮箱或账单金额
- 说明改了什么、为什么改；接口字段变更请注明 Cursor / Codex 版本线索

## 议题

请先搜现有 Issue。报告 bug 时写清 Windows 版本、Node 版本、Cursor / Codex 是否能复现。不要粘贴访问令牌或完整账单导出。

## 维护者：第一次公开仓库

1. 确认工作区改动已提交，且不含本地数据库或 token。
2. 用 GitHub noreply 邮箱做公开提交，避免 QQ 等个人邮箱出现在 `git log`。
3. 在 GitHub 新建 **Public** 仓库（不要初始化 LICENSE / README，避免和本地冲突）。
4. 添加远程并推送：

   ```bash
   git remote add origin https://github.com/<你的用户名>/cursor-usage-widget.git
   git push -u origin master
   ```

5. 在仓库设置中开启 Issues，并打开 **Settings → Code security → Secret scanning**（若可用）。
6. 把真实仓库地址补进 `package.json` 的 `repository` / `bugs` / `homepage`。
7. 加几张界面截图到 README（不要含邮箱、token 或具体金额；可先开隐私模式）。
8. 给首个提交打 tag，例如 `v1.0.0`。安装包和代码签名可以后补。
