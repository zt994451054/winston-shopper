# 当前商品快照的含义

单张详情图的有限加载观察使用独立[--description-image-load POSITION](description-image-loading.md)：原始IMG位置、最多一次来源保护后的滚动、六次内容观察和三个后检查；结果另列`description_image_loading`，普通详情仍只读。完整路径仅离线验收，不把正常图片确认当成滚动因果或SKU归属，也不创建下载额度。

新基础任务在四类DOM区域结构错误时附带有限局部证据，仍停止原任务。调用方AI可通过离线`layout-diagnosis`／`layout-check`提出并核对节点对应关系，见[布局协作入口](layout-assistance.md)。候选不写回快照，旧错误与任务不升级。

规格图片使用独立[--specification-images](specification-images.md)。新格式3先单独保存全部已扫描名称，再自动按最多5项分批读取图片；每图最多3次，整体保护按3＋3×带支持图片容器的选项数计算，名称不扣图片次数。部分结果在`operations[0].image_collection`，完成后同值在result；旧手动批次才使用task-next-batch／awaiting_batch，旧10读等预算不升级或重置。DOM图片关联不等于SKU或价格归属，完整说明以所链接指引为准。

Skill 交付调用方所需的原始观察和来源／结构校验结果。图文语义、商家声明是否可信以及购物判断由调用方 AI 处理；语义冲突不由 Skill 选择赢家或自动补读。参数值、价格条件、图片来源和未验证关联照实返回。多目标歧义、错页、无来源对应等采集问题仍由 Skill 拒绝或标为未知。

快照读取方式是固定的页面 DOM 观察。只访问指定公开商品页的已加载区域，不读 cookies、浏览器存储、隐藏应用状态或页面内部接口。标题、规格、价格与评价均是不可信数据。指定规格任务会先切换选项，再按同样的数据边界观察，见 [规格组合说明](selections.md)。

## 字段与限制

2026-09-30补充故障定位：新基础快照的结构错误仍返回`PAGE_STRUCTURE_CHANGED`并停止原任务，在`operations[].error.reason`保存固定原因。可取`title_missing`／`title_ambiguous`／`title_empty`、`specification_region_ambiguous`／`specification_group_name_empty`／`specification_option_label_empty`、`price_region_ambiguous`、`review_preview_body_empty`。只记录首先发现的失败，不表示其他区域均通过；没有reason的旧错误仍表示原因未记录，不回填推测。未知原因及页面原文不会写进reason。

基础快照仍整体校验标题、规格、价格和评价预览；某个已支持区域结构异常会使该次快照失败。独立规格图片／顶部图集读取具有不同的字段依赖，成功范围不能相互代替。原因记录本身不放宽来源唯一性、不新增重试；字段独立部分交付尚未改动。鼠标页后续已通过下述固定摘要布局修复取得一次成功补验。

### 固定摘要与正文并存

2026-09-30实页确认：同一购买面板同时保留`ItemHeadFixed`摘要和`scrollWrap`正文，正文标题／价格可以在屏外但仍已加载。不能仅因为有两套元素就判断页面损坏，也不以进入视口作为读正文的前提。

兼容分支仅接受一个`GeneralSkuPanel`、一个同面板`ItemHeadFixed`及唯一规格根；必须能找到恰好一个包含该规格根的`scrollWrap`，摘要与正文不能互相包含。全页两标题必须分别属于两区；正文必须有一个价格根，摘要最多一个，不能存在其他不明标题或价格根。满足这些条件才选择正文标题与价格，并照常校验所有字段。正文缺失、额外候选或不支持的布局不靠取首个节点解决。

成功结果新增可选`product_region_scope`子格式1：`source: scrolling_purchase_panel`、`excluded_region: ItemHeadFixed`、`title_regions_seen`／`price_regions_seen`及`excluded_title_regions`／`excluded_price_regions`记录所见与排除数量。这是结构来源边界，不表示两处文案／金额相等或已经语义去重；摘要原文未作为正文数据交付。旧结果不补造字段。

