# 新渠道 / agent 接入指南

本文件由根目录 `AGENTS.md` 自动指引给后续智能体。适用于新增或补齐客户端、
agent、订阅、API 平台的数据源；“接入完成”意味着下方功能矩阵都经过判断和验证。

## 先确定能力和计量口径

选择稳定的 `source`（例如 `devin`），与模型供应商区分：Devin 使用 Claude 的请求
仍属于 Devin 来源。核对官方文档、当前安装版本和实际脱敏字段，记录时间、单位、
Token 是否包含缓存、响应拆分 / 重试 / fork 去重方式。优先使用官方只读 API 和
本机已登录凭据；不要发起模型任务、修改订阅或替用户生成新密钥来验证接入。

必须分别确定这三项，不能共用一个“费用”字段：

| 口径 | 用途 | 数据要求 |
|---|---|---|
| 模型原价 / API 等值 | 模型统计、环状图、费用趋势、小票 | Token × 官方模型原价，保存价格快照；缺少请求标价时仍可按官方原价计算 |
| 实際账单 | 实收展示、余额、对账 | 明确来自账单的金额、原币、时间粒度、来源；不能拿订阅费或充值代替消费 |
| 订阅额度消耗 | 百分比、水位、额度球、耗尽预测、任务栏 | 优先使用服务端实际百分比 / 余额；免费或优惠请求按实际消耗，不能用原价等值扣减 |

免费活动：模型原价等值保持非零；实际额度在免费期间为零消耗。优惠结束后跟随
服务端实际数据，不靠在客户端硬编码一个截止日期切换水位。若确有逐请求实收或
额度费用证据，再保存相应字段；没有证据则保持未知。官方没有单列的缓存写入价格
如需估算，应标明采用的假设，不能冒充官方缓存写入费率。

账户级额度包含其他设备和产品。本机 Token 仅能说明本机请求，不能把两者差值
无条件分摊到本机。ACU、credits、Token、美元和人民币必须分别显示；`-1` 等
无限 / 非计费哨兵不能转成负余额，也不能把缺字段显示成零。

## 数据流和规范事件

`采集器 → lib.fetchSnapshot → UsageHistory → worker / IPC → renderer`。
模型、趋势、明细、小票和导出都必须读取同一历史库，避免另建只用于卡片的统计。

- 采集器放在 `src/<source>.cjs`；显式支持默认目录和环境变量覆盖，只读原数据。
- 事件至少提供 `source,eventKey,timestamp,model,input,output,cacheRead,cacheWrite,count`。
  `input` 是不含读 / 写缓存的普通输入；总 Token 为四项相加。
- `effort`、`fast`、`fastKnown` 必须由当时请求证据决定，不使用当前设置或费用反猜。
  默认速度未知；界面允许按既有规则在部分图表合入 non-fast，但原证据仍保留。
- `eventKey` 要能跨刷新、重复响应、fork、归档、重试稳定去重。继承历史不能再次累计，
  真正重试不能被合并。不把可增长的 token 总量或采样时间当作请求 ID。
- 优先读取请求实际模型，不能把会话最后选中的模型覆盖会话中所有请求。
- 价格由 `pricing.cjs` 处理，事件首次记录的价格快照锁定。新增未计价模型可补算；
  更改已锁定历史价格必须专门设计迁移、备份和回归，不能顺手整库重算。
- `UsageHistory.upsertEvents` 保存事件；`saveQuotaSample` / `saveBalanceSample` 保存真实
  采样。缓存回放保留原时间，不造新点，不覆盖真实历史，不删除远端已过期的事件。
- SQLite 结构变更要兼容老库、幂等，更新事件读写和导出；不能只新增列而遗漏读出。
- 后台结果只传必要的规范字段；密钥、原响应、邮箱和对话正文不写入事件。

## 功能矩阵：每个接入任务都必须检查

