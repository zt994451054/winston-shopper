# 单订单详情范围与页面检查

列表→单订单入口→正文现已提供[统一只读工作流](order-workflow.md)：固定前5组中的明确位置，以原三个读取器运行和保存，跨阶段共享恢复／重试／等待额度。新编排仅离线及本地模拟 CLI 验收，未重放下方独立阶段的实页任务；各阶段时间和覆盖继续分开交付。

更新：2026-10-08。正式单订单入口／页面状态任务保持原范围；独立`--order-body`正文任务创建、一次读取、保存及禁HTTP缓存已完成一单实页验收，暂停／有限恢复仍仅离线通过。基础读取器有一个正常布局来源；入口任务complete仍只表示页面检查，正文任务complete也不表示完整订单详情。现有[订单列表命令](orders-reading.md)保持原范围，能力见[验收表](order-capabilities.md)。

## 正式正常正文任务

2026-10-08本次正式实页验收完成：首份预检缺少原标签，用户随后授权agent自行切换Chrome原窗口，沿同诊断新fresh tabs确认保存ID／地址后，真实CLI创建order-body-snapshot-20261008并一次读取保存8商品位置、状态及5金额原文。1/6内容、1/8清单／执行，恢复／重试0；双Node各10组禁HTTP真实CLI缓存与历史保全通过，无待用户操作。原预检与授权窗口接续分别保留，任务complete只回缓存、不填余次；详见实际结果与边界。

```sh
node scripts/shopping.mjs task-start --task <新正常正文请求名称> \
  --order-body --source-task <已完成的单订单入口任务> \
  --state-dir .runtime/verification-bindings
node scripts/shopping.mjs task-run --task <同名正文任务> --state-dir .runtime/verification-bindings
node scripts/shopping.mjs task-status --task <同名正文任务> --state-dir .runtime/verification-bindings
```

仅用于后续明确的新正常正文请求；本轮现场收据已封存，不创建新任务补其余次数。来源必须是同一原扩展端点已完成的`order_detail_check`，有确认的新同号标签且没有可见受支持错误面板。创建只读本地；不接受列表任务、研究收据、另一正文任务、额外`--tab`／`--order-position`或其他读取模式。保存入口任务名、入口页面原观察时间、原列表任务／位置／时间／编号／链接，以及入口确认的新标签ID。回读时重新校验入口和原列表的对应关系；来源文件缺失、改变或不一致则在浏览器访问前停止。

每任务最多6次内容读取、8次当前窗口清单及8次执行保护，每次运行先落盘执行／清单预留，fresh tabs必须包含保存的新标签和精确地址，才落盘内容预留并调用打印编号保护的正文读取器。连接／清单失败占执行与清单预留，但不会假称已读取内容；次数不退还，也不因跨日或重跑恢复。只读取最多前10个已加载商品位置、状态与金额原文，不点击、滚动、刷新、下载或改订单；不打开新页。

登录／验证码暂停为waiting_user，连接或目标变化为waiting_connection，频控为waiting_cooldown，分别沿同一任务使用`task-resume --after-user`／`--after-connection`／`--after-cooldown`。三类共享最多2次显式恢复，每次落盘预留5000ms，再等待并检查；频控仍只允许一次用户明确请求的探测。故障策略保持原最多2次自动重试（5000／15000ms）、平台5次及120000ms等待保护；显式恢复中的瞬态故障再次暂停，不自动叠加重试，频控探测后仍失败即停。等待中断保留原预留，未提交结果的执行记录READ_INTERRUPTED并占原重试预算。未知结构与响应错误停止，不猜值或换页寻找来源。

正文固定入口已确认的新标签ID，禁止`task-rebind`借用其他同号页；失效时只恢复原连接／窗口及该标签。`task-diagnose`只读地址清单，指出保存标签是否仍匹配及同号候选，不选择替代页，不改预算或结果。没有续批。complete／stopped／ended只回缓存；完成任务不能resume、扩大范围或填剩余次数。`task-end`仅按用户明确结束指令保留原结果与计数。

正式报告`task_kind:order_body_snapshot`，`operations[0].result`为`{schema_version:1,scope:single_order_body,source,target,body}`；body即下方正文观察，保留独立原时间、partial覆盖和未验证标记，不混入原列表价格或入口旧page结果。`operations[0].order_body_budget`记录预留与安全失败历史，actions_reserved始终0。真实值仅存0600检查点；缓存校验拒绝伪造编号、数量、金额层级、状态、完整性及结算，原时间不刷新。