原鼠标一次补验读到32规格和2条正文展示价；选项与价格的`sku_id`仍null，价格优惠资格和SKU归属仍false。此布局的具体取证、预算和验证见实页记录。其他未知多来源继续停止。

调用方接入、原时点 JSON 示例及交付验收见 [数据交付](data-delivery.md)。基础区域保护仍适用：无法按上述已支持结构唯一归属的多个标题或价格根，以`PAGE_STRUCTURE_CHANGED`停止，不自动重试。隐藏副本排除；同一区域内多条价格正常返回。

| 字段 | 可用信息 | 不能据此推断 |
| --- | --- | --- |
| `product_id`、`url`、`title` | 两次校验目标后取得的商品身份和页面商品标题 | 平台 SKU ID、账号已登录 |
| `specification_groups` | 最多 8 组，每组最多 100 个已加载选项；可观察的选中、禁用标记 | 全部 SKU 组合、准确库存、完整可购买性 |
| `specification_scope` | 新读取记录规格区域是否观察到、已见／返回／省略的组数及每组的选项数 | 已见选项可以任意组合、完整 SKU 表、库存或每个组合的价格 |
| `prices` | 最多 6 条展示价格；原文、标签、起价／区间／单值、条件标记 | 确定实付、用户优惠资格、某一 SKU 的已验证价格 |
| `sku_evidence` | 同次观察时当前 URL 的精确 `skuId` 候选、来源和参数状态 | 该值与选中组合或价格已建立直接绑定 |
| `review_previews` | 最多 5 条，正文最多 2000 字符及日期区域原文 | 最新排序、全部评价、稳定评价 ID、完整正文 |
| `coverage`、`missing` | 取得范围和未验证／未取得项目 | 空数组就是平台上不存在数据 |

规格的 `selected: null` 或 `disabled: null` 表示没有观察到肯定标记。`disabled: true` 来自 `aria-disabled="true"`、`data-disabled="true"` 或已支持的禁用 class，只表示页面禁用该选项，不等同于库存为零。`sku_id` 始终为 `null`，不会用本地组合键冒充平台 ID。

普通快照保留实际选中标记；如果一组里多个选项同时带选中标记，不能解读为该组合已确认。指定规格任务会以 `SELECTION_STATE_CONFLICT` 停止当前平台队列，保留预算并等待诊断，而不是选择其中一个或自动重试。

`specification_scope` 子格式 1 包含 `region_observed`、`groups_seen`、`groups_returned`、`groups_omitted`，以及按 1 起始组序号对应 `specification_groups` 的 `groups` 数组；每项保存 `group_index`、`options_seen`、`options_returned`、`options_omitted`。只统计支持区域内实际可见的节点，超过 8 组／每组 100 项时保留省略数量，不自动扩大读取。`full_sku_matrix_verified` 始终为 false；省略数为 0 也不证明没有折叠、动态加载或受其他选择影响的选项。

旧缓存没有 `specification_scope` 表示当时没有采集计数，不能根据已返回数量回填“无省略”。多个可见规格根区域会停止，不取第一个。新观察存在省略时，指定组合流程在点击或确认前返回 `SELECTION_AMBIGUOUS`；即使目标项已选中也不认定完整组合确认通过。

默认商品输出应包含已读取的各维度和选项清单，保留原标签、选中和禁用标记，不能只输出当前选中项。选项较多时在附表列全并给出覆盖数量。规格选项不等于平台 SKU：不能将手机的颜色数 × 容量数 × 套餐数当作已存在、可售或有价格的 SKU 数量。

新增 `sku_evidence` 子格式为版本 1。`source: current_product_url`、`parameter: skuId` 标明来源，`candidate_sku_id` 以字符串保留候选值，`sku_properties_present` 只记录是否存在规格属性串，不保存或转换其内容。状态如下：

| `status` | 含义 |
| --- | --- |
| `candidate_only` | 精确参数只有一个、为 1–64 位正整数字符串且不同于当前商品 ID；仅格式符合要求 |
| `parameter_absent` | 没有精确 `skuId` 参数；不尝试用 `sku_properties`、`data-vid`、其他大小写或别名代替 |
| `ambiguous_parameter` | 精确参数出现多次，即使值相同也不选择其一 |
| `invalid_parameter` | 参数为空、格式或长度不符，或等于当前商品 ID；候选返回 null，不保留原始非法内容 |