| 功能 | 主要文件 / 接入点 | 完成条件 |
|---|---|---|
| 采集、鉴权、错误与缓存 | `src/<source>.cjs` | 时间限额、受信官方域、禁止凭据重定向、匿名错误、账号隔离、读取失败保留历史 |
| 主快照与单源启动 | `src/lib.cjs` 的 `fetchSnapshot` | `Promise.allSettled`、来源对象、`sourceStatus`、全部来源不可用判断；新渠道单独可用时能启动 |
| 总览、首屏剩余环 | `renderer/index.html`, `renderer/app.js` | 卡片、真实套餐、今日 / 30 天 Token、费用口径、剩余环、点击跳详情、空 / 缓存 / 失败 / 过期状态 |
| 汇总与最近请求 | `lib.cjs` 的 `combined`, `sources`, `lastEventFromHistory` | 新事件计入总量且只计一次，单源及全部总数一致，来源名称正确 |
| 模型笼统 / 速度 / 精确统计 | `lib.cjs` 的 `buildModelUsage`, `getModelUsage`, `sourceView`, `buildModelBreakdowns` | 各范围、来源过滤、模型 / effort 展示及三档分组保持总量 |
| 模型环状图 | `renderer/app.js`, `usage-charts.js`, `model-display.js` | 总 / 有效 Token、美元等值都支持；未计价不能当免费、未知速度保留证据 |
| Token / 费用趋势 | `lib.cjs` 的 `getTrendUsage`, `buildTrendSeries`, `trendBundle`; `renderer/app.js` | 默认 / 自定义范围和来源过滤，输入 / 缓存 / 输出及速度 / 模型拆分一致 |
| 请求明细与搜索 | `history.cjs`, `renderer/app.js`, `index.html` | 来源按钮、模型 / effort 搜索、分页、原单位 / 估算 / 官方汇总标签 |
| 完整 CSV / JSON 导出 | `main.cjs` 的来源白名单, `event-export.cjs`, `history.cjs` | 当前来源和搜索条件；全部记录、快照一致、CSV 公式防护、失败保留原文件 |
| 日 / 周 / 月 / 年账单小票与 PNG | `receipt.cjs`, `receipt-model.js`, `receipt.js`, `receipt-render-task.js`, `receipt-worker.js`, `brand-icons.js`, `index.html` | 来源白名单 / 选择器、来源与模型图标（Devin 使用官网符号）、分组 / 排序、Token / 费用合计、未计价提示、PNG 保存；CPU 绘制与高清 PNG 编码均在可取消 Worker 中执行，界面只接收有尺寸上限的预览，选项变化立即取消旧任务，仅展示最新结果 |
| 官方价目表与手动 / 自动刷新 | `pricing.cjs`, `pricing-table.cjs`, `lib.cjs`, `renderer/app.js` | 新来源目录、精确模型别名、原价 / 实收分开、更新失败保留价格、日期与来源；模型后缀不能错误映射 |
| 额度水位与历史周期 | `history.cjs`, `quota-timeline.cjs`, `lib.getQuotaTimeline`, `app.liveQuotaPoints` | 注册周期池，保存真实点、账户隔离、过期 / 提前重置、原采样时间；参考线起点推算需标明 |
| 余额趋势（若是 API 钱包） | `balance-timeline.cjs`, `lib.getQuotaTimeline` | 币种和账号隔离，充值 / 赠送 / 消费标签；余额变化不冒充本机消费 |
| 耗尽预测和额度告警 | `quota-insights.cjs`, `main.cjs`, `renderer/app.js` | 用实际额度与周期；数据缺失或旧窗口无可靠预测，估计必须明确说明 |
| 极简额度球 / 速度模式 | `app.quotaPools`, `orbPools`, `selectedQuotaPool`, `renderOrb` | 新池可选择，百分比 / 未知速度 / 重置时间正确，不掉回其他来源 |
| 独立用量池 / 总用量池 | `app.usagePools`, `liquid-pool.js`, `renderUsagePoolGallery` | 独立池可见；未知美元容量不与美元池强行相加，提供解释；日 / 周窗口不冒充 5h |
| 托盘提示和原生任务栏 | `main.cjs` 的托盘提示, `taskbar-meters.cjs`, `taskbar-native.cs` | 新渠道实际百分比可见；过期为未知，缺少美元容量不伪造金额；检查宿主行数与布局限制 |
| 设置、来源状态与身份展示 | `lib.DEFAULT_SETTINGS`, `renderer/app.js`, `index.html` | 所有来源选择器、源数量、套餐行、同步详情 / 时间、隐私模式；不打印密钥 |
| 后台刷新和文件监听 | `main.cjs`, `data-worker.cjs` | 窗口隐藏时仍采样；SQLite WAL / 登录变化可刷新；网络请求不过度重复 |
| 演示、文档、回归 | `renderer/preview.js`, `test/`, `README.md`, 本文件 | 合成演示含新源，加入能力表和实际限制；测试不依赖个人账号或真实日志 |

遇到“该渠道不提供此数据”也要完成接入判断：相应 UI 提示未知，文档写明证据和
原因，最终交付说明限制。不得编造美元池容量、逐请求实收、日内历史或云端 Token。

## 当前渠道能力（2026-10-11）

