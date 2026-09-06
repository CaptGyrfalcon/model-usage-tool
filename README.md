# AI 用量挂件（Cursor + Codex）

> **非官方 / Unofficial.** 本项目与 Cursor、Anysphere、OpenAI 均无隶属关系，也不是它们的官方产品。程序会读取本机 Cursor 登录态并调用未公开文档的账单接口，同时解析本机 Codex 会话文件。接口随时可能失效；使用本工具可能违反相关服务条款，账号存在被限制的风险。请自行判断后再使用。
>
> MIT licensed Windows widget. Not affiliated with Cursor or OpenAI. It reads local session tokens and undocumented billing APIs. Use at your own risk.

一个常驻 Windows 通知区域的 Cursor / Codex 用量小工具。窗口不会占用任务栏位置，点右上角 `×` 只会隐藏；单击通知区域图标可再次显示，右键图标可完全退出。

## 系统要求

- Windows 10 / 11 x64（目前不支持 macOS / Linux）
- [Node.js 22](https://nodejs.org/) 或更高（`node:sqlite`）
- 本机已登录 [Cursor](https://cursor.com)；Codex 用量需要本机有过 Codex 会话

## 启动

双击 `start-widget.bat` 或 `启动挂件.bat`，或在终端运行：

```bash
npm install
npm start
```

请先在 Cursor 中保持登录。Codex 只要在本机使用过即可自动发现。

## 隐私与数据

- **Cursor**：读取本机 `state.vscdb` 中的登录态，调用账单相关接口。刷新后的 access token 可能写入 `%APPDATA%\cursor-usage-widget\session.json`。
- **Codex**：解析 `.codex/sessions` 与 `.codex/archived_sessions` 中的 token 计数、模型、effort 与额度窗口；不读取或保存对话正文。
- **本地历史**：事件去重后写入 `%APPDATA%\cursor-usage-widget\usage-history.sqlite`，不会主动删除。
- **网络**：仅请求 Cursor / OpenAI 的官方接口与价目表，不会把用量上传到其它服务器。
- 界面可开隐私模式，只把邮箱显示成 `****`，套餐名称仍会显示。删除 `%APPDATA%\cursor-usage-widget` 即可清除本应用保存的数据。

漏洞报告方式见 [SECURITY.md](SECURITY.md)。请勿在 Issue 里粘贴 token 或账单截图。

## 数据来源

- **Cursor**：读取本机 Cursor 登录态并调用账单页使用的接口，获得当前额度、逐模型事件、Token 与实际计费金额。
- **Codex**：解析本机 `.codex/sessions` 和 `.codex/archived_sessions` 中的 `token_count`、模型、effort 与额度窗口元数据；若会话记录含服务端响应 `service_tier` 则优先持久化，否则回退到 `logs_2.sqlite` / 本地会话设置中的请求 tier。不读取或保存对话正文。
- **官方价目表**：OpenAI API 与 Cursor 模型价格每天最多自动检查一次，也可点顶栏 `$` 手动更新。
- **本地历史库**：两边的事件都会规范化、去重后写入 `%APPDATA%\cursor-usage-widget\usage-history.sqlite`。历史事件不主动清理，远端以后缩短历史窗口也不会删除已采集的数据。

Codex 会优先采用服务端实际响应的 `service_tier`，本机当前版本未稳定落盘响应值时，使用 `priority`（Fast 请求）或 `default`（普通请求）的本地请求证据。旧版本没有该字段的事件继续显示“速度未知”，不会猜测。为了让趋势、模型汇总和套餐额度反推使用同一口径，Codex 美元等效费用统一以标准美元价乘套餐 credit 倍率计算：GPT-5.6/5.5 Fast 为 2.5×，GPT-5.4 Fast 为 2×。

Cursor 总览将 Cursor Grok 4.6、Grok 4.5、Composer 2.5 归入 Cursor Models 池，第三方模型归入 Other Models 池；两个池分别累计 API 等效用量并按各自已用百分比反推池总额，Other Models 同时保留 Cursor API 返回的官方套餐美元额度。

## 功能

- Cursor 模型 / 其他模型额度池、已用与套餐包含美元额度，以及 Codex 当前额度窗口
- Cursor 与 Codex 的美元等效费用；Codex 总可用美元等效额度由当前窗口使用比例反推并明确标为估算
- Cursor + Codex 今日总 Token、最近调用和本地历史数量
- 默认每 30 秒刷新，可选 15 秒、30 秒、45 秒、1 分钟或 2 分钟
- 首次扫描本地现有 Codex 历史，此后只读取新增日志片段
- 模型用量三档统计及数据源切换：
  - **笼统**：只区分基础模型，合并 Fast 与 thinking effort
  - **速度**：区分标准 / Fast，合并 thinking effort
  - **精确**：标准 / Fast 和每一种 thinking effort 都分别统计
- 模型统计范围下拉菜单：全部历史、近 6 / 3 / 1 个月、近 14 / 7 / 1 天、近 12 / 6 / 1 小时；全部、Cursor、Codex 始终使用同一滚动时间范围
- 持久化新增消耗柱状图：日档按小时，周档按最近 7 天，月档按最近 30 天
- 趋势来源可切换全部 / Cursor / Codex，默认显示总 Token（含缓存），也可切换有效 Token 与美元等效费用
- 柱状图可开启输入 / 缓存输入 / 输出三色堆叠，也可同时叠 Fast / 非 Fast 比例（速度未知计入非 Fast）；Token 和美元费用视图都支持
- 每条事件的输入、缓存、输出费用和价目表版本在首次入库时锁定，之后模型降价不会改写历史成本
- 全屏仪表盘：点击标题栏 `⛶`、通知区域菜单或按 `F11` 进入，按 `Esc` / `F11` 退出；全屏会放大字体、并排展示额度池、展开模型 Token 构成并使用宽屏趋势图
- 极简额度球：Cursor 百分比显示两位小数；额度模式按蓝、绿、黄、橙、红渐变填充，速度模式用绿色 / 泛光橙色区分普通与 Fast 消耗；用量池模式在加宽界面中同时显示 Cursor 模型池、按用量反推容量的 Cursor 三方模型池和 Codex 联合池，球形池体的体积与美元等效容量成正比（水位表示剩余额度），所有文字信息均位于池体下方；拖动窗口时液面会倾斜、回摆并激起浪花，每次成功刷新会播放排水与液面过渡并以四位小数飘出本次美元等效消耗；Codex 以 7 天池为联合容器总容量，5 小时池按各窗口返回的用量比例反推容量后换算到周池，原始 5 小时可用百分比保留两位小数，5 小时可用量与仅周池可用量以双色区分；右侧同时显示 Cursor、Codex 5 小时、Codex 每周的重置时间与耗尽预测
- 隐私模式：只把邮箱显示成 `****`，套餐名称正常显示；支持全局快捷键切换
- 普通/迷你窗口固定置顶并保留任务栏图标；极简额度球固定置顶但隐藏任务栏图标
- 自动识别 2K/4K 显示器并同步放大非全屏窗口与字体，移到不同 DPI 的屏幕时会重新适配
- 迷你模式、极简额度球、透明度、开机启动

## 操作

- 拖动顶栏移动窗口
- 点 `×`：隐藏到通知区域
- 单击通知区域图标：显示 / 隐藏窗口
- 右键窗口或通知区域图标：刷新、置顶、迷你模式、开机启动、打开账单、完全退出
- 模型明细和趋势页：切换全部 / Cursor / Codex
- 顶栏 `$`：立即拉取 OpenAI 与 Cursor 最新官方价目表
- 顶栏 `◉`：进入极简额度球；顶部切换额度 / 速度 / 用量池显示，左右箭头切换池子，`恢复窗口` 返回完整界面
- 顶栏 `⚙`：设置隐私模式
- 全局快捷键：`Ctrl+Alt+U` 显示/隐藏、`Ctrl+Alt+O` 额度球、`Ctrl+Alt+M` 迷你模式、`Ctrl+Alt+P` 隐私模式
- 页面底部：调整自动刷新间隔和透明度

## 测试

```bash
npm test
```

需要 Node.js 22+。Cursor 接口及 Codex 本地日志格式都可能随官方版本调整；采集器对缺失字段做了容错，并始终保留已经写入的历史事件。

开发说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT License](LICENSE)。Cursor、Codex、Windows 等名称属于各自权利人，本项目仅用于指代兼容的产品。