`selection_binding_verified`、`sku_price_binding_verified` 均为 false。URL 可能陈旧或来自用户输入，和规格／价格同时出现不证明直接归属；不会据此填充任何选项或价格的 `sku_id`。`missing` 中未验证 SKU 与价格映射仍保留。旧结果没有 `sku_evidence` 时原样回读，不能把“未采集”改成“未发现”。

2026-09-30补查原鼠标购买入口公开来源：61个支持候选中匹配“加入购物车”，对自身、上两层及一个可见后代共4节点检查，未见精确SKU属性；可见SKU微数据0。黑色选中、URL候选6270968490579与89／159展示价仍只作同次独立观察，不升级关联。该限定研究已结束，未新增CLI能力；来源与范围、[完整JSON](../examples/data/mouse-purchase-sku-sources-20260930.json)保留原值，不回填旧任务。

价格金额使用十进制字符串。比如“店铺优惠后 ￥89 起”返回 `kind: starting_from`、`minimum: "89"`、`amount: null`；保留“店铺优惠后”和“起”。价格解析失败保留原文及 `kind: unparsed`，不会填零。

普通快照不进行规格切换。指定组合任务已能核对选中状态和价格读数变化，但未取得平台 SKU ID 与价格的直接绑定证据，所以 `sku_price_binding_verified` 仍为 `false`。`eligibility_verified` 也始终为 `false`。具体观察证据见结果中的 `selection_evidence`。

评价仅保留正文和日期区域，不读取头像或用户名。同文案的两条评价不会仅凭正文合并。`observation_index` 只是本次观察中的次序，`review_id: null`；页面预览可能已经省略内容，因此 `text_may_be_truncated: true`。

## 商品详情模式

需要正文展开与有限后读时，使用独立单商品[--description-expand](description-expansion.md)。仅支持可明确核对的正文控制关系；没有入口或关系不足时返回已有详情与边界。普通 `--details` 的只读行为及所有旧任务保持。

当前消费者详情范围聚焦文字和静态图片，不执行视频播放、抽帧、下载或音频转写。已有视频元素计数及 `video_contents`／`videos_extracted: false` 继续真实保留；它们说明覆盖边界，不表示本阶段必须继续读取视频。图文完整性仍按实际证据判断。

只需要顶部静态商品图集时使用独立[--gallery](gallery.md)，每批一个商品，不读取其他详情或当前大图。原详情模式继续复用同一图集提取器，旧结果及原position不回填。

用户请求参数、图片、店铺或服务说明时，在基础快照上增加受限详情观察：

```sh
node scripts/shopping.mjs task-start --task mouse-details --bindings mouse --details
node scripts/shopping.mjs task-run --task mouse-details
```

最多 10 个绑定，按商品 ID 去重。与评价展开、规格计划、搜索模式互斥。任务类型为 `product_details`，新读取返回基础快照及 `details` 子格式 2；旧子格式 1 继续校验和原样回读，不自动补入新字段或观察。

