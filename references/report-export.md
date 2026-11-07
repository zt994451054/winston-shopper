# 本地缓存报告导出

`report-export` 将一个已保存任务转换成 Markdown 或 CSV，仅读取本地检查点。无需浏览器连接，不执行任务、恢复或图片下载，不改变读取／恢复／等待预算。

```sh
mkdir -m 700 ./reports
node scripts/shopping.mjs report-export \
  --task sample \
  --state-dir /absolute/path/to/original-bindings \
  --format markdown \
  --output ./reports/sample.md

node scripts/shopping.mjs report-export \
  --task sample \
  --state-dir /absolute/path/to/original-bindings \
  --format csv \
  --output ./reports/sample.csv
```

输出父目录必须存在，文件名必须未使用，输出不能位于原状态目录或指向该目录的符号链接中。文件权限为 `0600`，成功回执仅含路径、格式、任务状态、条数、字节数和 SHA-256，不把购物数据打印到终端。不接受 `--endpoint` 或其他浏览器参数。

## 支持范围

| 缓存任务类型 | 导出内容 |
| --- | --- |
| `cart_snapshot`、`cart_collection` | 已观察购物车行、规格、数量来源、店铺区域、价格原文及缺项；2026-10-13 起的新任务每行另有 `cart_availability` 记录（标签为能否购买的状态，原文为不能购买的原因，限定写商品图上的文字，`disabled` 为勾选框状态），覆盖范围列出 `availability.*` 各状态行数 |
| `order_snapshot`、`order_collection` | 已观察订单组、商品位置、数量、状态、日期、订单／商品金额原文 |
| `order_pages`（2026-10-13 起） | 订单列表多页。每页一个观察，保留各页自己的采集时间；每页先有一条 `order_pagination`（当前页、总页数、上下页是否禁用、标签、搜索框是否为空），再是该页订单的各项记录。全任务的 `returned_orders`、`distinct_orders`、`end_reason`、`all_listed_pages_read`、`total_pages_changed` 列在 `collection_coverage` 中。订单位置是页内位置，页码在 `batch_position`。确认为空的最后一页也单独作为一个观察，订单数为 0。未完成的任务只导出已确认的页 |
| `order_body_snapshot` | 单订单正文中的商品、流程状态和金额，以及入口／列表来源 |
| `product_snapshot`、`product_details`、`product_services`、`product_description_expansion` | 商品基础信息、规格选项、展示价和已缓存详情文字 |
| `search`、`search_collection`（2026-10-13 起） | 首屏搜索和 1～5 页搜索。各项记录如下：<br>• `search_item`：平台原顺序的商品，包括位置、编号、标题、链接、价格原文和价格标签；<br>• `search_shop`、`search_sales`：每张卡片的店铺和销量原文；<br>• `search_scan`：扫描数、略去的重复卡片和不支持的卡片数；<br>• `search_pagination`：多页任务每页的分页状态。<br>多页任务每页一个观察，保留各页自己的采集时间和来源地址；全任务的 `records`（已返回记录数）、`distinct_products`（去重商品数）和 `end_reason` 列在 `collection_coverage` 中，两个计数含义不同，不能互换。未完成的多页任务只导出已保存的页 |
| `search_price`（2026-10-12 起） | `price_condition`：已应用的方向和区间，附带重新打开浮层时看到的标记；`search_item`：平台原顺序的商品及其显示价，并标注是否在请求区间内；`local_price_order`：按显示价本地排序的列表，附带平台位置，并标注 `not_platform_order`；`price_check`：顺序核对和区间核对的结论。采集时间取最终第 1 页快照的时间。请求天猫或包邮时，`price_condition` 里另有 `source` 和 `filter` 两类记录。多页任务另有 `price_paging`（读到的页数、结束原因、最后一页的核对结果）；第 2 页起每页单独一个观察，只含该页的 `search_item`，保留各自的采集时间；本地重排的说明里注明平台页码 |
| `search_sort`（2026-10-14 起） | 销量排序。`sort_condition`：请求的排序，限定里写点击前后页面标着的排序标签；之后是排序后第 1 页的 `search_item`、`search_shop`、`search_sales`、`search_scan` 和 `search_pagination`，与首屏搜索相同。采集时间取排序后的快照 |
| `product_gallery`（2026-10-14 起） | 顶部图集。`image_scan`：看到、检查、略去的重复和不支持的图片数；`image_link`：每张图的位置、链接和是否已加载 |
| `product_main_images`（2026-10-14 起） | 指定缩略图的主图。每张一个观察，保留各自的采集时间；`main_image` 写主图链接和是否已加载，限定里写缩略图链接、尺寸，以及选中标记和两次读取是否一致 |
| `product_specification_images`（2026-10-14 起） | 规格图。每个规格项一条 `specification_image`：规格组、位置、名称、图片链接（没有则为空）、是否已加载，以及取得这张图的时间；限定里写取图状态（如 `loaded_image_link`、`no_supported_image_container`）和尝试次数。另有一条 `specification_collection` 写结束原因。观察的采集时间取规格清单的读取时间 |
| `product_review_categories`（2026-10-14 起） | 按分类读的评价文字。每个分类一个观察，保留各自的采集时间，记录如下：<br>• `review_category`：分类名、评价总数原文，限定里写排序文字和分类切换核对；<br>• `review_category_option`：页面上的分类标签、数量原文、是否选中；<br>• `review_scan`：加载、返回、略去的条数；<br>• `review`：每条评价的购买信息原文（日期和所购规格）与正文；<br>• `review_followup`：追评；<br>• `review_seller_reply`：商家回复，标签写明回复的是评价还是第几条追评。<br>每条记录的规格组列写分类名 |
| `jd_search`（2026-10-15 起） | 京东搜索首屏。记录与淘宝首屏搜索相同：`search_item`、`search_shop`、`search_sales`、`search_scan`；另有每张卡片一条 `search_marks`，原文写 `self_operated`（自营小图）、`sponsored`（广告）和 `tags`（如包邮），都是页面标记，未核实。结果格式 2 还有 `search_other_amount`：价格旁边的另一个金额，标签写 `line_through` 或 `no_line_through`（是否带删除线），含义页面没有说明。覆盖范围列出 `scope`（`first_screen_loaded_cards`）和 `in_stock_only`（“仅显示有货”是否勾选） |
| `jd_search_pages`（2026-10-21 起） | 京东搜索第 1～N 页的首屏，每页一个观察，`batch_position` 是页号，各带自己的读取时间。每页先有一条 `search_pagination`（标签 `pager`，原文写当前页号、总页数原文和“上一页”“下一页”是否可用；限定写从哪一页点过来、点击回执、看了几次和错误码，第 1 页写 `start_page`）和一条 `search_scan`（`cross_page_duplicates_omitted`，这一页略去的、前面页已列出的商品数），然后是与 `jd_search` 相同的卡片记录。覆盖范围列出 `scope`（`first_screen_loaded_cards`）和 `in_stock_only`；汇总覆盖范围列出 `scope`（`first_screen_loaded_cards_per_page`）、`url_reflects_page`、`page_transition_verified`、`all_listed_pages_read`，以及 `pages_read`、`distinct_products`、`cross_page_duplicates_omitted`、`end_reason`、`total_pages_text`。中途停下的任务不导出已读的页 |
| `jd_search_sort`（2026-10-22 起） | 京东排序后的搜索第 1～N 页首屏，每页一个观察。第 1 页先有每次排序点击一条 `search_sort_click`（标签“销量”或“价格”，原文 `active_after=选中项`，限定写点击回执、看了几次、错误码、“价格”图标点前点后和价格顺序核对：方向、状态、比较卡数、顺序／逆序／相等对数）；每页一条 `search_sort_state`（标签为选中项，原文写综合、销量、价格是否选中和“价格”图标文件名，限定写这一页的价格顺序核对，销量排序写 `no_order_check`），然后是与 `jd_search_pages` 相同的记录。汇总覆盖范围另列 `url_reflects_sort` 和 `sort_direction_verified`，以及 `requested_sort`。带价格区间的任务（2026-10-22 起）第 1 页最前面另有一条 `search_price_range`（标签“最低-最高”，原文为“价格区间”按钮文字，限定写点击回执、看了几次、错误码、比较卡数、区间外张数、跳过的广告和读不出的卡片），每页一条 `search_price_range_check`（原文 `range_button=按钮文字`，限定同上），覆盖范围另列 `price_range_verified`。中途停下的任务不导出已读的页 |
| `jd_product`（2026-10-15 起） | 京东商品详情。`product`、`product_marks`（自营、标题小图、评价数）、`product_price`、`price_other_amount`、`product_shop`、`product_series`；`same_group_spec` 每个同组规格选项一条（京东每个规格是独立商品，所以不带价格），缺货写在 `disabled`；`service_label`（格式 3 起标签为服务名称、原文为说明）、`parameter`（亮点参数的限定为 `highlight`）、`image_link`（缩略图标签 `gallery`，详情图标签为区域名，限定写 `kind=img` 或 `kind=css_background`）；`detail_section` 写详情区状态和滚动情况。格式 4 另有 `review_summary`（标签为 `loaded` 或 `missing`，原文为标题，限定写人数文字、好评率和全部评价入口）、`review_tag`（每个印象标签，原文为人数文字）、`review_preview`（每条预览正文，限定写长度和图片张数）；不导出昵称、头像和评价图片地址。覆盖范围列出同组规格是否当作独立商品、详情区是否加载、默认评价区是否读到等 |
| `jd_review_categories`（2026-10-15 起） | 京东“全部评价”面板里 1～3 个分类的已画出卡片，每个分类一个观察，带各自的确认时间。`review_category`（分类名、人数文字，限定写计划、排序、商品范围、切换后卡片是否变化、卡片数）、`review`（每张卡片一条，标签为月日，限定写规格、星级类名、图片视频个数）、`review_followup`；最后一个分类之后另有 `review_panel`（面板开关情况）和每个分类标签一条 `review_category_option`。不导出昵称、头像和评价图片视频地址。覆盖范围列出 `scope`（`rendered_cards_only`）、`scrolled`、`date_has_year`、`media_read`、`unique_review_count`。未完成的任务不导出卡片 |
| `jd_cart`（2026-10-15 起） | 京东购物车已加载的行，一个观察。每行一条 `cart_item`（位置、商品编号、标题、链接、数量）、`cart_shop`（店铺名，限定写 `zy_icon`）、`cart_specification`（规格标签和文字）、`cart_price`（价格原文，限定写 `kind=normal` 或 `kind=status_text`，有第二个金额时一并写上）、`cart_availability`（标签为 `cannot_buy`、`no_marker_seen` 或 `unrecognized`，原文为原因，`disabled` 为勾选框是否不可用）；另有一条 `cart_header_count`（页头数字原文，含义未核实）和 6 条 `cart_scan`（`rows_seen`、`rows_returned`、`rows_omitted`、`shops_seen`、`rows_outside_shops`、`quantity_sum`）。覆盖范围列出 `scope`（`loaded_rows_only`）、`scrolled`、`full_cart`、`header_count_meaning_verified` 和三类计数。不导出地址、昵称、内部编号和图片地址 |
| `jd_orders`（2026-10-16 起） | 京东订单列表已加载的订单卡片，一个观察。两条 `order_list_view`（标签 `time_range`、`status_filter`，原文为页面上的时间范围和选中的状态卡片）、6 条 `order_scan`（`groups_seen`、`orders_seen`、`orders_returned`、`orders_omitted`、`items_seen`、`items_returned`）；每个拆单横幅一条 `order_split_notice`（原文为说明文字，限定写各段信息原文和是否有“拆单详情”入口）；每单一条 `order`（所在组，限定写是否子订单、是否有“订单详情”入口和商品数）、`order_date`、`order_shop`、`order_status`、`order_price`（金额原文，限定写金额旁的说明，未核实是否实付），每件商品一条 `order_item`（位置、商品编号、标题、链接、数量）。覆盖范围列出 `status`、`scope`（`loaded_orders_only`）、`scrolled`、`full_order_history`、`time_range_verified`、`amount_meaning_verified`。不导出收货人、支付方式、按钮和图片地址 |
| `jd_order_detail`（2026-10-19 起） | 京东单个订单的详情页，一个观察。一条 `order`（限定写是否子订单、详情页上读到的订单号和版式 `layout`）、一条 `order_detail_opening`（原文为点击结果，限定写点击错误、看标签页次数、读取次数、详情页是否关闭）、3 条 `order_scan`（`progress_seen`、`items_seen`、`items_returned`）、一条 `order_status`、每个进度节点一条 `order_progress`（标签为节点名称，原文为时间，`done_marker` 为是否已到达）、一条 `order_shipping`（送货方式一行），每件商品一条 `order_item`（位置、商品编号、标题、链接、数量，限定写“列名=文字”），每行金额一条 `order_amount`（标签为金额名称，原文为金额，未核实是否实付）。覆盖范围列出 `status`、`scope`（`single_order_detail_page`）、`consignee_read`、`tracking_records_read`、`payment_tab_read`、`invoice_read`、`amount_meaning_verified`。不导出收货人、跟踪记录、付款信息和详情页地址 |
| `order_detail_check`（2026-10-14 起） | 订单入口检查。`order_entry`：订单编号、详情地址、结果（`page_unavailable` 或 `normal_content_unassessed`），限定里写点击回执、跳转与订单编号是否核对、页面状态；页面报错时另有 `order_error_page` 记录标题和副标题原文。关联来源写明来自哪个订单列表任务的第几单。这个任务不读订单内容，报告里也没有 |