创建→读取→保存→缓存、暂停与有限恢复、宿主中断、来源防篡改和实际CLI最初均通过合成DOM／本地模拟桥接，见离线验证。当前创建、一次读取、保存和成功缓存已有上方一单实页正例；正式登录／连接／频控恢复本次没有触发，不将预检窗口切换当作正式任务恢复实证。

## 正常正文读取器

`BrowserBridge.readOrderDetailBody(tabId, target)`在一次固定eval内先核对精确路由／编号，再读取唯一正常布局的订单编号标签与值；页面打印值必须与保存入口完全一致，之后才读取商品、状态、金额。缺失／重复／编号改变停止，不能用URL编号代替打印证据。调用方先落盘预留内容读取和fresh tabs次数，核对前轮已确认的新详情标签；不能借用同号旧错误页或重放已完成入口任务。适配器无内部重试、等待、点击、滚动、刷新或下载。

目前只支持实页观察到的tbpc_order_detail布局：trade-main-content／trade-content-container内唯一正常content／main，left与right直接子关系；right的detail-info中只读取唯一“订单编号／订单号”值，其他元信息标签可用于定位，但收货、支付方式、支付宝交易号等值不读。left中的商品行必须直接归属该left；状态流程来自同一left；金额行来自同一right的settlement-info。账户、联系、整页正文、交易按钮和媒体不读。其他布局或精确关系不满足则停止，没有猜测回退。

返回本地schema_version:1正文观察，含：

- 原observed_at及route_order_binding_verified、printed_order_id_verified；账户身份仍未验证。
- 每个商品位置的title_region、直接商品链接身份、quantity原区域和仅明确x／×／数量标签时的数值、最多10个item_information片段与最多10个price_observations。信息片段仅unclassified_item_text，不全当作规格、服务或承诺。
- 最多10个流程阶段的title_region、current_marker／done_marker和唯一current_title；流程标记不证明支付、履约或结算。
- 最多20行amount_observations的label_region及价格组件；价格始终按item／order分层，kind:unverified、settlement_verified:false，包括“实付款”原文。
- coverage报告已加载／返回／省略数量及partial。最多前10位置，即使返回全部已加载8行也不认定完整订单商品集。字符截断与片段／组件截断分别保留；未读的折叠、弹出内容不补齐。

本次标题href实际使用`https://a.m.taobao.com/i<商品编号>.htm`。仅正文的parseOrderDetailProductUrl支持这一精确HTTPS主机／路径及此前桌面商品路径；从原路径取得字符串编号，保留原移动网页路由并移除跟踪参数，不构造桌面等价地址、跟随跳转或将商品编号当SKU。拒绝凭证、非默认端口、伪造主机、未知路由及冲突id／itemId参数。通用parseProductUrl及商品浏览器绑定范围不扩大；移动链接的实际访问／重定向未验证。新item字段product_link_navigation_verified:false是可选明确边界，首个本地观察无该字段时缓存校验不回填。

`validateSavedOrderDetailBody`从原字段重建派生值，拒绝改写编号、数量、价格层级、当前状态、身份／结算／完整性标记或加入私有字段，不刷新原观察时间。首次实页原生结果根对象是正文观察，不是正式task包装；当前正式报告的body使用同一结构。入口任务原not_assessed结果不升级或回填。首次限定收据／预算与实际结果见正常正文实测。

## 正式单订单页面检查

```sh
node scripts/shopping.mjs task-start --task <新正常请求名称> \
  --order-detail --source-task <已完成订单列表任务> --order-position 2 \
  --tab <fresh-tabs明确确认的列表标签> --state-dir .runtime/verification-bindings
node scripts/shopping.mjs task-run --task <同名任务> --state-dir .runtime/verification-bindings
node scripts/shopping.mjs task-status --task <同名任务> --state-dir .runtime/verification-bindings
```

`--order-detail`与搜索、商品、购物车、订单列表等模式互斥；来源必须是原扩展端点的已完成、已校验order_snapshot／order_collection。位置1–50且已保存，必须有打印编号与detail_entry直接对应证据。创建只读取本地来源；执行前fresh tabs核对显式指定列表标签，不借同地址的其他标签。读取检查点时再次核对来源任务、原位置、原时间、编号和链接，来源缺失／改变会停止，不能静默重新绑定另一单。