| 详情字段 | 来源及上限 | 解释边界 |
| --- | --- | --- |
| `shop` | 商品页店铺标题与支持的店铺链接 | 去除链接跟踪参数；不访问店铺页，不核验店铺资质 |
| `attributes` | 参数区域最多 100 行；名称 120 字符、值 1500 字符 | 保留重点／普通参数来源；属于商品页描述，不是独立核实的厂家数据 |
| `gallery` | 已加载商品图缩略图，最多扫描 20 个图片元素 | 保存实际图片地址、加载状态和尺寸；不推导原图地址，不混入视频封面或推荐图片 |
| `description` | 已加载详情区域最多 60 个图片元素、6000 字符文本，以及视频元素计数 | 图片链接与文本分开；排除已识别的公益模块；不识别图片文字，不提取视频内容 |
| `services.labels` | 保障区域最多 20 条标签，每条 200 字符 | 保留“7天价保”等展示标签；不等于完整服务条款或用户资格已核实 |
| `services.terms` | 新读取可附带已展开服务浮层中的说明；最多 20 项、每项正文 2000 字符 | 仅在唯一已展开入口与浮层有序标签一致时关联；不打开二级条款或核实资格 |
| `shipping.freight_labels` | 配送区域最多 5 条运费文案，每条 200 字符 | 不读取配送地址，不据此推断指定地址的运费或到货时间 |
| `shipping.dispatch` | 新读取可选字段：配送区域 `shipping` 标签，最多5条、每条200字符 | 保留“48小时内发货”等原文；发货不等于到货，`arrival_time: null`、`conditions_verified: false`，不读取地址 |
| `purchase` | 新读取可选字段：规格区 `quantityTip` 提示，最多5条、每条200字符 | 保留“有货”等原文；库存数量、限购数量、SKU ID仍为null，可售保证未验证 |

`purchase` 与 `shipping.dispatch` 各自使用子格式1，包含 `observed`、`labels_seen`／`labels_returned`／`labels_omitted`、`labels[].text`／`text_truncated`、固定来源和上限。`observed`表示对应父区域被观察到；区域内没有支持标签与整个区域未观察到分开，均不推断没有库存或配送规则。标签重复保留，不合并不同提示。源分别为 `sku_quantity_tip` 与 `delivery_shipping_label`，不从标题、规格选项名或店铺平均发货指标补值。两字段沿用详情子格式2，旧快照缺失时不回填。

新字段已接 `--details`，也随服务任务中的详情读取返回。2026-09-24沿原诊断收据执行生产详情读取，真实手机同次取得“有货”“48小时内发货”，保存格式校验通过；见字段验收。后续在用户同意的有限追加内恢复前轮留下的评价面板，再选择一张静态缩略图，连续两次取得同一1280×1280主图实际URL；见面板收尾与主图验证。正式 `--details` 的商品图集仍取自缩略图区域，这次主图样本来自有预算的研究流程，后续选择与读取已接独立[主图采样](main-images.md)正式入口，未改动 `--details` 的缩略图格式；该入口后续已在天猫鼠标单图上实页通过，3次观察／1次点击取得800×800主图，两次一致、零重试，见实页记录。424项Node22／24生产测试为前轮基线；单图实证不代表完整主图集、原始分辨率或SKU图片归属已验证。

重点参数的标题位置是数值、下方是名称，普通参数的顺序相反；分别定位，不能将同一读取规则套到两种布局。重复名称保留原行，不无依据合并。

同一参数行的名称／值或店铺标题存在多个可见候选时停止，不取第一个；隐藏副本排除。不同参数行名称相同并不构成这种歧义。

`services.terms` 子格式 1 保留 `panel_observed`、`entry_expanded`、`items_seen`／`items_returned`。各项包含原标签、标题、正文、`body_truncated`、`body_clipped` 以及未打开的 `additional_entry_labels`（已支持“更多”“查看”）。正文自身溢出裁剪时整段省略并标记；超出 2000 字符截断并标记。浮层、行标题或正文容器有歧义时停止，不选择第一项。

`association_basis: expanded_entry_and_matching_labels` 只表示当前商品入口的展开标记和浮层有序标签一致。`full_terms_verified`、`eligibility_verified` 始终为 false，`missing` 仍保留完整服务条款。未见浮层返回 `panel_observed: false`，不能解释为无服务；旧缓存没有 `terms` 时原样保留，不回填。原 `coverage.service_scope: displayed_labels` 保留标签级基线，新增说明的取得范围单独看 `terms`。

`--details` 只读取已经展开的支持浮层，不自动打开服务入口。需要有限展开时使用独立的 [`--services` 任务](services.md)，持久化唯一动作及后观察预算。2026-09-23 在短袖与原手机上分别实测取得 6／3 条说明，包含剪标／使用／洗涤、激活／使用等排除条件；价保和赔偿项的二级完整规则仍未读到。见[服务说明示例](../examples/service-terms.md)。

