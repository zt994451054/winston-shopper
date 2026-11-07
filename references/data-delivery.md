# 给调用方 AI 的数据交付

2026-10-09新增[本地缓存报告导出](report-export.md)：`report-export --task NAME --format markdown|csv --output FILE --state-dir <原目录>` 仅从有效缓存生成私有文件，保留每批原采集时间、缺项和覆盖限制。它不访问浏览器或图片服务器，不执行任务、不改变原预算；当前订单实页链仍为 `waiting_site_policy`。

2026-10-08统一编排新报告 `result.scope:single_order_read_workflow`，`observations.list`为明确选定行与原列表时间／覆盖，`observations.entry`和`observations.body`各保留原阶段结果；正文在后者的`.body`。缺阶段为null，`stages[]`和`budget`分别保存原计数与跨阶段总预留，不合并不同时间的商品、状态或金额。统一链只有合成／本地模拟证据，实际值与历史快照不导入或回填，见[交付字段与边界](order-workflow.md#交付)。

2026-10-08正式正文包装已有一单真实值：私有`.runtime/order-body-live-20261008/task-run.json`及原verification-bindings的`tasks/order-body-snapshot-20261008.json`保存`operations[0].result.body`，scope为single_order_body。8商品位置标题／链接／数量、状态与5金额原文各有自身来源；body保留本次独立观察时间、partial及未验证边界，不覆盖列表、入口或前轮研究快照。正式1/6内容、1/8清单／执行，恢复／重试0；双Node禁HTTP的真实CLI run／status／next-batch回读保持相同结果、时间和预算。无待用户操作，成功只回缓存；现场恢复、其他布局及完整订单工作流不升级。见本轮交付与保全。下方均为前轮时点。

2026-10-08新增正式正文任务包装：`task_kind:order_body_snapshot`，`operations[0].result.scope:single_order_body`，其中source保存入口任务／原时间与原列表来源，target为原单，body使用已验证的正文观察结构。`operations[0].order_body_budget`保留6内容／8清单／2共享恢复各5秒与原失败历史；actions_reserved:0、normal_order_fields_read只在保存正文后为true。完成回缓存保持原body.observed_at，拒绝伪造数量、金额层级、当前标记、来源或完整性。此包装仅合成DOM／本地模拟CLI通过，本轮未创建实页正文任务、没有真实新包装值可交付；前轮私有根观察不导入或回填为正式任务。见[正式命令和字段](order-details-reading.md#正式正常正文任务)与实现及保全。下方为前轮时点。

2026-10-08正常正文结果私有0600保存在`.runtime/order-detail-body-20261008/compatible-production-body.json`，根对象为读取器观察，不是正式task报告。包含原observed_at、唯一打印编号保护、items[]的8标题／直接链接／数量及16未分类信息片段、9商品价格；status_observations有4阶段与1当前标记，amount_observations有5金额标签原文与5订单价格。移动商品链接保留实际来源，item.product_link_navigation_verified:false；价格按item／order分层、kind:unverified，coverage.status:partial、完整商品集／账户／结算仍false。首个production-body.json保留原缺链接结果与时间，可选新字段不回填。正常正文尚未接正式CLI／任务保存暂停恢复链；旧入口报告的not_assessed不升级，不能用旧列表商品替代本页字段。新收据5/6内容、5/8清单，旧1338状态SHA不变；字段与实证见[接口](order-details-reading.md#正常正文读取器)及本轮结果。下方均为前轮时点。

2026-10-07新正式order-detail-check-20261007的本地task-run结果根为任务报告，operations[0].result.scope为single_order_navigation_and_page_state；含source的列表任务／位置／原时间，opening的鼠标回执与新页确认，以及page的原观察时间和页面状态。实际opening.navigation_verified:true、action_outcome:acknowledged，page.page_state:not_assessed、error_page:null；error_roots_seen:2包含隐藏节点，不能读成有可见错误。outcome:normal_content_unassessed、正文／打印编号／账户／结算均未验证，complete只表示入口／页面检查完成。旧列表商品不能冒充本页商品；已完成任务只回缓存，不填余次。预算、用法和实证见[正式入口](order-details-reading.md#正式单订单页面检查)与本轮结果。下方均为前轮时点。

2026-10-07原入口研究交付在私有`.runtime/order-entry-diagnosis-20261007/current-entry.json`及原verification-bindings的诊断收据，无正式task或新详情正文。当前original_url_matches_canonical:true、参数只有订单号；normal_entry_acknowledged:true仅表示脚本派发。navigation_diagnosis为ORDER_DETAIL_NAVIGATION_UNCONFIRMED／navigation_verified:false，不能用旧错误页顶替新页。父子累计5/6内容读、2/2恢复，旧结果与预算保持；新鼠标点击接口仅离线，见[范围](order-details-reading.md#正常入口与鼠标点击)和实际结果。

2026-10-06单订单页面检查结果私有保存在`.runtime/order-detail-20261006/production-page-state.json`，根对象为基础读取器观察，没有正式task包装或订单正文。`page_state:error`、`error_page.title_region`／`subtitle_region`保留局部错误提示原文、截断及关系；`cause_verified:false`。URL编号仅地址层关联，打印编号、正文、正常布局与结算均未验证；无可见错误面板也只not_assessed。原10组列表快照不改、不把其中8个商品冒充详情已读，见[字段与边界](order-details-reading.md#程序接口与字段)及本轮证据。

2026-10-06订单分批交付：新 `--orders --order-rows N`的报告在 `operations[0].order_collection`始终保留已取得集合，完成后result也为同一集合。requested_orders、batches、orders及partial覆盖保留每批原时间／全局位置／前缀检查，不合成同一时刻保证。实页前10组24商品、47信息片段、20订单金额／41商品价格，DOM30／省略20；读取2/4、恢复／重试0，成功后禁HTTP缓存通过。真实值仅本地0600，原前5组及研究不升级，见[分批字段](orders-reading.md#分批读取新任务)和本轮结果。下方为前轮时点。

2026-10-05正式订单结果已有task包装：新 `task-start --orders --tab ID`的task-run／task-status返回 `operations[0].result`（前5订单／19商品，DOM30／省略25），同位置 `order_budget`记录6次读取保护、2次显式恢复额度及累计失败，本次1读／0恢复／0重试。创建→读取→保存→禁HTTP缓存实页通过；暂停／恢复仍仅离线验收。检查点私有存于 `.runtime/verification-bindings/tasks/order-snapshot-20261005.json`，真实值不写公开示例；见[正式命令](orders-reading.md#正式命令与预算)及本轮证据。下方首次读取器研究保留原时点，不将旧根对象改为task结果。

2026-10-05个人订单列表首次结果在私有 `.runtime/order-list-20261005/production-snapshot.json`，根对象为读取器快照，尚无正式订单task包装。`orders[]`保留前5组的明确编号／日期／店铺／状态及同编号详情入口，`items[]`共19个标题链接／数量与37未分类信息片段；`payment_observations`10组件为order层，`items[].price_observations`31组件为item层，均保留标签且结算未验证。已加载30／省略25，全历史false；真实值本地保存、公开测试合成。离线 `validateSavedOrderRows` 重验可用，本次没有进入详情；见[字段与边界](orders-reading.md#交付字段)和实际结果。

2026-10-05新正常前30行结果已保存：私有 `tasks/cart-collection-30-20261004.json` 的 `operations[0].result` 是6批展开结果，`batches`保留各次原观察；私有 `.runtime/cart-first30-20261004/batch-6.json` 是CLI报告包装。30名称链接／店铺区域／数量，29规格文字、第29行存在规格区域但text为空且未截断，49价格组件原文；空文字不推断没有规格。已加载30／返回30／省略0，页面总量未知、full_cart=false，价格与实付归属不猜补。实际值只留本地，公开说明不含商品值；见本次结果。旧前10行结果独立保留，不跨时间合并。

购物车分批新 `task_kind:cart_collection` 已完成真实前10行两批验证：部分／停止结果始终在 `operations[0].cart_collection`，完成后同样在 `result`。`batches[{attempt,snapshot}]`保留每批原快照、读取序号及时间；`rows`保留全局DOM位置与各行所属批次时间，重复商品分别交付。快照格式2的 `range`、`prefix_guard`明确续批保护，仅比较已读字段，不证明物理行或账户；旧格式1不改。10行标题链接／规格／店铺区域、10数量和16价格组件取得，DOM30／返回10／省略20，仍非全车。见[字段与预算](cart-reading.md#分批读取新任务)和实测与保全。下方保留此前独立前5行结果。

2026-10-04购物车正式新请求已实页完成。私有 `.runtime/cart-formal-live-20261004/task-run.json` 的 `operations[0].result.rows` 为前5行数据，预算在 `operations[0].cart_budget`；名称／商品链接／规格、5数量和8价格组件取得，DOM30／返回5／省略25仍partial。创建／单读／保存／禁用HTTP后CLI回读在此例通过，恢复分支没有触发；双Node各10组核对、旧1323状态不变，仅新增2份共1325，124源码／测试辅助未改。原研究结果分开保留，本次没有进入商品详情或取得其图集；见实测和边界。下方“仅离线”是此前时点。

2026-10-04正式购物车任务入口已离线接通。`task-run`／`task-status`报告的`task_kind`为`cart_snapshot`，`operations[0].result`为已校验的行快照，`operations[0].cart_budget`为原范围、读取／恢复预留和安全失败历史。完成后回读零浏览器调用，保持观察时间和partial范围；不是全车、空车证明或新实页验收。先前私有研究根快照与正式报告包装分开，不导入或改写旧结果；见[命令与预算](cart-reading.md#正式命令与预算)和本次验证。

2026-10-04购物车前5行读取器实页通过，真实结果只在私有 `consumer-shopping-skill/.runtime/cart-reading-20261003/resume-20261004/rows-confirm-result.json`，根对象即最新读取器快照，不是正式task结果包装。`rows[]`保留同行标题／商品链接／规格、店铺区域、5个数量值及8个价格组件；输入框与静态数字来源分开。价格组件kind为unverified，SKU／行ID为null，单价、行金额、实付和店铺名语义未验证；loaded_rows_seen为30、returned_rows为5、page_total_rows为null。原第一次仅2行数量的快照不回填，完整购物车CLI／任务缓存尚未接通；公开回归均合成值。见[字段入口](cart-reading.md#最新实页验收与字段)与验证记录。

2026-10-03同商品分类补读：[图/视频文字JSON](../examples/data/random-shirt-review-media-text-20261003.json)的`.result.samples[0].reviews.reviews`为7个主评位置的正文数组；上层`reviews`保留总量、折叠提示及观察时间，`association`保留选中标记、列表改变与两次一致关系。4/12文字读＋3/3收尾，面板自动关闭已确认；与先前“全部”9条分开，不合计独立买家或读取媒体。见分类实测。

2026-10-03同商品补充：女款短袖[规格图JSON](../examples/data/random-shirt-specification-collection-v3.json)根对象即正式结果，5个1440×1440颜色链接、11名称、6个尺码图片来源未支持；[服务JSON](../examples/data/random-shirt-services-20261003.json)的`.result.details.services.terms`为5条有限说明；[评价JSON](../examples/data/random-shirt-review-text-20261003.json)的`.result.samples[0].reviews`为实际全部9主评，`.result.panel_lifecycle`保存同任务自动打开、采样及关闭确认实页证据。各观察时间分开，不回填或融合原基础快照；见实测及限制。

2026-10-03用户授权随机正常采集的[女款短袖JSON](../examples/data/random-shirt-details-20261003.json)使用`.result`作为原正式详情快照：33参数、11规格名称、5顶部图链接和21个正常尺寸详情图元素。本次没有自然缺图，未创建补图任务；图片未下载／识图、SKU及实付仍未验证，见[样本与全部名称](../examples/random-shirt-details.md)。

2026-10-02单张详情图有限加载入口已离线接通：结果的`description_image_loading`保留原位置、前后图片与时间、动作前几何及滚动回执；失败时操作的`unconfirmed_description_image_observations`按initial／guard／last对象分别交付，动作信息在`description_image_action`。不推断滚动原因、物理节点身份或SKU关系；该入口尚无实页验收，也不创建图片下载来源，见[用法与字段](description-image-loading.md)。

当前范围与验收结论见[详情能力表](detail-capabilities.md)。下面的历史观察保留各自时间，不合并为同次完整商品数据；整理既有记录不刷新页面或改写旧JSON。

正文新交付：[图书有限展开JSON](../examples/data/book-description-expansion-20261001.json)的`result`等于正式任务原结果，338字／12参数、入口0、动作0，`description_expansion.status`为`entry_not_observed`。这是无入口分支，不是实际展开证明。展开任务失败时，未确认文字位于操作的`unconfirmed_description_observations`，不能作为连续两次确认结果；见[字段和规则](description-expansion.md)。

详情图片新交付：[小图补验JSON](../examples/data/description-image-loading-20261001.json)为独立研究包装，逐次数据在`evidence[]`，不覆盖旧正式结果。新正式读取的`details.description.image_readiness`区分正常尺寸链接、异常小图、未加载、缺URL、不支持URL及未扫描范围；原`loaded`和`availability`计数仍表示浏览器资源状态，不等于实际图齐全。旧快照缺字段时保持未采集，见[读取状态](products.md)。

布局失败的新交付：新基础任务可在`operations[i].layout_evidence`保留同次有限结构证据；`layout-diagnosis`离线取回，`layout-check`核对调用方模型的节点提案。候选结果与正式`result`分开，只确认保存证据中的来源对应，不确认字段语义或当前页面，不增加恢复额度。旧任务不回填，见[使用与字段](layout-assistance.md)及[离线示例](../examples/layout-assistance.md)。

2026-09-29规格实页交付：[运动鞋格式3 JSON](../examples/data/shoes-specification-collection-v3.json)及[18项表](../examples/shoes-specification-images-v3.md)包含11颜色图片链接与7鞋码名称。名称1读／图片3批、每图1次、零滚动或重试。第1／11项下载证据见[独立JSON](../examples/data/shoes-specification-download-check.json)，只验证2/11张下载，不回填原观察；SKU和价格绑定仍false。见验收报告。

此前实页交付：[短袖格式3 JSON](../examples/data/shirt-specification-collection-v3.json)与[规格表](../examples/shirt-specification-images-v3.md)包含47项名称、39个800×800颜色图片链接及逐项历次观察，8尺码仅文字。正式25次读取、2次实际滚动、零故障重试；此限定结构完成，SKU／价格绑定仍false。旧47项JSON保留原缺项，不与新时间混合。见实页证据。

新规格集合为格式3，名称先单独保存且不占图片次数；每图3次，整体按3＋3×带支持图片容器的选项数计算。collection.inventory_reads_reserved、image_reads_reserved和budget_basis区分清单／图片预留与上限来源。collection.loading_actions保留动作前来源、回执和后读；unconfirmed不表示未执行，after_read不表示成功。旧格式1／2和JSON不回填，见[字段与预算](specification-images.md)。

规格图片补充观察：[短袖第13颜色加载JSON](../examples/data/shirt-specification-image-loading.json)记录正常滚动前2×2、后三次同一800×800图片。结合旧12项，跨时间有13项正常尺寸链接、26项颜色图片未知；`historical_union`不代表同时刷新，原47项正式结果及时间不回填。研究未接正式CLI，SKU与价格归属保持未知。

规格图片新任务默认尝试完整取得已扫描规格及图片，在同一task-run内自动分批和有限补查；部分结果始终在 `operations[0].image_collection`，支持范围完成后也在result。来源为 `bounded_specification_collection`，包含全部已扫描文字的inventory／options、每项历次observations、missing_images和unsupported_image_options；小图与未加载／未读明确区分，不把loaded或DOM关联当作实际规格图齐全。新任务每项3次，整体随规格数量计算；旧批次仍沿原image_batches与task-next-batch使用，旧数据不回填。见[完整字段与预算](specification-images.md)。历史格式1曾在回力短袖实页跑到10次上限并交付47项文字、12个正常尺寸图片链接、27项缺图；见[本轮JSON](../examples/data/shirt-specification-collection.json)和[交付表](../examples/shirt-specification-collection.md)。原鼠标仍为18项正常尺寸链接、14项实际图片未取得，见[历史32项交付](../examples/mouse-specification-images.md)。

现有 CLI 已返回结构化 JSON。读取成功的商品记录位于 `operations[i].result`，不需要先生成摘要或识别图片。本文说明怎样直接使用这些字段，以及本次已经核验的历史示例。

## 取得结果

已有任务用原任务名和原状态目录回读：

```sh
node scripts/shopping.mjs task-status --task <原任务名> --state-dir <原状态目录> --json
```

`task-status` 不连接浏览器、不刷新数据，也不改变计数。`task-run` 对完成任务同样返回原观察；不能用回读时间代替 `observed_at`。新读取仍按 [Skill 流程](../SKILL.md) 检查目标并执行有预算的任务。

先检查任务 `status` 及每个操作的 `status`、`error`、`result`。暂停或失败不等于空商品。`complete` 仅表示预定操作完成，商品的 `coverage.status: partial` 及缺失信息继续有效。

## 字段入口

| 数据 | 字段 | 使用边界 |
| --- | --- | --- |
| 身份与来源 | `product_id`、`url`、`title`、`source`、`observed_at` | 商品 ID 使用字符串；时间为该次观察的 UTC 时间，不是当前价格有效期 |
| 文字与参数 | `details.description.text`、`details.attributes.items` | 保留参数原行及 `source`；正文观察范围见 `description.observation`，不从图片或标题补齐缺值 |
| 正文展开证据 | 展开任务`result.description_expansion` | 单次已有详情观察与展开流程证据分开；无入口不证明无折叠，实际派发与连续文字确认分别记录，见[展开流程](description-expansion.md) |
| 未确认正文观察 | 操作的`unconfirmed_description_observations.initial.snapshot`及`.last.snapshot` | initial／last可为null；保留有效正文和原时间，错误看操作的error；不能跨故障拼接确认 |
| 商品图集 | 详情任务 `details.gallery.items`；独立图集任务 `gallery.items` | 均取自缩略图区域，使用实际URL；独立入口不依赖标题、价格或当前大图，见[图集只读](gallery.md) |
| 已确认静态主图 | 主图任务 `result.samples[]` | 独立格式；保留实际主图URL、逐样本时间、选中关系及两次观察，不混成详情任务字段 |
| 未确认当前主图观察 | 新主图任务 `unconfirmed_main_image_observations[].snapshot` | 保留最后有效DOM数据、原时间及是否为最新读取；不能认定属于请求的缩略图或作为已确认导出来源 |
| 详情图集 | `details.description.items` | 与正文分开交付；每图有 `position`、`url`、`loaded`、尺寸和区域来源 |
| 详情图准备状态 | 新读取可选`details.description.image_readiness` | 逐扫描元素记录状态和未扫描范围；正常尺寸不保证内容正确，异常小图不算实际图齐全；旧缓存不推算回填 |
| 规格选项图片 | 新任务`image_collection.options[]`及`missing_images`；成功后同值在result，旧日志仍用image_batches | 全部已扫描文字、逐项历次图片观察和明确缺项；自动分批及有限补查，不保证平台SKU／价格关系，见[说明](specification-images.md) |
| 规格选项集 | `specification_groups`、`specification_scope` | 返回组名、选项原标签、选中／禁用标记和计数；不展开笛卡尔积作为 SKU 表 |
| 指定组合观察 | `selection_evidence` | 只在相应任务中出现；说明请求的规格、选中确认及有限价格观察，不证明平台 SKU 归属 |
| SKU 来源线索 | `sku_evidence` | URL 的精确 `skuId` 仍是候选；未取得直接关系时选项及价格的 `sku_id` 为 null |
| 展示价格 | `prices` | 保留原文、标签、条件、单值／区间／起价；金额是十进制字符串，不是确定实付 |
| 店铺、服务、配送 | `details.shop`、`details.services`、`details.shipping` | 标签与展开说明分开；运费文案不保证具体地址适用，二级全文和优惠资格未核实 |
| 可售／购买提示 | `details.purchase.labels[].text` | 新读取可选字段；保留规格区原文，`stock_quantity`、`purchase_limit`、`sku_id`为null，不从“有货”推算库存 |
| 发货提示 | `details.shipping.dispatch.labels[].text` | 新读取可选字段；保留发货时限原文，不读取地址，不换算成到货承诺或保证具体地区适用 |
| 覆盖与缺失 | `coverage`、`missing`、`limits`，以及 `details` 内同名字段、`availability` | 同时检查顶层和详情层；旧快照缺少可选字段表示当时未采集，不回填成零或“没有” |

完整格式及上限见 [商品字段](products.md)、[规格组合](selections.md) 和 [服务流程](services.md)。当前基础字段仍有长度及条数上限；“原值”指在已说明的提取、规范化及截断范围内忠实保留页面内容，不是页面 HTML 的完整复制。

购买／发货提示分别保留来源、父区域是否观察到、已见／返回／省略数量和文本截断。两类各最多5条、每条200字符，旧结果没有对应字段表示当时未采集。2026-09-24原诊断收据下的生产详情读取已同次返回“有货”“48小时内发货”，保存校验通过，见真实验收。完整结果在私有.runtime/detail-media-delivery-20260923/recovery-20260924/details-result.json，字段位于顶层details；该文件是单次提取结果，不是task-status报告。前轮离线回放与新观察分开保留，不覆盖旧示例或任务时间。

后续[手机主图研究快照](../examples/data/phone-main-image.json)原样交付一张1280×1280静态主图的实际URL、加载状态、选中缩略图及两次一致观察证据。该快照来自同一诊断收据的有限追加，已恢复前轮程序留下的评价面板；关闭评价不是读主图的固定步骤。它不是正式 `task-status` 结果，也不是 `details.gallery` 的新字段。后续独立[主图正式任务](main-images.md)已实现，结果在 `result.samples`，未完成时已确认图片在 `partial_main_images`；后续已取得天猫鼠标单图的正式实页正例，见下表；不将手机研究快照改写为正式结果。覆盖仍为局部，未下载、未识图，原始分辨率及SKU图片归属未验证；见本次实页证据。

## 图片列表与文件

[第19项其他渲染来源JSON](../examples/data/mouse-specification-image-render-sources.json)独立交付节点／伪元素来源与候选。node.position仅是该次局部扫描序号；different_from_current为空表示检查字段没有不同于当前小图的受支持候选，不能解释为商品没有图片。fully_parsed只描述已交付字段，full_render_sources仍false；它不是正式CLI图片结果，不更新旧观察，见实证与边界。

[第19项视口对照JSON](../examples/data/mouse-specification-image-viewport.json)是另一份独立研究观察：source_timing明确滚动命令内的来源读取发生在动作前，动作后的图片只能使用after-1／after-2阶段；32×32渲染盒不等于2×2资源自然尺寸。进入视口后两读仍为小图，不能以动作回执充当图片加载成功证据，见对照记录。

规格图片的[14项来源诊断JSON](../examples/data/mouse-specification-image-sources.json)是独立研究观察，不是正式CLI结果或旧快照更新。current_src与attributes的candidate只表示URL通过格式校验，当前资源尺寸与loaded在current_resource；任何备用候选不继承该状态。本次仅取得同一2×2地址，四个data来源属性及srcset均不存在，实际规格图仍未确认，见实证边界。

只需要图片的调用方可直接参考[鼠标图片数据清单](../examples/mouse-image-delivery.md)和[JSON](../examples/data/mouse-image-delivery.json)：原5个商品图元素、独立1张已确认主图及其文件收据摘要，各自保留时间。该示例从历史结果整理，不是新的 `task-status` 子格式或实时刷新，不把两类数量相加。

普通图片集请求优先交付已有 `details.gallery.items` 或独立图集任务的 `gallery.items`，不用逐张切图或处理营销弹窗来证明元素URL可读。鼠标历史详情已包含5个商品图元素地址；它们来自缩略图区域，与随后独立确认的1张当前主图分别保留。

主图子格式2使用 `source: loaded_main_image_dom`，已加载图片即使 `uncovered:false` 也可作为DOM数据交付；点击仍检查可交互性和遮挡。未完成的 `unconfirmed_main_image_observations` 最多一项，`association.requested_image_confirmed:false`；快照中的当前图可能与请求图不同，`observation_is_latest_read:false` 表示后续读取失败或中断后留下的旧数据。旧主图子格式1不回填，不改变原确认规则。具体字段见[主图采样](main-images.md#交付字段)。

详情任务按 `items` 中的原顺序使用图片，导出时传实际 `position`。去重或省略可能使序号不连续，不能把数组下标加一作为详情导出序号。用 `elements_seen`、`elements_scanned`、`duplicates_omitted`、`unsupported_urls_omitted` 区分扫描、返回和省略；`availability` 还报告已加载与未加载数量。

2026-10-28 起 Skill 不再下载图片（用户决定）：只交付图片链接，调用方需要文件或看图时自己按链接取得。

`loaded: true` 表示页面观察时图片已加载，不表示 Skill 已下载文件，也不保证链接长期有效。

图片属于该商品页不证明其中所有型号或套餐属于选中 SKU。Skill 交付页面归属和位置，内容含义及如何使用由调用方分析。

## 可直接解析的历史 JSON 示例

下列文件逐字段等于对应正式 CLI `task-status` 中的原 `result`，未重写价格、补齐未知字段或混合不同时点。床笠文件是两份独立 `result` 组成的数组。来源操作序号从 0 开始；这只是示例索引，不是 SKU 标识。文件不含本机路径、标签 ID 或连接配置。

| 文件 | 原任务／操作序号 | 实际取得范围 |
| --- | --- | --- |
| [鼠标详情](../examples/data/mouse-details.json) | `specification-inventory-20260922`／0 | 15 项参数，5 商品图／25 详情图，1 组 32 项规格，正文空 |
| [手机详情](../examples/data/phone-details.json) | 同上／1 | 37 项参数，5 商品图／27 详情图，6 组 11 项规格，正文空 |
| [文字型图书](../examples/data/book-details.json) | `description-book-1-20260923`／0 | 12 项参数，338 字正文，5 商品图／1 详情图；未见规格组不能认定单 SKU |
| [床笠两个组合](../examples/data/bedding-selections.json) | `sku-dynamic-three-20260922`／4、5 | 每份均有 2 组 20 项规格；单件／三件套当时显示秒杀价 69／91 元，SKU 与价格直接归属仍未验证 |
| [图书展开服务](../examples/data/book-services.json) | `description-book-services-20260923`／0 | 后一时点取得两条服务说明，保留正文和未验证标记；不覆盖先前图书快照 |
| [鼠标静态主图](../examples/data/mouse-main-images.json) | `main-image-mouse-20260924`／0 | 独立主图格式 `samples[]`；1张800×800实际主图、选中及两次一致证据，3次观察／1次点击，未下载 |

原鼠标／手机五张已下载文件来自更早的 `product-details-20260922`，应使用该任务原收据回读；上表较晚的详情快照不继承下载次数，也不是重新下载的理由。本轮仅核验既有五张文件的大小、来源及 SHA-256，没有下载余图。

2026-09-25后续主图导出已实测：鼠标正式任务的 samples[0] 导出一张800×800 WebP、24740 bytes，原详情图片仍5/6，主图来源1/6。两份收据各自保留；相同URL的新预留被拒绝，须沿原项处理。Node22 CLI缓存回读及全部六张文件的离线校验通过，未识图；见导出证据。上表“未下载”为原采样时点，不修改历史JSON。

## 评价数据接续

2026-09-23 后续更正：原鼠标评价内容曾整体在视口左侧，旧可见性检查漏判。下列历史 JSON 不能据此证明面板实际展开，也不能把 covered 解释为实际可见图片被平台遮挡。新文字任务使用[分类采样](review-text-sampling.md)，子格式4不读取媒体；真实已确认“全部”10条主评／10条商家回复及“追评”10条主评／10条追评文字。原格式失败、此前 partial_category_samples 和两类恢复结果分别保留，不覆盖旧观察时点；完整新结果在私有 .runtime/review-text-categories-20260923/recovered-text-result.json。后续自动打开验收在另一天猫635398543460取得“全部”8主评及1追评，保留21条总量和13条折叠提示；完整正式结果在私有 .runtime/review-panel-open-20260923/formal-task-report.json 的 operations[0].result。见自动入口证据。普通淘宝图书后续已确认“全部”2条文字，图/视频切换后列表三次未变而停止；该部分报告的结果位于私有 .runtime/review-taobao-text-20260923/formal-task-report.json 中 operations[0].partial_category_samples[0].snapshot.reviews，不能误用完整结果 samples[i].reviews 的路径，不能把未确认分类当成功。后续新建文字任务可在 operations[0].unconfirmed_category_observations[i].snapshot.reviews 返回最后一次有效但未确认的文字，association明确未验证；后续错误用latest_read和observation_is_latest_read区分。旧报告不补写此字段，见[交付与兼容](review-text-sampling.md#未确认观察的交付)。旧 --reviews 及公开示例原样保留，不为新范围改写。

评价结果同样位于 `operations[i].result`。新子格式 3 包含主评、追评、各自商家回复、关系省略计数和各条所属的图片位置；见 [评价字段](search-and-reviews.md#评价子格式-3关联范围与图片集)。[手机新格式 JSON](../examples/data/phone-reviews.json) 中 8 个位置为 covered，实际图片地址为空；[鼠标新格式 JSON](../examples/data/mouse-reviews.json) 取得 20 条主评、1 条追评、19 条商家回复及 52 个 covered 位置，同样没有实际晒图地址。[历史天猫 JSON](../examples/data/mouse-reviews-legacy.json) 为子格式 2，没有图片观察字段。这些文件分别等于各自任务原 result，不能合并为同一时点的完整数据集。

本轮评论图片文件导出未实现；现有详情 `image-export` 不接受评价任务。鼠标新任务已保留原地址失败及预算后恢复完成；累计 4 次读取预留、1 次展开预留、1 次恢复及 5000 ms 恢复等待。新旧观察各自保留时间和覆盖范围，遮挡位置不能作为实际图片文件交付。

## 历史交付验收与保留边界（2026-09-23）

以下数量和结论属于该次验收；当前逐项结论见[详情能力表](detail-capabilities.md)，不将旧的五图缓存数量或展开边界当作当前结果。

2026-09-23 离线校验 40 个有效任务、9 件商品的 17 份详情快照，以及五张已有图片。40 个任务缓存回读零页面调用；76 个原状态／收据／图片文件 SHA-256 不变。新标题／价格区域歧义保护通过合成 DOM 回归，Node.js 22.16.0／24.13.0 各 310 项测试通过，本轮未重新读取实时商品内容。

| 能力 | 当前结论 |
| --- | --- |
| 已加载文字、参数、图集、规格、展示价及有限服务说明的结构化交付 | 有限真实样本及历史缓存交付已核验；调用方可直接使用上表格式 |
| 图片文件及失败恢复 | 五张真实缓存来源／字节校验通过；显式失败恢复仅离线验证，原图片请求额度仍为 5/6 |
| 自动展开、冷启动懒加载、全量图集／服务全文 | 仍受限或未实现；只有明确入口或未加载范围才追加有限检查 |
| 平台 SKU 与规格／展示价直接对应、完整 SKU 集、库存 | 尚未核实；保留 null／false，不由选项或价格变化推导 |
| 图文冲突裁决、识图、摘要、推荐 | 调用方自主决定，不作为采集成功条件 |
| 视频 | 当前范围排除，原未读取标记保留 |

这次验收的是已经支持的数据交付，不是“商品全部信息已取得”。详细验证方式见 本轮记录。