每任务最多8次内容读取预留、6次当前窗口清单预留、1次鼠标动作意图、合计2次显式恢复／每次5000ms。首次准备占1内容读；动作前将3次适配准备读和1动作意图一起落盘，再准备→局部snapshot→再准备→click。准备提前失败也不退还这些预留，不表示全部请求已实际派发。正常成功路径为5/8内容预留、4/6清单预留；内容读和清单次数分别计数，不能用清单检查刷新内容额度。共享原故障策略：最多2次自动故障重试／5秒与15秒、平台5次及120秒等待保护；本任务另有8次执行保护，任一上限到达即停。

鼠标意图同时保存动作前全部标签ID，预留正常开页等待5000ms，回执后实际等待5秒。回执未知只保留action_outcome: uncertain及安全错误码，沿原意图检查新页面，不重发点击。准备明确未派发时封存该意图并停止。只接受唯一新同号详情页，或原列表标签自身转到同号详情；排除动作前已有详情页。多个新匹配页面停止，未找到则waiting_connection，不开备用页、不刷新、不滚动。确认一个新标签后固定该ID，后续失效也不借其他同号页。

登录／验证、连接与频控分别进入waiting_user／waiting_connection／waiting_cooldown，按原任务使用task-resume的对应after-*标记，三类共享2次恢复额度；频控仅允许一次明确请求的探测。显式恢复后的瞬态故障继续暂停，不自动追加故障重试。宿主中断保留意图、预留和首错，恢复只继续相应只读阶段。等待中断不重复扣恢复额度。仅动作意图前可task-rebind --tab显式恢复原列表；意图之后禁止重绑旧详情页，恢复只核对本次新页。

返回scope为single_order_navigation_and_page_state。页面为受支持错误面板时outcome为page_unavailable，无面板时为normal_content_unassessed；两者的正常正文、打印编号、账户身份、结算与联系字段仍未验证。complete、stopped或ended只回本地缓存，不访问浏览器、补剩余次数或接受新批次；完整任务不能task-resume，停止任务不能改名绕过平台锁。只有用户明确授权的新正常范围可以建立独立任务，本入口不迁移或恢复旧研究额度。

真实编号、链接与错误页观察仅存0600本地检查点；公开测试使用合成值。这里的正常请求是新正式入口链验收，旧order-detail-20261006和order-entry-diagnosis-20261007原字节保持封存。现场结果见本轮正式任务验证。

## 来源与身份

从已校验列表中选择一个`detail_entry.order_binding_verified: true`的入口，保留来源任务、列表位置、原观察时间及打印订单号；不要拼接猜测入口或遍历其他订单。列表链接目前只观察到：

- `https://trade.tmall.com/detail/orderDetail.htm?bizOrderId=<字符串订单号>`。
- `https://trade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id=<字符串订单号>`。

两种路由的解析来自实际列表链接；trade.taobao.com路由中的一个正常tbpc_order_detail布局已于2026-10-08限定实页验收，另一路由与其他正常布局未验收。解析只保留规范路由和唯一数字字符串编号，其他参数丢弃。地址检查同时核对HTTPS、无凭证／非默认端口、精确主机／路径及唯一编号参数；先检查地址再碰DOM。登录跳转作为用户暂停条件。同编号不同来源页面、重复参数或改变编号不能通过。

`route_order_binding_verified: true`仅表示当前地址对应保存入口；地址或错误页检查中的`printed_order_id_verified: false`继续有效。正文读取器只有自身唯一明确编号证据通过后才交付true，不能把URL编号冒充页面打印编号。