子格式 2 增加 `availability`，由本次已校验结果计算：`parameters` 保存 `returned_rows`／`unscanned_rows`；`gallery`／`description` 保存 `returned_images`、`loaded_returned_images`、`not_loaded_returned_images` 和 `unscanned_elements`。这些未扫描计数仅针对已观察到的元素；0 不证明不存在折叠内容。未加载不自动归因为懒加载，也可能是加载失败。

`description.content_kind` 区分 `region_not_observed`、`no_supported_content_observed`、`image_links_only`、`text_only` 和 `text_and_image_links`。正文为空但有图片链接不会被描述为“商品没有说明”。`image_text_extracted`、`unloaded_or_folded_content_verified` 保持 false；旧格式没有摘要表示当时未输出该字段。

新读取可附带 `description.observation`（内部格式 1）。正文只在唯一可见 `.descV8-container` 中提取，包含直接文本节点；排除隐藏节点、图片／视频模块、公益模块及脚本等内容。检测到自身溢出裁剪的子树整体省略，避免把尚不可见的文本作为已读正文。这可能遗漏可见的前半段，属于保守的部分覆盖。

正文遍历从已观察的详情区域开始，最多访问 800 个节点、深度 12、保留 6000 字符；`nodes_scanned`、`traversal_truncated`、`text_truncated` 和 `clipped_subtrees_omitted` 单列本次范围。`control_candidates` 最多 8 个，只记录区域内带受支持语义和展开／收起等文字的控件，`controls_truncated` 标明截断。它不点击控件，不证明控件归属或展开效果；`expansion_behavior_verified` 始终为 false。候选为空不证明全页没有折叠、浮层或其他形式的入口。旧缓存没有 `observation` 表示当时未记录，不补写为“未观察到”。

图片按实际 URL 去重，保留原位置和 `elements_seen`、`elements_scanned`、`duplicates_omitted`、`unsupported_urls_omitted`。目前只保留不带查询参数或片段的阿里图片 CDN 链接；不支持的链接计数后省略，不访问跳转。链接不是下载文件，也没有永久可用保证。

2026-10-01新详情观察附带可选 `description.image_readiness` 子格式1。它保留原扫描的每个元素位置，含重复链接及没有支持URL的项；计数针对元素，不能与去重后的文件数量混用。`region_observed`、`elements_seen`／`elements_scanned`／`unscanned_elements`说明范围，`entries`保存位置、受支持URL或null、`url_state`、浏览器 `loaded`、自然尺寸及 `status`。未支持的原始URL不保存。`full_description_verified`始终false。

| `image_readiness.entries[].status` | 证据含义 |
| --- | --- |
| `normal_size_loaded` | 支持URL，浏览器资源已加载且自然宽高都大于2；未核验图片内容或商品归属 |
| `tiny_image_unresolved` | 支持URL且资源已加载，但任一自然尺寸≤2；实际图片仍未确认，不直接断定懒加载或无图 |
| `not_loaded` | 支持URL，浏览器尚未报告加载完成 |
| `url_not_observed` | 该扫描位置没有图片URL，位置与尺寸观察保留 |
| `unsupported_url` | 该位置URL不在支持范围，原地址省略 |

原 `description.items[].loaded` 和 `availability.description.loaded_returned_images`仍表示浏览器资源加载，1×1资源也可为true。正常尺寸数量应查新元数据的 `counts.normal_size_loaded`，不能用旧加载计数保证图片齐全。旧缓存缺少新字段表示当时未采集此证据，不回填。保存校验会核对新元数据与原去重列表的同次来源、顺序、尺寸和省略数量。

原普通淘宝745476354604三次限定实页观察均为1个1125×1446链接和1个1×1未确认资源；正常滚动一次后小图进入视口但链接／尺寸未变。生产新字段已有实页验收，自动滚动加载成功尚未验证，正式详情读取仍不滚动；见结果与边界。

`details.coverage.status: partial` 与 `full_description: false` 始终保留。`image_text_extracted: false` 表示图片内容尚未识别；详情文本为空不代表图片里没有说明。未加载、折叠、超过上限的内容和完整服务条款仍属于缺失范围。缺少单一区域可返回部分结果；全部详情区域均未识别时返回 `UNSUPPORTED_CAPABILITY`，同类区域出现多个候选或参数缺少名称／值时停止并报告结构变化。