| 来源 | 请求来源 | 展示费用 | 额度 / 余额 | 主要限制 |
|---|---|---|---|---|
| Cursor | 官方账单接口事件 | 模型等值 / 原事件金额 | 月度两个服务端额度池 | 接口非公开；Auto 路由和速度可能未知 |
| Codex | 本机会话及归档、主动额度查询 | 用户指定假设价 | 服务端周 / 5h，加指定套餐美元口径 | 自定义假设不是官方实收；月度推算规则仅用于 Codex |
| Claude Code | 本地 JSONL | Anthropic 标价 | 桌面版账号采样及拟合 | 重置时间与美元容量为推算；任务栏暂未显示 Claude |
| DeepSeek Harness | 本地日志 + 已核验官方日账单 | 官方实收汇率换算或明确估算 | CNY / USD 账户余额 | 不参与订阅百分比；日汇总不拆成逐对话实收 |
| Devin | CLI `sessions.db` 中请求元数据 | 模型官方原价等值；SWE-2 原价，不使用活动零价格 | CLI 登录态查询服务端每日 / 每周百分比与重置时间 | Token 只含本机 CLI；未接入 Desktop / Cloud 请求日志；未知美元容量不合入总美元池 |

## Devin 实现依据与复用

默认只读 `%APPDATA%\devin\credentials.toml`、`cli\sessions.db`。
可覆盖 `DEVIN_HOME`、`DEVIN_USAGE_CREDENTIALS_FILE`、`DEVIN_SESSIONS_DB`；非 Windows
路径尊重 `XDG_DATA_HOME`。鉴权用于 CLI 同款 `GetUserStatus` 只读查询，成功结果按
凭据指纹缓存一分钟。原始响应、邮箱、密钥不进入缓存或 IPC。日 / 周额度点的 pool
携带账号指纹，`lib.getQuotaTimeline` 和 live 点都过滤当前账号，防止换号混合历史。
凭据指纹变化后开启独立额度历史；不会删除旧账号点。

CLI 3000.11.3 中 `message_nodes.chat_message.metadata.metrics` 分别提供普通输入、
输出、读缓存、写缓存，`generation_model` 是请求真实模型。只在 SQL 中提取元数据，
不读取正文；按 `request_id`（缺失时 `message_id`）全局去重，兼容工具拆分及 fork
继承。没有用量的空 metrics 不生成事件。不要再累计 transcripts 的 ATIF 汇总，
否则会与同一会话库重复。后续支持其它版本时需以脱敏夹具验证实际 schema。

[官方模型文档](https://docs.devin.ai/desktop/models) 给出 SWE-2 原价：每百万 Token
输入 $3、输出 $15、缓存输入 $0.30。Medium / High / Max 使用同一 Token 原价。
官方未单列写缓存价，展示估算采用普通输入价并明确标注。原价自动更新只解析
文档明确的 list pricing，不能把促销零价替换原价。网页计划页与模型文档中的活动
截止日曾不一致，因此水位始终读取服务端实际百分比；无论免费结束、续期或改套餐，
都不使用展示费用反推扣减。Devin 事件的 `quotaEquivalentCostCents` 保持未知，
避免其它计算错误地把 API 等值当成实收。未知型号继续未计价。

参考：[订阅计费](https://docs.devin.ai/admin/billing/self-serve)、
[免费模型不消耗额度](https://docs.devin.ai/desktop/accounts/quota)、
[账号实际模型价目表 API](https://docs.devin.ai/desktop/accounts/api-reference/list-models)。
最后一个接口需要 service-user key，不能把 CLI 登录密钥混当该接口的服务密钥；
其价格是账号实际价，也不能直接替换展示原价。

## 验证完成条件

1. 合成夹具覆盖重复刷新、同响应拆分、fork / retry、模型切换、空 / 无效字段、
   0% / 100%、无限哨兵、网络失败 / 缓存 / 过期、账号切换。
2. 原价等值非零的免费请求仍不改变服务端额度；恢复收费的服务端百分比能正常更新。
3. 请求、模型、趋势、小票、导出按同一来源 / 时间范围对平，未知价格不会计为零。
4. 老数据库升级及重复采集不丢历史；导出包含来源、原单位与费用性质。
5. `npm test` 通过；任务栏变更跑 `npm run test:taskbar-native` 并看深浅色样张。
6. 用合成 `npm run preview` 检查完整 / 迷你 / 全屏和各来源选择器、额度球 / 池 / 图表。
   Devin 可运行 `npm run test:devin-ui` 做隔离的 Electron 界面检查，样张写入 `out/devin-ui`。
7. 有现存登录态时做一次只读真实查询，输出能力和状态即可，不暴露身份、凭据或账单。
8. 更新 `README.md`、`CONTRIBUTING.md` 链接和本文件能力表；最终说明覆盖功能和限制。