其他任务类型明确返回 `UNSUPPORTED_REPORT_KIND`，例如旧的两页搜索 `search_pages`、整页评价 `product_reviews`、规格选择 `product_selection`，以及价格控件检查一类的实验任务。导出不会把多个历史独立阶段拼成统一订单工作流，也不会将一个任务的字段补到另一个任务。

未完成任务可以导出：已经保存的有效批次保留原采集时间；尚无观察的操作明确标为无缓存内容。2026-10-14 新增的 6 种任务只导出完成后的结果，未完成时标为无缓存内容。`complete` 表示原限定任务完成，报告仍保留 `partial`、`full_cart:false`、`full_order_history:false` 等覆盖限制。任务创建／更新时间与采集时间分别呈现。

格式3的[明确空列表结果](empty-list-results.md)导出 `empty_notice`记录及当前列表视图的范围说明，保存原提示、来源和采集时间，区别于没有缓存内容。当前仅离线合同与模拟适配器流程通过；生产DOM空状态识别尚未接入或实页验收，零行本身不能生成此记录。

## 数据解释

订单号和商品号保留为字符串，同商品的不同位置分别列出。价格和金额保留原标签、原文及未验证标记，不推导单价、支付总额或结算事实。没有观察到的字段保持缺失。

Markdown 对不可信文字转义；CSV 使用 UTF-8 BOM 和标准字段引用，所有字符串均做公式防护，编号使用文本前缀保护长数字精度。因此 CSV 中某些值带有前导单引号，它是表格导入保护，不修改源缓存。图片链接仅作为已有数据交付，不访问图片服务器。

报告按上述字段生成阅读用投影，不替代原始 JSON 检查点。图片扫描计数、技术 DOM 节点和读取预算明细等未全部复制；需要完整字段时继续使用原缓存。CSV 的 `source_task`／`observed_at` 指当前任务与当前观察，入口和列表的关联来源保存在 `provenance_*` 列中。

`loadTask` 的原检查点校验和正文→入口→列表来源校验仍生效。无效／缺失检查点不会生成报告。报告为本地私有购物数据，导出本身不发布或发送文件。

## 预期错误

| 错误 | 处理 |
| --- | --- |
| `INVALID_REPORT_FORMAT` | 明确指定 `markdown` 或 `csv` |
| `INVALID_REPORT_OUTPUT` | 提供有效文件名和已存在父目录 |
| `REPORT_OUTPUT_PROTECTED` | 在原状态目录之外选择输出位置 |
| `REPORT_OUTPUT_EXISTS` | 保留现有文件，换一个未使用文件名 |
| `REPORT_WRITE_FAILED` | 检查本地目录；先保留已有产物再处理 |
| `TASK_MISSING`、`INVALID_CHECKPOINT` | 核对原任务和状态目录；不通过重跑浏览器补报告 |