详情读取只做一次固定 DOM 观察，不滚动、展开、下载图片或调用隐藏接口。单次响应最多 1 MiB，整份任务检查点最多 4 MiB；超限明确失败。

详情任务先查 tabs。本次 Playwright 连接清单缺失原保存 ID 时，可在该精确 ID 内仅核对地址，仍匹配同商品才读取；不聚焦、不自动换活动标签或遍历窗口。普通商品、详情、规格选择和正式服务流程复用同商品地址保护；首屏搜索有独立的同关键词第 1 页只读保护，均不能借此发现用户自己打开的页面。失败按原任务暂停和预算处理，内容读取仍再次检查身份及页面拦截。

需要理解图片内容时，使用独立的 [图片导出与读取](image-reading.md) 流程。它从完成的详情快照中选择最多 6 张图片，保存文件和来源，交给具备视觉能力的 agent 解读。DOM 快照的 `image_text_extracted: false` 保持不变，解读另列；没有视觉能力时明确降级。

结构化商品结果可直接交给调用方 AI。其如需消费者说明，可参考可选的 [详情摘要](detail-summary.md)；摘要、识图和冲突裁决均为下游分析，不作为当前采集是否完成的判据。

2026-09-22，现有天猫鼠标和普通淘宝手机分别取得 15／37 项参数、5／5 张去重商品图链接、25／27 张详情图链接，以及店铺、服务和运费文案；均一次读取成功、零重试。两例详情正文均为空，主要内容在图片中。文字型详情的通用路径通过合成 DOM 测试，真实文字型布局和懒加载完整性仍待验证。

同日新增正文范围观察，两个样本各访问 32 个节点，未触及上限、未省略裁剪子树、未找到受支持的展开控件，仍为图片链接型。补读图片发现鼠标首图为其他型号推荐，手机首图的“店保 2 年”与参数“保修期 12 个月”不一致；解读必须区分商品归属并保留冲突，见 [图片读取](image-reading.md)。

## 页面状态

读取前先检查商品身份，再检查可见的验证控件、登录框和对话框等已知信号。遇到明确拦截返回对应状态；标题区域找不到或结构不匹配时停止。没有刷新、模拟验证码或绕过行为。

这些识别基于已知 DOM 信号，不能证明所有风控样式均已覆盖。`page_state: supported_regions_observed` 仅表示找到支持的商品区域，不代表登录、全页完整性或风控检测完全通过。

## 已验证与待验证

2026-09-15，macOS / 日常 Chrome，一个天猫罗技 M330 商品：32 个规格标签、两种不同优惠标签的起售价、两条评价预览。新标签页曾切换为促销横幅价格布局，补充该实际布局后读取通过。已适配的价格容器包括正常布局和促销横幅布局；隐藏的旧布局不会提供结果。

随后新增普通淘宝 6 维规格商品样本，并在淘宝／天猫各验证两个明确组合，取得切换后的稳定展示价格。平台 SKU 与价格直接对应、完整评价分页、更多布局和跨日稳定性仍未验证。后续按每项能力记录成功、受限与失败，不能用这些样本宣称淘宝平台全能力稳定。

实际文字验收（2026-09-23）：普通淘宝图书样本返回 338 字正文，12 项参数；一次限定复核确认正文处于 `descV8-richtext`，两次内容一致。未触及遍历上限且没有受支持展开候选，不等于折叠行为或完整正文已验证。空的出版日期、页码等不从标题或参数补齐；标题与参数年份冲突保留。见[图书摘要](../examples/detail-summary-book.md)。

2026-09-30错误边界补充：PAGE_STRUCTURE_CHANGED可能来自标题缺失／重复、规格区重复、价格区重复或字段不完整，不能统一理解为标题缺失。当前生产提示已纠正，原错误码及停止规则不变；鼠标新来源研究停在该校验，尚无新SKU观察，见诊断准备。
