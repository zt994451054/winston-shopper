# 京东

京东按板块逐个实现，每个板块先离线测试，再实页验收。页面打开、关闭和节奏见 [节奏](pacing.md#京东2026-10-15-起)。研究记录在仓库的 `output/consumer-shopping-research/`：结构探查 `jd-probe-2026-10-15.md`，搜索首屏实页 `jd-search-live-2026-10-15.md`，商品详情实页 `jd-product-live-2026-10-15.md`，默认评价区 `jd-review-summary-live-2026-10-15.md`，分类评价实页 `jd-review-categories-live-2026-10-15.md`，购物车实页 `jd-cart-live-2026-10-16.md`，订单列表 `jd-orders-live-2026-10-16.md`，订单详情页探查 `jd-order-detail-probe-2026-10-19.md`，订单详情实页 `jd-order-detail-live-2026-10-21.md`，搜索翻页探查 `jd-search-pages-probe-2026-10-21.md`，搜索翻页实页 `jd-search-pages-live-2026-10-21.md`，排序与价格区间探查 `jd-sort-probe-2026-10-21.md`，搜索排序实页 `jd-sort-live-2026-10-22.md`，价格区间探查 `jd-price-range-probe-2026-10-22.md`，价格区间实页 `jd-price-range-live-2026-10-22.md`。

| 板块 | 状态 |
| --- | --- |
| 打开、关闭页面，列出标签页，绑定商品页 | 可用（2026-10-15） |
| 搜索首屏 | 可用，2026-10-15 实页两次通过，见下文 |
| 商品详情（右侧面板、同组规格、商品详情区） | 可用，2026-10-15 实页 3 件商品通过（自营、第三方、服饰），见下文 |
| 分类评价（“全部评价”面板里 1～3 个分类的首屏卡片） | 可用，2026-10-15 实页 3 件商品通过（自营鼠标、连衣裙、第三方鼠标只读当前分类），见下文 |
| 购物车（已加载的行） | 可用，2026-10-16 实页通过（4 个店铺 11 行，与独立探查一致），见下文 |
| 订单列表（已加载的订单卡片） | 可用，2026-10-16 实页通过（4 单，含 1 个拆单的 2 个子订单，与独立探查一致），见下文 |
| 单个订单详情（从订单列表点“订单详情”打开） | 可用，2026-10-21 实页通过（两种版式各一单）；需要用户在所用 Chrome 资料里允许 order.jd.com 弹出窗口，见下文 |
| 搜索翻页（第 1～N 页的首屏，N 为 2～5） | 可用，2026-10-21 实页通过（3 页各 30 张，每次翻页第一次看就确认），见下文 |
| 搜索排序（销量、价格降序、价格升序，可再读 1～5 页） | 可用，2026-10-22 实页通过（三种排序各一次，价格升序读 3 页），见下文 |
| 搜索价格区间（可再排序、读 1～5 页） | 可用，2026-10-22 实页通过（只设区间一次，区间＋价格升序＋3 页一次），见下文“搜索排序与价格区间” |

## 搜索首屏

```sh
node scripts/shopping.mjs page-open --platform jd --search '罗技 M330'
node scripts/shopping.mjs task-start --platform jd --task jd-mouse --search '罗技 M330' --tab <page-open 返回的 tab_id>
node scripts/shopping.mjs task-run --task jd-mouse
node scripts/shopping.mjs task-status --task jd-mouse
node scripts/shopping.mjs report-export --task jd-mouse --format markdown --output <新文件路径>
```

- **只读当前已加载的卡片**：不点击、不滚动、不翻页。首次加载一般是 30 张；最多读 60 张。用户决定第一版只读首屏（2026-10-15）。
- **任务类型** `jd_search`，必须同时给 `--search` 和 `--tab`。加 `--pages N` 或 `--sort` 是另外的任务，见下文“搜索翻页”“搜索排序”。价格、筛选和所有商品类选项都拒绝。
- **核对页面**：只接受 `search.jd.com/Search` 且关键词与任务完全一致的页面；地址变了返回 `TARGET_CHANGED`。
- **结果字段**（`operations[0].result`）：
  - `items[]`：平台原顺序的位置、商品编号、商品页链接、标题、店铺、销量区原文（可能还有好评率、看过人数等）和显示价；
  - 京东的卡片没有商品页链接，链接按编号拼成 `https://item.jd.com/<编号>.html`；
  - 价格分成原文 `raw`、大字金额 `amount_text` 和旁边的说明 `label`（如“补贴到手价”“到手价”，说的是大字金额）。显示价不等于结算价，`eligibility_verified` 和 `sku_price_binding_verified` 都是 `false`；
  - `jd`：`self_operated`（标题前有“自营”小图）、`sponsored`（卡片标着“广告”）和 `tags`（如“包邮”），都是页面原样标记；
  - `jd.other_amounts`：价格旁边的另一个金额（灰色小字，如 ¥80.1 旁边的 ¥89），附 `line_through`（是否带删除线）。2026-10-15 实测，它减去卡片上的优惠正好等于大字金额，像优惠前的价格；但页面没有给它标名称，也没有删除线，不要当作原价使用；
  - `cards_seen`、`cards_scanned`、`duplicates_omitted`、`unsupported_cards_omitted`：看到、检查、略去的重复和没有编号的卡片数；
  - `coverage.in_stock_only`：页面上“仅显示有货”是否勾选（`null` 表示没找到这个选项）。它会缩小结果范围，所以随结果保存；
  - `missing` 固定写明：首屏以下的卡片、后续页、排序与筛选核对、可付价格都没有读。
- **一个京东商品编号就是一件商品**。京东的每个规格都是独立商品，可能是完全不同的产品；不要把搜索卡片的价格套到同组的其他规格上。
- **遇到登录、限流或验证就停**：返回 `LOGIN_REQUIRED`、`RATE_LIMITED` 或 `VERIFICATION_REQUIRED`，任务暂停，限流和验证还会记入 `throttle-observations.json`。告诉用户是哪个页面，等用户处理后再继续。
- **任务互不阻塞**：未完成的京东任务只挡新的京东任务，不挡淘宝任务，反过来也一样。
- **结果格式**：2026-10-15 第一次实页验收之后新建的任务是格式 2（`schema_version: 2`），有 `other_amounts`，`label` 里只有说明文字。之前的第一次实页任务是格式 1：没有 `schema_version` 和 `other_amounts`，第二个金额混在 `label` 里（如“补贴到手价 ¥89”），原样回读。
- **导出**：`report-export` 支持 `jd_search`，记录与淘宝首屏搜索相同（`search_item`、`search_shop`、`search_sales`、`search_scan`），另有每张卡片一条 `search_marks`，写自营、广告和标签；格式 2 另有每个旁边金额一条 `search_other_amount`，标签写是否带删除线。覆盖范围列出 `scope` 和 `in_stock_only`。
- **暂不支持**：`task-diagnose`、`task-rebind`、布局辅助和图片导出用于京东任务时返回 `UNSUPPORTED_PLATFORM`。页面丢失时重新打开页面，新建任务。

## 搜索翻页

```sh
node scripts/shopping.mjs page-open --platform jd --search '罗技 M330'
node scripts/shopping.mjs task-start --platform jd --task jd-mouse-pages --search '罗技 M330' --tab <page-open 返回的 tab_id> --pages 3
node scripts/shopping.mjs task-run --task jd-mouse-pages
node scripts/shopping.mjs report-export --task jd-mouse-pages --format markdown --output <新文件路径>
```

- **做法**（用户 2026-10-21 同意）：标签页必须停在第 1 页。先读第 1 页首屏，然后每多读一页，就在翻页栏的“下一页”上点一次，等页面换好再读这一页的首屏。每页都只读已加载的卡片，不滚动，一般是 30 张。任务类型 `jd_search_pages`，`--pages` 取 2～5，只能和 `--search`、`--tab` 一起用。
- **京东翻页不改地址**（2026-10-21 探查）：点“下一页”后，本标签页地址仍然只有关键词，没有页码；不开新标签页，页面停在顶部，首屏卡片全部换掉。所以不能按地址打开第 N 页，任务也只能靠翻页栏认出当前是第几页。
- **每次翻页的核对**：
  - 点之前，页面脚本先核对翻页栏的当前页号就是上一页，“下一页”只有一个且可用；不对就不点；
  - 点完等 5 秒再看：翻页栏的当前页号变成下一页、卡片编号也和上一页不同，才算翻过去；
  - 还没变就隔 3 秒再看，一次翻页最多看 3 次；看完还没变，返回 `SEARCH_PAGE_NOT_CHANGED` 并停下；翻页栏显示的是别的页号，返回 `SEARCH_PAGE_MISMATCH` 并停下。**两种情况都不会再点**，要重新打开搜索页、新建任务。
- **“下一页”只点一次**：点之前先在任务记录里记下这次点击；点击回执丢失或进程中断时，按“可能已经点过”处理，只看不再点。
- **提前结束**：“下一页”不可用（带禁用样式）说明已经是最后一页，任务按已读的页正常完成，`end_reason` 为 `last_page`。
- **开始时不在第 1 页**：返回 `SEARCH_NOT_FIRST_PAGE` 并停下，不点任何东西。
- **结果字段**（`operations[0].result`）：
  - `requested_pages`、`pages_read`、`end_reason`（`requested_pages_read` 或 `last_page`）；
  - `total_pages_text`（第 1 页翻页栏的原文，如“共17页”）和 `total_pages`；
  - `pages[]`：每页的 `pager`（当前页号、总页数原文、“上一页”“下一页”是否可用）、`transition`（从哪一页点过来、点击回执、看了几次；第 1 页为 `null`）和 `search`（这一页首屏的读取，字段同“搜索首屏”）；
  - **跨页去重**：同一个商品编号只在第一次出现的那一页列出，后面的页略去并记在 `cross_page_duplicates_omitted`；`distinct_products` 是各页列出的商品总数；
  - `coverage`：`scope` 为 `first_screen_loaded_cards_per_page`，`url_reflects_page: false`，`page_transition_verified: true`，`all_listed_pages_read` 只有读到最后一页时为 `true`；
  - `missing`：各页首屏以下的卡片、排序与筛选核对、可付价格都没有读；没读到最后一页时还有 `subsequent_pages`。
- **节奏**：每点一次“下一页”按一次搜索加载计入节奏，读取按读取计。搜索加载每 10 分钟最多 5 次、每小时最多 15 次，所以 `page-open` 加 5 页任务里的 4 次翻页正好用完 10 分钟的额度。会打开或翻动搜索页的任务之间至少隔 10 分钟。
- **停下的任务不导出已读的页**：`report-export` 只导出完成的结果；中途停下的任务，已读的页只留在任务记录里。
- **导出**：`report-export` 支持 `jd_search_pages`，每页一个观察，`batch_position` 是页号。每页先有一条 `search_pagination`（翻页栏和怎么点过来的）和一条 `search_scan`（`cross_page_duplicates_omitted`），然后是与“搜索首屏”相同的卡片记录。整个任务的 `pages_read`、`distinct_products`、`cross_page_duplicates_omitted`、`end_reason`、`total_pages_text` 写在每页的汇总覆盖范围里。

## 搜索排序与价格区间

```sh
node scripts/shopping.mjs page-open --platform jd --search '罗技 M330'
node scripts/shopping.mjs task-start --platform jd --task jd-mouse-cheap --search '罗技 M330' --tab <page-open 返回的 tab_id> --sort price-asc --pages 3
node scripts/shopping.mjs task-run --task jd-mouse-cheap
node scripts/shopping.mjs report-export --task jd-mouse-cheap --format markdown --output <新文件路径>
```

- **做法**（用户 2026-10-21 同意）：标签页必须是刚打开的第 1 页、“综合”选中。任务类型 `jd_search_sort`，`--sort` 取：
  - `sales`：点“销量”一次；
  - `price-desc`：点“价格”一次（京东第一次点是从高到低）；
  - `price-asc`：点“价格”两次。第一次点完要先确认卡片已经从高到低，才点第二次。

  `--pages` 可选，取 1～5，默认 1；大于 1 时排好序后照“搜索翻页”的做法每页点一次“下一页”。只能和 `--search`、`--tab` 一起用。
- **京东排序不改地址**（2026-10-21 探查）：点“销量”“价格”都在原页面重排，地址仍然只有关键词，首屏卡片全部换掉。任务只能靠排序区认出当前排序：被选中的标签带选中样式，“价格”的小图标在未选中、从高到低、从低到高时各不相同。图标文件名只记下来对比，不靠名字判断方向（网站更新后会变）。
- **每次点击的核对**：
  - 点之前，页面脚本核对排序区的选中项和“价格”图标与任务上一次读到的一致，不一致返回 `SEARCH_SORT_STATE_CHANGED`、不点；
  - 点完等 5 秒再看：被点的标签选中、卡片编号和点之前不同（第二次点“价格”还要求图标变了），才算排好；还没变就隔 3 秒再看，最多看 3 次，仍没变返回 `SEARCH_SORT_NOT_CHANGED` 并停下；显示的是别的排序返回 `SEARCH_SORT_MISMATCH`。**都不会再点**，要重新打开搜索页、新建任务；
  - 每个点击先在任务记录里记下；回执丢失或进程中断时按“可能已经点过”处理，只看不再点。
- **价格方向的核对**：京东按卡片价格旁的灰色金额排序（没有删除线的那个），没有灰色金额时看大字价；大字的到手价不保证有序。任务把首屏卡片按顺序两两比较（跳过广告和读不出金额的卡片），记下顺、逆、相等的对数：
  - 全部逆序（`opposite`）返回 `SEARCH_SORT_DIRECTION_MISMATCH` 并停下；
  - `price-asc` 在第二次点之前，要求第一次的结果确实从高到低（全部有序，或顺序对数至少是逆序的 4 倍），否则返回 `SEARCH_SORT_DIRECTION_UNVERIFIED` 并停下，不点第二次；
  - 少数几处逆序只记录，不停。
- **开始时不对**：不在第 1 页返回 `SEARCH_NOT_FIRST_PAGE`，“综合”没选中返回 `SEARCH_SORT_NOT_DEFAULT`，都不点任何东西。
- **翻页时**：每页都核对排序标签仍然选中，没选中返回 `SEARCH_SORT_LOST` 并停下；每页的价格顺序都记下来。
- **结果字段**（`operations[0].result`）：
  - `requested_sort`；`sort`：`basis`（价格排序为 `gray_amount_or_displayed_price`，销量为 `null`）、开始时的读取时间、`steps[]`（每次点击的标签、回执、看了几次、点完的选中项、“价格”图标点前点后、价格顺序核对）；
  - `requested_pages`、`pages_read`、`end_reason`、`total_pages_text`、`total_pages`、`distinct_products`、`cross_page_duplicates_omitted`，以及 `pages[]`：每页除了“搜索翻页”的字段，还有 `sort_bar`（各控件是否选中和图标文件名）、`active_sort` 和 `direction_check`；
  - `coverage`：`url_reflects_sort: false`、`sort_verified: true`、`sort_direction_verified`（价格排序为 `true`，销量为 `null`），其余同“搜索翻页”；
  - `missing`：同“搜索翻页”；销量排序另有 `sales_ranking_basis`（页面没说按什么销量排）。
- **节奏**：每次排序点击和每次翻页都按一次搜索加载计入。`page-open` 加 `price-asc` 加 3 页共 5 次，正好用完 10 分钟的额度；超过时任务暂停，过后再 `task-run`。会打开、翻动或重排搜索页的任务之间至少隔 10 分钟。
- **价格区间**（用户 2026-10-22 同意）：加 `--min-price A --max-price B`（两个都要给，整数元，1～999999，A 小于 B），可以不带 `--sort`。区间在排序之前设好：
  - 标签页要是刚打开的第 1 页，“综合”选中，“价格区间”未选中，否则返回 `SEARCH_SORT_NOT_DEFAULT`；
  - 对“价格区间”发送脚本生成的鼠标移入事件打开下拉（脚本点击打不开），等 4 秒，读下拉：要正好打开一个，两个输入框（提示文字“最低价”“最高价”）。没打开返回 `SEARCH_PRICE_RANGE_UNAVAILABLE`；
  - 两个输入框为空时，用浏览器扩展的“填写”命令依次填入两个价格（与淘宝价格任务相同），再读一次核对；已经是这两个值就不重填；有别的内容返回 `SEARCH_PRICE_RANGE_NOT_EMPTY`，填完不对返回 `SEARCH_PRICE_RANGE_NOT_FILLED`，都不点“确定”；
  - 在下拉的“确定”上点一次（先记在任务记录里，回执不明按“可能已经点过”处理），等 5 秒看：“价格区间”按钮选中、按钮文字里正好是这两个价格（实页为“价格区间 (¥60 - ¥90)”，只取其中两个数字核对）、卡片换了、仍是第 1 页“综合”，并且**每张卡片的排序价（灰色金额，没有时取大字价）都在区间内**。按钮写的是别的区间返回 `SEARCH_PRICE_RANGE_MISMATCH`，有卡片在区间外返回 `SEARCH_PRICE_RANGE_NOT_APPLIED`，看 3 次还没变返回 `SEARCH_PRICE_RANGE_NOT_CHANGED`，都停下、不再点；
  - 之后的排序点击和每一页都核对按钮仍然写着这个区间（没有返回 `SEARCH_PRICE_RANGE_LOST`），每一页的卡片也都要在区间内。
  - 结果多一个 `price_range`（价格、点击回执、看了几次、按钮文字、首屏核对：比较了几张、区间外几张、跳过的广告和读不出的卡片），每页多一个 `price_range_check`，`coverage.price_range_verified: true`；只设区间不排序时 `requested_sort` 为 `null`，`sort_verified` 为 `null`。带区间的任务记录和结果是第 2 版，不带区间的仍是第 1 版。
  - “确定”按一次搜索加载计。打开页面、确定、价格升序两次点击、再翻 2 页共 6 次，超过 10 分钟 5 次的额度，任务会在最后一次翻页前暂停，过后再 `task-run`。
- **导出**：`report-export` 支持 `jd_search_sort`，每页一个观察。带价格区间时，第 1 页最前面有一条 `search_price_range`（标签为“最低-最高”，原文为按钮文字，限定写点击回执、看了几次、错误码和首屏核对），每页另有一条 `search_price_range_check`。第 1 页先有每次点击一条 `search_sort_click`（标签为“销量”或“价格”，原文写点完的选中项，限定写回执、看了几次、错误码、图标点前点后和价格顺序核对）；每页有一条 `search_sort_state`（标签为选中项，原文写各控件是否选中和“价格”图标，限定写这一页的价格顺序核对），然后是与“搜索翻页”相同的记录。中途停下的任务不导出已读的页。

## 商品详情

```sh
node scripts/shopping.mjs page-open --platform jd --url 'https://item.jd.com/<商品编号>.html'
node scripts/shopping.mjs bind --platform jd --tab <page-open 返回的 tab_id> --binding jd-mouse
node scripts/shopping.mjs task-start --platform jd --task jd-mouse-detail --bindings jd-mouse --details
node scripts/shopping.mjs task-run --task jd-mouse-detail
```

- **一个任务读一件商品**：`--bindings` 只接受一个用 `bind --platform jd` 做的绑定，必须同时给 `--details`。任务类型 `jd_product`。
- **最多滚动一次**（用户 2026-10-15 同意）：
  - 先读一次页面；
  - 如果“商品详情”区还是加载中的占位，就把它的标题滚到页面顶部，只滚这一次；
  - 之后等 5 秒再读，没加载出来就隔 3 秒再读，最多读 3 次。
  - 滚动前先记入任务。程序中断后接着跑，不会再滚第二次；
  - 滚动被页面检查拦下、确定没有发出去时，才算没用掉这次滚动。
  - 一直没加载出来时，结果照常保存，`detail.status` 为 `not_loaded`，`missing` 里有 `detail_section`。
  - 不点击任何东西。
- **结果字段**（`operations[0].result`）：
  - `title`、`title_icons`（标题前小图的说明文字，实测只是数字编号）、`self_operated`（店铺栏里有“自营”标记）、`shop`、`comment_count_text`（累计评价数原文）；
  - `price`：大字价格 `amount_text`、价格旁的活动标签 `tags`（如“补贴价”），以及灰色金额 `other_amounts`（附是否有删除线）。显示价不等于结算价；
  - `series`：页面上的“系列”选项和选中的那个；
  - `same_group_specs`：页面列出的规格组和选项，包括选项名、提示文字、是否选中、是否缺货（附“无货”等原文）和规格小图。**京东的每个规格都是独立商品，可能是完全不同的产品**，所以这里只列选项，不带价格和库存；要了解某个规格，打开它自己的页面再读；
  - `services`：服务标签，每个有页面上的短名称 `label`（如“7天价保”）和鼠标悬停时的说明 `description`；`gallery`：左侧缩略图；
  - `review_summary`：页面打开时左侧就有的默认评价区，不用点击、不用滚动。`status` 为 `loaded` 或 `missing`（页面上没有这块时，任务仍完成）。读到时有：
    - `title`：标题原文（如“买家评价(200万+)”）。`count_text` 是标题里最后一对括号中的文字（半角或全角），取不到则为 null，不转换成数字；
    - `praise`：好评率原文，没有则为空字符串；
    - `tags`：买家印象标签。`text` 是标签文字，`count_text` 是人数原文。`tags_seen` 是页面上的实际个数，最多返回 20 个；
    - `previews`：评价预览。`body` 是正文（合并空白，最多 1000 字），`body_length` 是合并空白后的完整长度，`image_count` 是图片张数。`previews_seen` 是实际条数，最多返回 10 条；
    - `all_reviews_entry`：是否有可见的、文字为“全部评价”的入口；
    - `excluded`：固定为 `nicknames`、`avatars`、`review_images`，表示没有读买家昵称、头像和评价图片地址。
    `status` 为 `missing` 时只有 `status`。不点击“全部评价”，不读好评、中评、差评、追评、晒图这些分类。
  - `detail`：商品详情区，包括：
    - 状态 `status`：`loaded`、`not_loaded`、`empty` 或 `section_missing`；
    - `highlights`（亮点参数）和 `parameters`（参数表），都是名称和值的原文。参数表里名称和值都为空的行不返回，个数记在 `empty_parameter_rows_omitted`；
    - `view`：最后一次读取时页面是否可见、窗口是否有焦点、滚动位置和“商品详情”标题离窗口顶部的距离。详情区靠页面渲染时加载，窗口被挡住或最小化时可能一直不加载，这几项用来判断原因；
    - `images`：详情区的图片，每张注明区域和形式。区域分 `related_head`（店铺活动）、`detail_top`、`detail_main`（正文）、`related_footer`（店铺提示）；形式分普通图片 `img` 和背景图 `css_background`。背景图无法判断是否已加载，`loaded` 为 `null`。只保留京东图片域名（`360buyimg.com`）的 https 链接，其他链接只计数；
  - `detail_action`：第一次读到的详情区状态、是否用了滚动、滚动前后的位置、滚动出错时的错误码、读了几次；
  - `coverage` 和 `missing` 写明：同组规格的价格、分类评价（`reviews_read` 仍为 false，`missing` 里仍有 `reviews`）、可付价格都没有读。默认评价区读到时 `review_summary_read` 为 true；没读到时 `missing` 里另有 `review_summary`。
- **结果格式**：第一次实页验收（2026-10-15 11:15～11:24 的 3 个任务）是格式 1，原样回读：
  - 自营按标题小图的说明文字判断，因为说明只是数字，所以都判为 `false`；
  - 亮点参数的名称和值是反的；
  - 参数表保留空行，没有 `view`。

  第二次实页验收（11:35～11:44 的 3 个任务）是格式 2（`schema_version: 2`），修正了以上几点，但服务标签只存了一段文字（有说明时是说明，否则是名称）。第三次实页是格式 3，服务标签同时保留名称和说明。格式 4（2026-10-15）在格式 3 上增加默认评价区 `review_summary`。现在新建的任务是格式 4。格式 1～3 原样回读。
- **页面检查**：只接受与绑定编号相同的 `item.jd.com/<编号>.html`。遇到登录、限流或验证就停，限流和验证记入 `throttle-observations.json`。右侧出现两个商品面板、或找不到标题时报 `PAGE_STRUCTURE_CHANGED`。
- **导出**：每件商品写一条 `product`，另有以下记录：
  - `product_marks`（自营、标题小图、评价数）、`product_price`、`price_other_amount`、`product_shop`、`product_series`；
  - `same_group_spec`：每个同组规格选项一条，缺货写在 `disabled`，原文写在 `qualifier`；
  - `service_label`：格式 3 的标签写名称、原文写说明；`parameter`（亮点参数的 `qualifier` 为 `highlight`）；
  - `image_link`：缩略图的标签为 `gallery`，详情图的标签为区域名，`qualifier` 写形式；
  - `detail_section`：详情区状态和滚动情况；
  - `review_summary`：默认评价区。标签为 `loaded` 或 `missing`，原文为标题，限定写人数文字、好评率和是否有“全部评价”入口；
  - `review_tag`：每个印象标签一条，原文为人数文字；
  - `review_preview`：每条预览一条，原文为正文，限定写正文长度和图片张数。不导出昵称、头像和评价图片地址。

## 分类评价

```sh
node scripts/shopping.mjs page-open --platform jd --url 'https://item.jd.com/<商品编号>.html'
node scripts/shopping.mjs bind --platform jd --tab <page-open 返回的 tab_id> --binding jd-mouse
node scripts/shopping.mjs task-start --platform jd --task jd-mouse-reviews --bindings jd-mouse --review-categories examples/review-categories-current.json
node scripts/shopping.mjs task-run --task jd-mouse-reviews
```

- **一个任务读一件商品的 1～3 个分类**：`--bindings` 只接受一个京东绑定，`--review-categories` 是 JSON 文件，写 1～3 个不重复的分类名（如 `["全部","好评"]`），或 `[null]` 只读当前选中的分类。文件规则与淘宝相同。面板上固定有“全部”“好评”“中评”“差评”，常见还有“图/视频”“追评”“回头客”和若干印象标签（2026-11-14 实页）；想看差评直接写 `["差评","中评"]`，不必先用 `[null]` 跑一次看分类名，每多跑一次就多开一次面板。任务类型 `jd_review_categories`。不能和 `--details`、`--search` 同用。
- **只读已经画出来的卡片**（用户 2026-10-15 选定方案 A）：“全部评价”面板的列表只画出窗口里的 3～4 张卡片，往下滚才画后面的。本任务不滚动，所以每个分类只有这几张，不是该分类的全部评价，也不能用来统计。
- **页面必须在前台**：窗口被挡住、最小化或切到别的标签页时，列表一张卡片也不画。打开和切换前发现页面不可见，程序先请浏览器把这个标签页切到最前面一次（卡住时可以跳前台，尽量不请用户协助；页面已可见时不提窗），再看一次。仍不可见时任务停在 `waiting_user`，错误码 `PAGE_NOT_VISIBLE`，不点击。这时请用户把京东商品页所在的 Chrome 窗口放到最前面、不被其他窗口盖住，然后运行 `task-resume --after-user`，接着原记录继续，已经点过的不再点。
- **流程**：
  1. 先读一次页面。面板已经开着就不点“全部评价”，最后也不关；
  2. 面板没开时，先记下打开意图，再点“全部评价”文字一次；等 4 秒后读，最多读 3 次确认面板出现；
  3. 每个分类：已经选中就不点；没选中时先记下意图，再点这个分类的名称一次，等 4 秒后读。连续两次读到它是唯一选中的分类、排序文字没变、卡片相同，才算确认；每个分类最多读 4 次；
  4. 全部确认后，只在面板是本任务打开的时候点关闭按钮一次，再读到两次面板不在页面上才算关好。关闭不要求页面可见。最多读 3 次，确认不了时任务照常完成，`close_status` 为 `unconfirmed`；
  5. 整个任务最多读 20 次。点击：打开最多 1 次，每个分类最多 1 次，关闭最多 1 次。点击回执不明时不再点，只观察。
- **失败时面板留着**：分类名在面板上不存在（`REVIEW_CATEGORY_UNAVAILABLE`）、确认不了（`REVIEW_CATEGORY_OUTCOME_UNKNOWN`）或读取次数用完时，任务停下，已打开的面板不关。之前已确认的分类在 `task-status` 的 `partial_review_samples` 里。
- **结果字段**（`operations[0].result`）：
  - `panel`：一开始面板是否开着 `initial_state`、是否本任务打开 `opened_by_task`、打开点击的回执 `open_acknowledgement`（`clicked`、`uncertain` 或 null）、关闭结果 `close_status`（`closed_confirmed`、`unconfirmed` 或 `not_opened_by_task`），以及面板上方的排序文字（如“最新”）和商品范围文字（如“当前商品”），这两个控件不点；
  - `categories_seen`：最后一次读到的分类标签，每个有名称、人数原文和是否选中；
  - `samples[]`：每个分类一条。`requested` 是计划里写的（`null` 表示当前分类），`category` 是实际读到的分类名，`count_text` 是人数原文，`list_changed` 表示切换后卡片和切换前是否不同（没切换时为 null），`cards_rendered` 是返回的卡片数，`cards_seen` 是页面上画出的卡片数，`observed_at` 是确认时间；
  - `cards[]`：星级类名 `rating_mark`（页面原样；2026-10-15 实页每张都是 `star-good-1`，含义未核实，不要当作星数）、日期 `date_text`（原文；实页今年的只有月和日，如 `05-02`，往年的带年份，如 `2025-11-15`）、规格 `spec_text`、正文 `body`（最多 2000 字）和完整长度 `body_length`、`media.count`（图片和视频个数）和 `media.videos`（其中视频个数），追评 `followup`（间隔文字如“购后2天追评”、正文和长度），没有追评时为 null；
  - `coverage` 固定写明：只读已画出的卡片、没有滚动、日期不保证有年份（`date_has_year: false`）、没读图片和视频、不知道不重复的评价总数；
  - `excluded` 固定写明没有读买家昵称、头像、会员标记、评价图片和视频地址、点赞等按钮；
  - `actions`：用掉的打开、切换、关闭和读取次数。
- **结果核对**：结果按任务里保存的读取记录重新生成，保存的结果被改动后回读会报 `INVALID_CHECKPOINT`。
- **导出**：每个分类一组记录，各自带确认时间：
  - `review_category`：标签和分组名为分类名，原文为人数文字，限定写计划、排序、商品范围、`list_changed`、卡片数；
  - `review`：每张卡片一条，标签为日期，原文为正文，限定写规格、星级类名、图片视频个数和视频个数；正文被截断时 `truncated` 为 true；
  - `review_followup`：每条追评一条，标签为间隔文字；
  - 最后一个分类之后另有 `review_panel`（面板一开始的状态、是否本任务打开、关闭结果）和每个分类标签一条 `review_category_option`（限定写 `last_open_panel_read`，表示来自最后一次面板开着时的读取）。
  - 任务没完成时不导出卡片。覆盖范围列出 `scope`、`scrolled`、`date_has_year`、`media_read`、`unique_review_count`。
- **不做**：不滚动评价列表，不点“最新”和“当前商品”，不点评价图片或视频，不读第二页以后的内容。

## 购物车

```sh
node scripts/shopping.mjs page-open --platform jd --cart
node scripts/shopping.mjs task-start --platform jd --task jd-cart --cart --tab <page-open 返回的 tab_id>
node scripts/shopping.mjs task-run --task jd-cart
node scripts/shopping.mjs report-export --task jd-cart --format markdown --output <新文件路径>
```

- **只读已经加载的行**（用户 2026-10-15 同意）：不滚动、不点击，勾选框、数量、删除、移入收藏、找相似、结算都不碰。任务类型 `jd_cart`，`--cart` 只能和 `--tab` 一起用。
- **购物车不读全**：
  - 2026-10-16 滚动探查确认是滚动加载：打开时 11 行，每往下滚一次多 10 行（11→21→31），列表下面直接是推荐区，没有“加载中”或“没有更多”的标记；页头写“购物车(55)”，含义没有核实；
  - 用户 2026-10-16 决定购物车和订单都不必读完，任务只读打开时已加载的行，不滚动；
  - 结果原样给出页头数字 `header_count_text`、行数 `rows_seen` 和数量合计 `quantity_sum`，不比较、不下结论；
  - `coverage.full_cart` 固定为 false。
- **能否购买**（`rows[].availability`），只认页面明确信号，不推断能否下单：
  - `cannot_buy`：勾选框不可用，并且至少还有一个信号——图上的遮罩文字（如“无货”）、标题是不可购买样式、价格位置是说明文字（如“商品补货中”）。`reasons` 依次是遮罩文字和价格位置说明的原文；
  - `no_marker_seen`：勾选框可用、没有遮罩、标题正常、有正常价格和数量框、取到了商品编号；
  - `unrecognized`：其他情况，`reasons` 是英文代码，说明哪里对不上（如 `checkbox_disabled_without_other_signal`、`no_price`、`missing_product_id`）；
  - 京东每个规格都是独立商品，所以没有淘宝的“所选款式缺货”这一类；
  - 服务小标签、提醒文字、“找相似”、是否勾选、第二个金额都不参与判断；
  - `availability_summary` 是三类各自的行数。
- **结果字段**（`operations[0].result`）：
  - `shops`：店铺位置、店铺名、`zy_icon`（自营店铺的小图标，含义未核实）和这一组的行数；
  - `rows`：每行的位置、所在店铺、商品编号和链接、标题、规格（标签和文字）、价格原文和类型（`normal` 或 `status_text`）、旁边的第二个金额原文、数量、勾选框是否不可用和是否已勾选、遮罩文字、标题是否不可购买样式、是否有“找相似”、服务小标签、提醒文字、能否购买；
  - 最多返回 100 行，多出的只计数（`rows_omitted`）；
  - 列表里不在任何店铺分组中的行只计数，记在 `rows_outside_shops`，大于 0 时 `missing` 里有 `rows_outside_shops`；
  - `missing` 固定写明没读未加载的行、结算合计和可付价格；`excluded` 写明没读收货地址、账户、内部编号、图片、推荐区和结算栏。
- **页面检查**：只接受 `cart.jd.com` 的购物车页。遇到登录、限流或验证就停，限流和验证记入 `throttle-observations.json`（页面类型 `cart`）。找不到列表或列表里没有商品行时报 `PAGE_STRUCTURE_CHANGED`：空购物车的样子还没见过，这一版不认。
- **导出**：每行一条 `cart_item`、`cart_shop`、`cart_specification`、`cart_price`、`cart_availability`，另有一条 `cart_header_count` 和 6 条 `cart_scan`（行数、返回行数、略去行数、店铺数、分组外行数、数量合计）。覆盖范围列出 `scope`、`scrolled`、`full_cart`、`header_count_meaning_verified` 和三类计数。不导出地址、昵称、内部编号和图片地址。

## 订单列表

```sh
node scripts/shopping.mjs page-open --platform jd --orders
node scripts/shopping.mjs task-start --platform jd --task jd-orders --orders --tab <page-open 返回的 tab_id>
node scripts/shopping.mjs task-run --task jd-orders
node scripts/shopping.mjs report-export --task jd-orders --format markdown --output <新文件路径>
```

- **只读已经加载的订单卡片**（用户 2026-10-16 同意）：不滚动、不翻页、不点击，“订单详情”“拆单详情”“申请售后”和各种按钮都不碰。任务类型 `jd_orders`，`--orders` 只能和 `--tab` 一起用；淘宝的 `--pages`、`--order-rows` 等选项仍返回 `UNSUPPORTED_PLATFORM`。
- **不是全部订单**：
  - 页面默认只显示一个时间范围，2026-10-16 是“近3个月订单”。结果原样记在 `time_range_text`，选中的状态卡片（如“全部”）记在 `status_filter_text`；
  - 2026-10-16 探查时列表有 4 组，后面没有翻页栏，也没有“没有更多”之类的标记，是否还会随滚动加载没有核实；
  - `coverage.full_order_history` 固定为 false，`missing` 写明没读未加载的订单、时间范围以外的订单和订单详情。
- **拆单**：一单拆成几个子订单时，组里先有一个拆单横幅，下面是子订单卡片，后面的组可能还有同一单的子订单。子订单卡片 `split_order` 为 true；横幅单独列在 `split_notices`（所在组、说明文字、几段信息原文、是否有“拆单详情”入口）。子订单属于哪个横幅不推断，按组的位置看。横幅里某段信息含收货人一类的元素时，这一段记 null。
- **结果字段**（`operations[0].result`）：
  - `orders`：每单的位置、所在组、是否子订单、订单号（只认 6～30 位数字）、下单时间原文、店铺名、状态原文、金额原文（如 `¥127.21`，是否实付没有核实）、金额旁的说明（如“获得了7京豆”）、是否有“订单详情”入口、商品（位置、商品编号和链接、标题、数量）；
  - 最多返回 50 单、每单 10 件商品，多出的只计数；
  - 计数：组数、订单数、返回订单数、略去订单数、商品数、返回商品数；
  - `excluded` 写明没读收货人、地址、支付方式、账户、图片、按钮和内部编号。
- **页面检查**：只接受 `order.jd.com/center/list.action`。遇到登录、限流或验证就停，限流和验证记入 `throttle-observations.json`（页面类型 `orders`）。找不到列表或列表里没有订单卡片时报 `PAGE_STRUCTURE_CHANGED`：没有订单时的样子还没见过，这一版不认。
- **导出**：两条 `order_list_view`（时间范围、状态筛选）、6 条 `order_scan`（计数）；每个拆单横幅一条 `order_split_notice`；每单一条 `order`、`order_date`、`order_shop`、`order_status`、`order_price`，每件商品一条 `order_item`。覆盖范围列出 `status`、`scope`、`scrolled`、`full_order_history`、`time_range_verified`、`amount_meaning_verified`。不导出收货人、支付方式、按钮和图片地址。

## 单个订单详情

```sh
node scripts/shopping.mjs page-open --platform jd --orders
node scripts/shopping.mjs task-start --platform jd --task jd-order-1 --order-detail --tab <page-open 返回的 tab_id> --order-position 1
node scripts/shopping.mjs task-run --task jd-order-1
node scripts/shopping.mjs report-export --task jd-order-1 --format markdown --output <新文件路径>
```

- **为什么要点击**（2026-10-19 探查）：列表上的“订单详情”不是链接，点击后页面用 `window.open` 在新标签页打开 `details.jd.com/normal/item.action?orderid=…&PassKey=…`。口令 `PassKey` 每单不同，只凭订单号拼不出地址，所以不能用 `page-open` 直接打开。脚本点击不算用户手势，Chrome 默认会把它当弹窗拦下：**用户要先在所用 Chrome 资料里允许 order.jd.com 弹出窗口**（设置 → 隐私和安全 → 网站设置 → 弹出式窗口和重定向 → 允许）。这是用户自己的浏览器设置，程序不改。
- **窗口与暂停**：京东新弹出的订单详情页会被带到前面；普通列表读取不提窗。详情页遇到登录、验证码或限流时，先保存暂停状态，再显示那个详情页一次，不显示来源列表来代替它；显示失败保留原错误。等待用户期间服务保持运行，重启后不能自动认回原页面编号。
- **做法**（用户 2026-10-19 同意，任务类型 `jd_order_detail`）：
  1. 读一次订单列表，取第 N 单（`--order-position` 1～10，按列表上订单卡片的顺序）的订单号，确认它有“订单详情”入口；
  2. 记下本次连接已有的标签页，在这一单的“订单详情”上点一次。点击前页面脚本再核对这张卡片的订单号，不一致就不点。点击按页面加载计入节奏额度；
  3. 等 5 秒后看标签页，最多看 3 次、间隔 3 秒：只认点击后新出现、地址是这一单详情页的那一个标签页。新标签页是登录页或限流页时暂停等用户；看 3 次都没有就报 `ORDER_DETAIL_NOT_OPENED` 并停下，**不再点第二次**（多半是弹窗没允许）；有两个以上就报 `ORDER_DETAIL_TAB_AMBIGUOUS`；
  4. 读这个详情页一次（不点击、不滚动、不切换页签）。同一个地址有两种版式（2026-10-21 实页发现），读取时先认版式，结果的 `layout` 记下是哪一种：
     - `classic`：老版页面（2026-10-19 那单），有 `#orderstate`、`#process`、`#ordertrack`、`#orderinfo`；
     - `state_panel`：另一种版式（2026-10-21 一单已取消的订单），有 `.order-state`（状态、进度、订单号一行）、`.order-info-mod`（收货、配送、付款一类，不读）、`.order-goods`（商品表和金额）。送货方式只在不读的那一区里，所以这种版式 `shipping_text` 为空；
     - 两种都不是时报 `PAGE_STRUCTURE_CHANGED`；
     - 两种版式的商品表都可能有一列只放图片的商品链接（2026-10-21 旧版式多了“商品图片”一列），标题取第一个有标题或文字的商品链接；金额里名称和金额都为空的行跳过；
     - 页面上的订单号认不出时 `order_id_on_page` 为空（2026-10-21 一单旧版式就是这样，原因未查），这时只靠地址和列表核对订单号；
  5. 关闭这个详情页。关闭前核对它仍是这一单的详情页；关闭失败只记下原因，不影响读到的结果。订单列表页不关，由调用方用 `page-close` 关。
  - 点击先记录再发出；程序中途被打断时这次点击算作“不确定”，接着找标签页，绝不重点。
- **结果字段**（`operations[0].result`）：
  - `order_position`、`order_id`（列表上读到的）、`split_order`、`order_id_on_page`（详情页上读到的，和列表不一致时报 `TARGET_CHANGED`）；
  - `status_text`：订单状态原文（如“完成”）；
  - `progress`：进度节点的名称、时间原文、是否已到达，最多 10 个；
  - `layout`：版式，`classic` 或 `state_panel`；
  - `shipping_text`：送货方式一行（如“送货方式： 承运人：快递运输”），`state_panel` 版式为空；
  - `item_columns` 和 `items`：商品表的列名原文，每行的商品编号和链接、名称、各列文字（与列名按顺序对应，不另外解释；“操作”一列的按钮文字也原样留在这里，不点）、数量，最多 20 行；
  - `amounts`：金额明细，每行名称和金额原文（如“商品总价”“实付款”），是否就是实付没有核实；
  - `opening`：点击结果、看了几次标签页、读了几次、详情页是否已关闭；
  - `excluded` 写明没读收货人、地址、电话、物流跟踪记录（常带配送员姓名和电话）、付款信息页签、发票、`PassKey`、账户和图片。
- **导出**：一条 `order`（限定写是否子订单、详情页上的订单号和版式）、一条 `order_detail_opening`、3 条 `order_scan`、一条 `order_status`、每个进度节点一条 `order_progress`、一条 `order_shipping`、每件商品一条 `order_item`（各列文字放在说明里）、每行金额一条 `order_amount`。不导出收货人、跟踪记录、付款信息和详情页地址。
