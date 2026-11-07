# 个人订单列表只读范围

2026-10-10新增[明确空列表结果合同](empty-list-results.md)：结果、保存／缓存、原任务有限恢复与报告已离线接通，实际空DOM识别尚未接入或实页验收。当前生产读取0组仍是结构错误，空列表不能创建详情入口／正文；原非空任务和预算不升级。

当前已支持与实际缺项见[订单能力表](order-capabilities.md)。列表任务不会自动进入详情；另有独立正式单订单入口／页面状态检查，已验证一次鼠标回执及唯一新同号页、保存／缓存，其历史not_assessed不回填。2026-10-08同一新页另完成限定正常正文，基础读取器取得打印编号、8商品标题／直接链接／数量、状态与5金额原文，见正文实测。随后独立`--order-body`保存／暂停／有限恢复／缓存已离线接通，尚未新实页运行，见[正式正文命令](order-details-reading.md#正式正常正文任务)及实现和保全。原列表结果与预算、旧详情研究及首错不升级或重置。

2026-10-06订单分批已实现并实页通过前10已加载组：`--orders --order-rows N`（1–50）每批至多5组、同任务task-next-batch，读上限ceil(N/5)+2、恢复与重试额度跨批累计。两批各5取得10订单／24商品、前缀保护0／5，DOM30／省略20；2/4读取、恢复／重试0，完成只回缓存。双Node各891完整测试及各11组实页保全通过，1332旧状态不变、新增2共1334；最大50、未知布局及真实恢复不升级，见本轮证据。下方保留原前5组任务与研究各自时点。

2026-10-05已完成首次限定实页读取器验收：当前已加载30个订单组，返回前5组、19个商品位置，包括两组各8个商品及“交易成功／交易关闭”两类页面状态。取得5个明确订单号、日期原文、店铺名区域、状态区域、5个与打印订单号一致的详情入口，以及19标题／规范商品链接／数量、37商品信息片段、10订单金额组件与31商品价格组件。结果与证据见实测记录。

正式 `task-start --orders --tab ID` 已接通创建、保存、暂停、有限恢复与成功缓存。2026-10-05新正常order-snapshot-20261005通过真实创建→一次读取→保存→禁HTTP缓存：仍为前5已加载订单／19商品，读取1/6、恢复／重试0，日常Chrome新页1／等待5000ms，无点击／滚动／下载或订单改动。双Node各857完整测试及各11组实页保全通过，1330旧状态全部不变、新增任务／收据2共1332；暂停／故障恢复仅离线验收，本轮未触发。见正式实测与保全。

以下首次研究收据保留原时点，不迁为新任务或追加额度。本阶段不打开订单详情，不读取收货地址、手机号、付款资料或账户档案；不切状态／搜索／筛选，不翻页／滚动，不点击付款、取消、确认收货或售后。

## 正式命令与预算

使用Node.js 22+，运行doctor／tabs后选择当前明确的订单列表标签。无需商品绑定，任务只接受上文已观察的HTTPS列表路线：

```sh
node scripts/shopping.mjs task-start --task <本次正常请求名称> --orders --tab <当前订单列表标签ID> --state-dir .runtime/verification-bindings
node scripts/shopping.mjs task-run --task <同一任务名> --state-dir .runtime/verification-bindings
node scripts/shopping.mjs task-status --task <同一任务名> --state-dir .runtime/verification-bindings
```

`task-start`只在本地创建一个 `order_snapshot` 操作，不读取页面。运行先落盘预留一次，再刷新原连接／tabs；指定标签不在当前窗口或地址变化就暂停，不能借用其他同地址标签。随后执行一次同页地址保护和区域读取，最多前5订单、每单10个已加载商品位置。读取成功后保存0600本地检查点；`complete`只表示本次限定范围完成，仍交付partial覆盖，不证明全历史或资金结算。

| 保护 | 固定上限与含义 |
| --- | --- |
| 读取预留 | 最多6次；失败、中断及目标预检失败也计数；其他限制可能更早停止 |
| 自动故障重试 | 共享策略：本操作最多2次，等待5秒／15秒；平台累计最多5次 |
| 显式恢复 | 用户／连接／冷却合计最多2次，每次先保存并等待5秒；占原120秒等待预算 |
| 频控 | 保持暂停，只在明确请求后允许一次冷却探测；失败不自动重复 |
| 失败记录 | attempt／code／category保留，外部错误原文不进入检查点或汇报 |

`operations[0].result`为已校验快照，`operations[0].order_budget`含固定范围、累计读取／恢复与失败历史；`actions_reserved:0`。成功、partial、stopped和ended均只回原保存结果／错误，零页面读取，不填余次数或创建新任务绕过停止。原首次研究结果独立保存；只有新的正常请求才能创建正式任务，不自动导入旧研究或回填字段。

| 暂停状态 | 处理与同任务命令 |
| --- | --- |
| `waiting_user` | 用户在该订单页完成登录／验证后，`task-resume --after-user`；未报告完成不继续 |
| `waiting_connection` | 恢复原连接与原标签；标签ID变化时先tabs、`task-rebind --tab ID`核对同一列表路线，再`task-resume --after-connection` |
| `waiting_cooldown` | 不猜平台恢复时长；仅在明确要求稍后恢复时，`task-resume --after-cooldown`一次 |

以上命令均须携带同一 `--task` 和 `--state-dir`。`task-diagnose`仅查地址清单并返回脱敏原因／匹配ID，不读正文、不改检查点或预算。显式重新绑定不证明账户或筛选连续性，保留这些未知字段；不会因新标签ID重置次数。恢复等待中断时不重复预留，执行中断计一次原失败；恢复检查若仍超时会回到原暂停状态。达到预算或遇到未知结构则停止，需保留本轮记录，不换名补读。

## 分批读取新任务

仅在新的正常请求明确更多已加载订单时使用：

```sh
node scripts/shopping.mjs task-start --task <本次正常请求> --orders --order-rows 10 --tab <当前标签ID> --state-dir .runtime/verification-bindings
node scripts/shopping.mjs task-run --task <同一任务名> --state-dir .runtime/verification-bindings
node scripts/shopping.mjs task-status --task <同一任务名> --state-dir .runtime/verification-bindings
node scripts/shopping.mjs task-next-batch --task <同一任务名> --state-dir .runtime/verification-bindings
```

N为1–50整数，生成order_collection／预算子格式2；不带参数仍为原前5组模式／子格式1，旧完成任务不能升级。每次至多5新订单组、每组至多10商品位置；读上限ceil(N/5)+2，请求10组为4次。预检失败、故障及中断都计数；原2次自动重试与合计2次显式恢复各5秒、频控一次明确探测和原等待预算跨批累计，其他限制可能更早停止。正常批间1500ms节奏不计为故障／恢复等待。

每批保存后返回awaiting_batch；run／status只回缓存，明确同任务task-next-batch才继续。暂停或停止时已有数据在 `operations[0].order_collection`，保留requested_orders、batches、全局orders位置及各自observed_at；完成后result也为同一集合。各批子格式2快照保留range／prefix_guard和原时间，不把跨批结果合成同一时刻保证。

续批在同次表达式中确认已加载组数、此前明确订单号／日期／店铺／状态，以及已返回商品的标题／规范链接、数量、信息片段和已加载商品数。此前价格不重新读取，不把稳定文字解释为价格稳定、账户或物理身份保证。字段不足／截断或重复编号时ORDER_CONTINUITY_UNVERIFIED停止保留当前批次，加载数或前缀变化时ORDER_ROWS_CHANGED停止，不自动重复；最终不用续批时未知字段仍可如实交付。

范围止于min(N,第一批加载数)，不翻页或滚动。requested_limit_reached和requested_loaded_range_read分开，加载不足请求数只确认当时已加载范围读完；页面总量null、全历史false。明示重绑仍须原端点／同路线且沿原预算，下次读取核对全部前缀，不证明账户／筛选连续性。完成后的next-batch也只回缓存，不扩范围或填余次。

新正常order-collection-10-20261006已完成两批各5，24商品、47信息片段、20订单金额／41商品价格，读取2/4、恢复／重试0。最初本地地址不可达时平台读0，按声明启动原服务一次后恢复，错误保持；日常Chrome新页1／5000ms。正常创建／首批／续批／保存／禁HTTP缓存通过，最大50、暂停／故障恢复仅离线，不重放旧前5任务或本轮已用one-shot。

## 多页读取

2026-10-13 新增。适用于需要读第 1 页以后的订单，或者读完整个订单列表的请求。依据见翻页控件调查。同日实页验收通过：读 3 页共 89 单；读全部时第 1～8 页共 230 单，第 9 页确认为空的最后一页。见验收记录。

```sh
node scripts/shopping.mjs page-open --orders --json
node scripts/shopping.mjs task-start --task <本次请求名称> --orders --pages 3 --tab <订单列表标签ID>
node scripts/shopping.mjs task-run --task <同一任务名>
```

- **范围**：`--pages N`，N 为 1～10。每页读这一页上已加载的全部订单，最多 50 个；实页每页 30 个。每个订单最多 10 件商品，字段与单页读取相同。不能和 `--order-rows` 同时使用。
- **起点**：必须是第 1 页，“所有订单”标签选中，订单搜索框为空。不满足时停止，错误码 `ORDER_VIEW_NOT_DEFAULT`，不会替用户切换标签或清空搜索。搜索框只判断是否为空，不读取其中的文字。
- **页码从哪里来**：翻页后网址完全不变，当前页只能从页码栏读。所以每次读取都核对页码栏，只接受已确认的当前页；点了“下一页”以后，再加上它的下一页。
- **每翻一页**：
  1. 先把“下一页”的点击意图存盘；
  2. 点击脚本在同一次执行里核对当前页码、本页全部订单号和“所有订单”视图，都对得上才点；
  3. 点击后需要连续两次读取一致，并且页码到了目标页、订单号与之前各页完全不重叠，才算翻过来。
- **总页数会变**：页码栏显示的最后一页不是固定值。2026-10-13 实页上，第 1、2 页显示 9 页，翻到第 3 页时变成 8 页，这一页只有 29 个订单。所以总页数不作为翻页成功的条件。每页保存自己看到的总页数；结果里 `total_pages_first_displayed` 是第 1 页显示的，`total_pages_displayed` 是最后读到那页显示的，`total_pages_changed` 表示中途是否变过。是否到底，只看当前页那一刻的页码栏。
- **没翻过来**：页码还是旧页，或者新页码下仍是上一页的订单，按“还在加载”处理，只继续观察。三次观察仍确认不了，就停止（`ACTION_OUTCOME_UNKNOWN`），不重新点击。
- **点击没发出**：比如节奏额度用完、页面出现弹窗。这时程序确定什么也没点，撤销这次点击意图，下次运行重新预留。点击回执不明的，只观察，不重发。
- **停止原因**：
  - 某页订单与之前的页重复：`ORDER_PAGES_OVERLAP`，可能是读取期间有新订单把旧订单挤到了后一页；
  - 离开“所有订单”或搜索框不再为空：`ORDER_VIEW_CHANGED`；
  - 有订单没有明确的订单号：`ORDER_CONTINUITY_UNVERIFIED`。

  以上情况都保留已确认的页，不悄悄去重或跳过。
- **结束**：有三种情况。
  - 读满请求的页数：`end_reason: requested_pages`。
  - 提前遇到真实的最后一页，即当前页等于页码栏最大页码，且“下一页”禁用：`end_reason: last_page`，这时不点击。
  - 页码栏显示的最后一页一个订单都没有：`end_reason: empty_last_page`。2026-10-13 实页上，第 8 页只有 21 单但“下一页”仍可点，点过去的第 9 页是最后一页，只有表头、页码栏和“猜你喜欢”，没有订单。这种空页必须是当时页码栏的最后一页（“下一页”禁用），并且连续两次读取一致，才算列表结束。空页单独记在 `empty_last_page`（页码栏、视图、采集时间），不算进 `pages`。如果是中间的页显示为空（“下一页”还能点），按“还在加载”处理，确认不了就停止。第 1 页就没有订单时，仍按结构不符停止。
- **“全部订单”的含义**：`coverage.all_listed_pages_read: true` 只说明“所有订单”标签列出的页全部读完了。两点不包括在内：“回收站”里的订单（`recycle_bin_included: false`），以及平台不在列表里显示的更早订单。因此 `full_order_history` 始终为 `false`。
- **预算**：
  - 执行入口最多 6 次；
  - 内容观察最多 `1 + 4×(N−1) + 4` 次，点击脚本自身的核对也计入；
  - 每次翻页最多一次点击、三次确认观察；
  - 显式恢复 2 次，共用原等待预算。
- **节奏**：每次“下一页”计一次页面类加载，见[节奏](pacing.md)。读 10 页需要 9 次翻页，加上打开页面 1 次，正好是 10 分钟内的上限。额度不够时，任务以 `pending` 返回 `pacing_hold.allowed_after`，到时间后对同一任务再运行 `task-run`。
- **结果**：在 `operations[0].result`：
  - `pages[]`：每页包含 `rows`（订单快照格式 4，带各自的采集时间）、`pager` 和 `view`；
  - `returned_orders`、`distinct_orders`、`end_reason`；
  - `coverage`、`action_evidence`。

  暂停或停止时，已确认的页在 `partial_pages`。报告导出时，每页一个观察，另有 `order_pagination` 记录。
- **连接恢复**：标签页丢失时进入 `waiting_connection`。`task-diagnose` 会给出 `allowed_pages`；`task-rebind --tab` 只核对订单列表地址，页码由下一次读取核对。新标签停在第 1 页而任务已读到后面时，读取会再次暂停，不会从第 1 页重来。
- 多页任务的结果暂时不能作为 `--order-detail` 的来源。

## 来源与官方API

官方 [taobao.trades.bought.get](https://developer.alibaba.com/docs/api.htm?apiId=45) 是买家订单候选，文档要求应用参数、签名与用户授权session，并描述订单时间范围。本项目尚未取得满足消费者场景的应用资格／授权及真实调用通过证据，因此沿已连接日常Chrome上的正常订单入口取得浏览器证据。文档存在、网站已登录都不等于API已适用；没有检查cookies／storage或调用页面私有接口，也不据此断言官方API不可用。

列表身份只接受 `https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm`，移除查询／片段，不把地址保护当作账户或筛选连续性证明。先刷新连接和tabs，保存指定标签；失效时不能借用另一个同地址页。页面内固定表达式再次保护地址并检查登录／验证／频控后才读字段。

## 当前读取器

[order-target.mjs](../lib/order-target.mjs) 提供 `parseOrderListUrl`、地址表达式／验证及两个实际观察到的详情入口解析。详情URL只保留该路线的字符串订单号，其他参数移除；仅当同行明确“订单号”文字与入口编号一致时确认入口关联，未打开目标页面，也不声称订单详情已验证。

[order-rows.mjs](../lib/order-rows.mjs) 固定选择唯一 `.trade-main-content` 下的 `.trade-content-container`，订单必须为直接子组；头部及商品／金额列关系须一致。只读取前5个已加载订单组，每组最多10个已加载商品位置，每个价格区域／商品信息集合最多10个片段。推荐区域、操作区、头像、聊天属性及账户内容不采集。未知或混合布局停止；不猜其他模板，不把无商品结构认定为无订单。

`BrowserBridge.readOrderRows(tabId, target)` 单次固定读取并校验回包，无内部重试。调用方必须先落盘预留读取及原标签，再查连接／tabs；当前项目验证使用原 `.runtime/verification-bindings`。`readOrderListTarget` 是独立地址方法，尚仅模拟验收；组合表达式的地址保护已有本次实证。

`BrowserBridge.readOrderBatch(tabId, target, plan)`复用同一局部结构，一次限定范围／前缀观察，返回子格式2。plan先校验至多50全局位置、每批5和完整字段受限前缀；接口本身不保存任务或重试。`validateSavedOrderBatch`与 `validateOrderCollection`离线重验批次和派生交付，不访问平台或升级旧格式。

## 交付字段

私有 `.runtime/order-list-20261005/production-snapshot.json` 根对象是读取器快照，**不是正式task结果**，不导入旧购物车任务。

新的正式结果在 `task-run`／`task-status` JSON的 `operations[0].result`，对应私有 `.runtime/verification-bindings/tasks/order-snapshot-20261005.json` 的同一字段；范围和计数在报告 `order_budget`／检查点 `order_read`，观察时间按本次保存。根对象包装不同，不能把旧研究快照冒充正式报告或升级旧任务。

| 字段 | 含义与边界 |
| --- | --- |
| `orders[].position`、`order_id`、`order_id_region` | 本次顺序位置；编号仅来自明确头部“订单号”原文，字符串保留，不用商品ID或本地位置代替 |
| `placed_at_region`、`shop_name_region`、`status_region` | 实际区域文字与截断标记；不推算时区、统一状态码或其他状态 |
| `detail_entry` | 两个支持路线的原观察与匹配结果；不匹配时url为null，保留原因 |
| `payment_observations` | 同订单金额列的文字／标签，level为order；不分摊给商品，settlement和item_allocation均false |
| `items[].title_region`、`title`、`product_link`、`product_id`、`url` | 唯一商品标题文字与原标题锚点中的规范商品链接；交易快照文字不混入标题 |
| `item_information` | 商品信息区片段原文；含义未分类，不把每段都宣称为规格或服务 |
| `quantity` | 同商品数量区域当前 `xN` 布局；其他／截断格式保留原文且值未知 |
| `price_observations` | 同商品价格列文字，level为item；单价、行金额及结算未验证，不用订单实付款覆盖 |
| `coverage`、每单`coverage` | 已加载／返回／省略位置，页面总量null、全历史false；每单完整商品集也未证明 |
| `privacy`、`limits` | 本地私有结果、未读联系人／档案及各集合固定上限 |

“实付款”标签也在本次关闭订单中出现；忠实交付标签不代表资金结算已证实。重复商品位置分别保留，不用标题／商品ID去重。本批5订单编号各自明确，不推广为全历史去重策略。

`validateSavedOrderRows(value, target)` 可离线重验快照及派生的编号、数量、关联和覆盖字段，不读浏览器、不追加观察或自动升级未知字段。

## 原研究预算与当前接续

原诊断收据 `diagnostics/order-list-20261005.json` 已 `bounded_complete`：读取5/6（首个回包处理失败1＋入口复查1＋结构1＋区域字段1＋生产读取1），新开列表页1/1／等待5000ms；两次本地研究脚本修复各占1次恢复，共2/2／10000ms。第一处把原生对象误传JSON.parse，第二处恢复阶段碰到已有产物的独占创建保护、未派发浏览器读取；两处均修复，原失败与首次未知回包保留，未重置预算。浏览器点击／滚动／下载／订单改动与自动重试均0。

原研究已完成，不重放once或用余下1次补读，两次研究辅助恢复不当正式恢复实证。原前5组任务仍1/6、只回缓存；新前10组分批任务完成2/4、余下2次不填，正式登录、连接与故障恢复仍只有模拟测试。所有已用preflight／connection-repair／read-once不重放，无待用户操作。下一步收拢订单列表能力与剩余边界，再按一条订单限定字段推进详情，不借完成任务扩范围或续预算。