官方[taobao.trade.fullinfo.get](https://developer.alibaba.com/docs/api.htm?apiId=54)注明需要授权，要求应用AppKey、签名和适用的授权session。普通消费者调用资格、应用授权和真实响应尚未验证；本次没有调用该API或读取凭证。因此继续采用已连接日常Chrome的公开页面DOM，不使用内部请求或存储。接口文档存在不等于当前Skill已经可用。

## 程序接口与字段

`BrowserBridge.readOrderDetailTarget(tabId, target)`只读地址。`BrowserBridge.readOrderDetailPageState(tabId, target)`只读受支持的错误面板。调用前由执行端fresh tabs确认指定标签，按原任务先落盘预留次数；两者不负责研究收据、恢复预算或内部重试，不能无界循环调用。

`target`为`parseOrderDetailUrl`返回的`{url, order_id}`，两个值必须一致。错误页检查只接受唯一可见`.trade-error-container`，并核对其直接子层级content→left→title／subtitle；不按文档顺序挑一个。隐藏错误面板及账户、收件、整页文字不读，缺失／重复／局部归属不明则以结构错误停止。

结果为本地原始观察，含：

- `url`／`order_id`、`observed_at`及仅地址层的身份标记。
- `page_state: error | not_assessed`及`error_roots_seen`。无可见受支持错误面板只表示未评估，不认定可用或正常。
- 错误时`error_page.title_region`／`subtitle_region`保留text与truncated，分别最多300／1000字符；`source_relationship_verified: true`、`cause_verified: false`。不根据“检查网络”提示诊断实际网络或风控原因。
- `order_fields_read`、`normal_detail_layout_verified`、`printed_order_id_verified`、`account_identity_verified`和`settlement_verified`均false；`privacy`说明本地保存、不读联系字段或账户资料。

明确登录／验证码／频控仍停止。未知普通布局不会触发全页文本、截图、私有接口或模型猜测补值。地址／错误页接口不读取正常正文；本轮正常正文另用上方读取器，限定打印编号、商品、状态和金额原文，不读地址、手机号或支付账户，不点击交易按钮。

## 先前研究预算与实证（封存）

本次`order-detail-20261006`研究收据继续位于`.runtime/verification-bindings/diagnostics`，不替代或扩展已完成的订单列表任务。限定一个原入口、最多6次内容读取、2次显式恢复各5秒、2次自动故障重试及一次开页；实际3/6读取、恢复1/2／5000ms、自动重试0、开页1／5000ms。

开页未获明确回执后保留首错，通过一次只读元信息恢复发现唯一新同号详情标签，没有重复开页或刷新。随后结构、两个错误文字字段及生产检查分别1读；该页面返回错误提示，正文0字段。收据`bounded_unavailable`，余下3次不填，全部one-shot已用。结果只允许本地回读，不改名或换目录继续重试；详见实际结果及保全。这次研究恢复不表示正式详情暂停／恢复链已完成。

当时正式链尚未实现；当前入口与预算见上方。正常正文解析只在获得自然可用页面的局部来源证据后实现并另行限定验收，不猜选择器。

## 正常入口与鼠标点击

2026-10-07用户接受一次原入口／打开方式对照。当前第2组入口完整地址与保存规范地址相同、仅biz_order_id参数；没有当前丢参证据。一次受保护脚本点击得到clicked回执，但正常等待与一次有限恢复后，扩展当前窗口清单都没有新同号详情页；旧错误页不作为新导航结果。导航和前轮错误原因仍未知，不认定风控或弹窗拦截。

新诊断仍存于原verification-bindings，引用封存父收据并累计限制：父3读＋新2读＝5/6，父1恢复＋新1＝2/2／10000ms；新入口动作1，正常等待5000ms，另开页命令／刷新／滚动／下载0。诊断bounded_navigation_unconfirmed，余下累计1读不填、所有one-shot已用，不跨日清零。见实测与保全。

本地后端的eval脚本点击与click鼠标事件路径不同；尚未证明该差异是失败原因。新增`BrowserBridge.inspectOrderDetailEntry(tabId, list, detail, position)`只准备已观察列表中的一个当前入口，位置1–50；核对局部唯一来源、打印编号、完整URL、标签、_blank、可交互性和生成的固定selector。未知额外参数、其他目标／标签、禁用／遮挡／屏外都会停止，不读订单商品或收件资料。

`BrowserBridge.openOrderDetailEntry(tabId, list, detail, before)`使用该准备结果，经当前局部准备→只含该链接的snapshot→再次准备→后端click。调用前必须落盘预留1动作和3准备读；本方法没有任务预算、等待、恢复或内部重试管理。准备错误标actionNotDispatched；click回包未知不标未派发、不重发。返回`{clicked:true,navigation_verified:false}`，后续仍要fresh tabs、精确地址和页面自身打印编号确认；不能仅凭回执认定详情成功。

该适配最初新增20回归并模拟通过，双Node各946完整测试通过，当轮没有实页调用，也没有接回已用研究额度。现在接入上方独立正式页面检查任务，仍不因此认定正常正文来源或完整详情能力，不因缺少实证重复换订单。
