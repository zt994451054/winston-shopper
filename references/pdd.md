# 拼多多

拼多多没有完整的电脑购物网站，Skill 用的是它的**手机网页版** `mobile.pinduoduo.com`。2026-10-27 的探查确认，电脑 Chrome 能正常显示这个网页版：用普通的电脑浏览器标识，在所用 Chrome 资料里登录，不伪装手机。方案在 `output/consumer-shopping-research/pdd-design-2026-10-27.md`，探查记录在 `pdd-probe-2026-10-27.md`，搜索实页在 `pdd-search-live-2026-10-27.md`，商品详情的探查和设计在 `pdd-product-2026-10-27.md`，评价的方案和探查在 `pdd-reviews-design-2026-10-27.md`，实页验收在 `pdd-reviews-live-2026-10-27.md`；订单的方案和探查在 `pdd-orders-design-2026-10-27.md`，实页验收在 `pdd-orders-live-2026-10-27.md`；排序的方案和探查在 `pdd-sort-design-2026-10-27.md`，实页验收在 `pdd-sort-live-2026-10-28.md`；各规格价格的方案和探查在 `pdd-spec-prices-design-2026-10-28.md`，实页验收在 `pdd-spec-prices-live-2026-10-28.md`。

| 板块 | 状态 |
| --- | --- |
| 打开、关闭页面，列出标签页，绑定商品页 | 可用（2026-10-27） |
| 搜索（已加载的卡片） | 可用，2026-10-27 实页通过（20 张，与独立核对逐张一致），见下文 |
| 商品详情（从搜索卡片点进去） | 可用，2026-10-27 实页 3 件通过（电子产品、日用品、多规格服饰），与独立核对逐项一致 |
| 评价（“查看全部”页已加载的评价） | 可用，2026-10-27 实页 3 件有评价的商品和 1 件没有评价的商品通过 |
| 订单列表（已加载的卡片）、单个订单详情 | 可用，2026-10-27 实页通过：列表 10 单，详情 2 单（交易成功、退款成功），与独立核对一致 |
| 排序（销量、价格升序、价格降序） | 可用，2026-10-28 实页三种各一次通过，与独立读取一致 |
| 价格区间（可和排序一起用） | 可用，2026-10-28 实页通过：只设区间、区间加价格升序各一次 |
| 各规格价格（打开底部规格抽屉逐个点选项） | 可用，2026-10-28 实页 3 件通过（1 个按钮 2 件、2 个按钮 1 件），见 `pdd-spec-prices-live-2026-10-28.md` |
| 购物车 | 不做：拼多多没有购物车 |

## 页面与命令

```sh
node scripts/shopping.mjs page-open --platform pdd --search '罗技 M330'
node scripts/shopping.mjs page-open --platform pdd --orders
node scripts/shopping.mjs tabs --platform pdd
node scripts/shopping.mjs bind --platform pdd --tab <ID> --binding <名称>
node scripts/shopping.mjs page-close --tab <ID>
```

- **地址**：
  - 搜索 `search_result.html?search_key=`；
  - 商品 `goods.html?goods_id=`；
  - 评价 `goods_comments.html?goods_id=`；
  - 订单列表 `orders.html`；
  - 订单详情 `order.html?order_sn=`。
- **商品编号**：`goods_id`。搜索卡片点开的商品页带十几个跟踪参数，只保留编号。
- **商品页只从搜索卡片进入**（用户 2026-10-27）：只带编号直接打开时，页面给的是精简版，价格被遮成“7?.??”并提示“前往APP查看价格”，服务、评价、店铺都没有；从搜索结果点进去才是完整页面。所以 `page-open --platform pdd --url` 返回 `UNSUPPORTED_PLATFORM`，商品页用下文的商品详情任务从搜索卡片点进去。
- **另一个域名**：App 的分享链接用的是 `mobile.yangkeduo.com`，商品编号不变（用户 2026-10-27 发现）。Skill 只走 `mobile.pinduoduo.com`，另一个域名的页面一律不读。
- **没有购物车**：`page-open --platform pdd --cart` 返回 `UNSUPPORTED_PLATFORM`，不发送任何命令。
- **标签页类型**：`tabs --platform pdd` 返回以下类型：
  - `product`、`reviews`：保留规范地址和商品编号；
  - `orders_list`：保留规范地址；
  - `search`、`order_detail`、`login_page`、`risk_page`、`home`、`other`：只返回来源站点，不返回订单号、关键词和跟踪参数。
- **记录的页面何时算“还在”**：商品页跳到同一件商品的评价页仍算原页面，因为评价页是从商品页在同一个标签页里点进去的。
- **任务**：搜索（含排序和价格区间）、商品详情、各规格价格、评价、订单列表、单个订单详情（见下文），其他 `task-start` 选项返回 `UNSUPPORTED_PLATFORM`。
- **登录、验证、频繁提示**：
  - 认出这些页面的规则在 `lib/pdd/page-gate.mjs` 和 `lib/pdd/targets.mjs`；
  - 登录页 `login.html` 2026-10-27 实页见过：探查时连续点击后，点卡片跳到了 `login.html?from=…`，用户重新登录后恢复；
  - 验证页 `psnl_verification.html` 和提示文字还没在实页上见过，第一次遇到时要核对；
  - 遇到就停，告诉用户是哪个页面。
- **每个页面都有的二维码小窗**：右侧“用手机浏览器扫码在拼多多 App 打开”，不挡内容，不算拦截页。

## 搜索（已加载的卡片）

```sh
node scripts/shopping.mjs page-open --platform pdd --search '罗技 M330'
node scripts/shopping.mjs task-start --platform pdd --task pdd-mouse --search '罗技 M330' --tab <page-open 返回的 tab_id>
node scripts/shopping.mjs task-run --task pdd-mouse
node scripts/shopping.mjs report-export --task pdd-mouse --format markdown --output <新文件路径>
```

- **只读已加载的卡片**：不点击、不滚动、不点排序。2026-10-27 打开时已加载约 20 张，一屏只看得到 2 张，全部都读；最多读 40 张。
- **任务类型** `pdd_search`，结果格式 2：比格式 1 多了 `cards_not_rendered`。搜索结果放在“离屏幕远就先不画”（`content-visibility: auto`）的区域里，屏幕下方很远的卡片没有画出文字；手机这类一列大卡片的结果，第 9 张起就是这样（2026-10-28 “苹果 iPhone 16”，页面在前台也一样）。读取到第一张没画出的卡片就停，前面画出的照常返回，后面的只记张数，缺项里写 `cards_not_rendered`；不滚动页面，也不改页面样式去让它画出来。第 1 张就没画出时返回 `PAGE_STRUCTURE_CHANGED`。格式 1 的结果照原样回读。
- **每张卡片记录**：
  - `position`：位置；
  - `title`：页面上显示的标题。拼多多给的是截短的标题，完整标题要进商品页；
  - `price`：价格原文，`label` 是“券后”这类前缀，`amount_text` 把整数和小数拼起来，例如 `79.92`；
  - `sales_text`：销量原文，如“已抢 N 件”“本店已拼 N 件”“全店总售 N 万+件”；
  - `image_url`：主图地址，还没滚到的卡片取 `data-src`；
  - `pdd.labels`：标题和价格之间的标签原文，如“假一赔十”“退货包运费”“立减 5 元”“近 54 天 100% 好评”；
  - `pdd.lines`：卡片上的全部文字行，读回校验时按它重建结果。
- **没有商品编号**：卡片上没有编号也没有链接（2026-10-27 探查），`product_id` 和 `url` 都是 `null`。覆盖范围写 `product_ids_known: false`、`titles_complete: false`。用户 2026-10-27 选了方案 A：编号留到“商品详情”那一块，用“点搜索结果第 N 张进入商品页”取得。
- **怎么认卡片**：类名是随机字符串，所以按结构认。每个“¥”往上找到不包含别的“¥”的最高一层，这一层就是一张卡片；卡片必须有图片。顺序按页面位置从上到下、同一行从左到右。这样一列网格和“返回”后出现的左右两列（2026-10-27 实页）都能认。文字行依次是标题、标签、可选的“券后”、¥、金额、可选的小数、销量。认不出就返回 `PAGE_STRUCTURE_CHANGED`，不猜。
- **核对页面**：只接受 `mobile.pinduoduo.com/search_result.html` 且 `search_key` 与任务完全一致的页面；遇到登录、验证、频繁提示就停，并记进限流记录。
- **导出**：`report-export` 支持 `pdd_search`。每张卡片一条 `search_item` 和 `search_sales`，另有 `search_marks`（标签）和 `search_image`（主图地址）。

## 排序与价格区间

```sh
node scripts/shopping.mjs page-open --platform pdd --search '无线鼠标'
node scripts/shopping.mjs task-start --platform pdd --task pdd-mouse-asc --search '无线鼠标' --tab <ID> --sort price-asc
node scripts/shopping.mjs task-run --task pdd-mouse-asc
```

```sh
node scripts/shopping.mjs task-start --platform pdd --task pdd-mouse-30-60-asc --search '无线鼠标' --tab <ID> --min-price 30 --max-price 60 --sort price-asc
```

- **只用刚打开的搜索页**：页面地址里还没有 `sort_type`，也没有价格区间，才点第一下。
- **价格区间**（`--min-price A --max-price B`，整数元，可以不带 `--sort`；2026-10-28 探查）：先于排序设好，步骤是：
  1. 点一次“筛选”，打开侧边面板，核对“最低价”“最高价”两个输入框是空的；
  2. 用扩展的填写命令（和京东相同）各填一个数，核对输入框里就是这两个数；
  3. 点一次“确认”（按钮上写着件数，如“确认 (1万+件商品)”）。页面在原地筛选，面板自己关上（外层变成 `visibility: hidden`）；
  4. 核对地址里出现 `price=A,B`，“筛选”变成选中颜色，面板已关。

  “确认”还会在地址里写 `sort_type=default`，它和没有 `sort_type` 一样表示综合排序。之后的排序点击要核对区间仍在地址里；判断排序选中项时，“筛选”的红色算区间的，不算排序项。
- **核对卡片在区间内**：按显示的金额，券后价也算，记下核对了几张、区间外几张。地址里的区间、“筛选”选中、至少一张卡片且全部在区间内，`price_range_verified` 才是 true。
- **点击**（2026-10-27 探查）：
  - 排序在原页面重排、不重新加载，但地址里的 `sort_type` 会跟着变；
  - `sales` 点一次“销量”，`sort_type` 变成 `_sales`；
  - `price-asc` 点一次“价格”，变成 `price`。**拼多多第一次点“价格”是从低到高**，和京东相反；
  - `price-desc` 点两次“价格”，第二次之前要先确认第一次已经是 `price`，第二次后变成 `_price`。
- **每次点击**：
  - 点之前记下意图，只点一次，中断后不重点；
  - 页面脚本先核对地址里的 `sort_type` 是这一步预期的起点，不是就返回 `SEARCH_SORT_STATE_CHANGED`，什么都不点；
  - 点完等 8 秒，核对两样：地址里的 `sort_type`，以及排序栏只有这一项是选中颜色（选中项变红，其他项同一种灰色）。最多看 3 次（间隔 4 秒），还不对返回 `SEARCH_SORT_NOT_APPLIED`，不再点。
- **读卡片**：和搜索任务一样，只读已加载的卡片，不滚动。价格排序还要核对卡片顺序：
  - 按卡片上显示的金额比较，券后价也算，和页面的排法一致；
  - 结果记下顺序对的、反的、相等的各有几对；
  - 整体反了返回 `SEARCH_SORT_DIRECTION_MISMATCH`，不保存。
- **点击的节奏**：排序点击和区间的“确认”都会重排搜索结果，按搜索类加载算，占拼多多的搜索额度（每 10 分钟 3 次，每小时 10 次）；打开“筛选”和填写按普通动作算。`page-open` 加价格降序的两次点击正好用完 10 分钟的额度；再加区间就会超过，任务返回 `pending` 和可以继续的时间，到时同一任务再运行即可。
- **任务类型** `pdd_search_sort`，结果格式 2（2026-10-28 当天先存的格式 1 只有排序，照原样回读）：
  - `sort`（可为 `null`）、`price_range`（请求的区间或 `null`）、`sort_type`（页面地址里的，`default` 记为 `null`）、`address_price_range`（地址里的 `price`）、`selected`（排序栏选中的项）；
  - `actions`：每一步（`open_filter`、`fill`、`confirm`、`sort`）的结果和检查次数；
  - `order_check`：价格排序的顺序核对；`range_check`：区间核对；没有对应条件时为 `null`；
  - `search`：和搜索任务结果相同的卡片；
  - `coverage`：`sort_ui_verified`、`url_reflects_sort`、`sort_direction_verified`、`price_range_verified`，没有对应条件时为 `null`。
  - 失败时：动作做了但页面没变化，排序返回 `SEARCH_SORT_NOT_APPLIED`，区间返回 `SEARCH_PRICE_RANGE_NOT_APPLIED`，都不再重做。
- **导出**：`report-export` 支持 `pdd_search_sort`：`search_price_range_action`、`search_sort_click`、`search_price_range_check`、`search_sort_state`，然后是和搜索任务相同的卡片记录。

## 商品详情（从搜索卡片点进去）

```sh
node scripts/shopping.mjs task-start --platform pdd --task pdd-mouse-2 --source-task pdd-mouse --position 2
node scripts/shopping.mjs task-run --task pdd-mouse-2
node scripts/shopping.mjs report-export --task pdd-mouse-2 --format markdown --output <新文件路径>
```

- **怎么进入**：`--source-task` 是一个已完成的拼多多搜索任务，或排序、价格区间任务（2.0.10 起，第 N 张按排序后的顺序），`--position N` 是它读到的第 N 张卡片。任务用搜索任务的标签页，不另给 `--tab`：
  1. 先核对第 N 张卡片的标题和价格仍和保存的一致，不一致返回 `SEARCH_CARD_CHANGED`，什么都不点；
  2. 把卡片滚到可见处，点一次它的主图。点击计一次页面加载，在点之前记下意图，中断后不重点；
  3. 等 8 秒看标签页地址，最多看 3 次（间隔 4 秒）。变成商品页就记下 `goods_id`；变成登录页或验证页就停；还是搜索页返回 `PRODUCT_NOT_OPENED`；
  4. 读商品页一次，完整标题必须以卡片标题开头，否则返回 `TITLE_MISMATCH`。
- **任务类型** `pdd_product`，结果格式 1。搜索页留在原标签页的历史里，任务不返回、不关闭标签页。
- **读到的内容**（都按页面原文）：
  - `title` 完整标题；`price`：标签（如“补贴价”“券后”）、¥、金额，`price_notes` 是价格下方的优惠、已抢件数、运费说明；
  - `gallery`：主图计数（如“1/5”）和去重后的主图地址；
  - `highlights`：标题下方到评价之间的文字，如浏览量、“N 人在拼”、发货承诺、服务标签；
  - `reviews`：评价总数和页面上的 2～3 条预览**正文**；
  - `shop`：店铺名、店铺评价标签（如“回头客(687)”）和其他店铺文字。没有店铺评价标签的店，页面上也没有“该商品所属店铺评价”这个标题，就按“进店逛逛”所在的店铺卡片来认（2026-10-27 洗衣液）；
  - 没有评价的商品，页面上没有评价区，`reviews` 为 `null`；
  - `params`：“商品详情”下的参数（品牌、发货地等），`notices` 是“消费提醒”等说明；
  - `detail_images`：详情图地址（含还没加载、地址在 `data-src` 的），去掉头像；
  - `spec`：“已选：…”那一行（有的商品没有默认规格，写的是“请选择 容量”，原样保留），以及各规格组的名称和选项名（如“颜色分类”10 个、“尺码”3 个），选项旁的“最后9件”这类字样放在 `marks`。规格面板本来就在页面里，只是没显示，商品详情任务**不打开面板，不读各规格的价格**（用户 2026-10-27 选方案 A），各规格价格用下面的 `--spec-prices` 任务另读；
  - `bottom_bar`：底部栏的价格和按钮文字。
- **标题核对**：卡片标题和完整标题比较时，先去掉空格、括号和图标字符。卡片把“【罗技】”画成图标字体的两个私有区字符加“罗技”，完整标题是普通的“【罗技】”（2026-10-27 实页）。视频的备用文字“您的浏览器可能不支持视频播放”不算页面文字。
- **不读的内容**：别的买家的拼单行（昵称、倒计时、“去拼单”）整行跳过，只记跳过了几行；评价人昵称（和头像在同一小块里）跳过，只记个数；“相似商品”是别的商品，不读。这三样在页面脚本里就去掉，不离开页面。
- **价格被页面隐藏**：有些商品点进去也只显示“7?.??”和“前往APP查看价格”（用户 2026-10-27 确认，App 分享链接打开也一样）。这时 `price.kind` 是 `hidden_by_page`、`amount` 为空，`coverage.price_hidden_by_page: true`，缺项里有 `displayed_price`。用户决定这类商品跳过，不用想办法拿价格。
- **导出**：`report-export` 支持 `pdd_product`：`product`、`product_entry`（从哪张卡片进来）、`product_price`、`price_note`、`page_line`、`product_shop`、`shop_line`、`review_tag`、`parameter`、`page_notice`、`spec_chosen`、`spec_option`、`review_summary`、`review_preview`、`image_link`。

## 评价（“查看全部”页已加载的评价）

```sh
node scripts/shopping.mjs task-start --platform pdd --task pdd-mouse-2-reviews --source-task pdd-mouse-2 --reviews
node scripts/shopping.mjs task-run --task pdd-mouse-2-reviews
```

- **怎么进入**：`--source-task` 是一个已完成的拼多多商品详情任务，任务用它的标签页（当时停在商品页）：
  1. 商品详情任务没读到评价区（新商品没有评价），或者评价数为 0：直接返回 `outcome: "no_reviews"`，不点击、不碰标签页；
  2. 否则核对商品页上“商品评价(N)”的数和商品详情任务读到的一样，不一样返回 `REVIEWS_CHANGED`，什么都不点；
  3. 把“查看全部”滚到可见处，点一次。点击计一次页面加载，点之前记下意图，中断后不重点；
  4. 等 8 秒看地址，最多看 3 次（间隔 4 秒）。变成同一件商品的评价页 `goods_comments.html` 就读；变成登录页或验证页就停；还是商品页返回 `REVIEWS_NOT_OPENED`；
  5. 读评价页一次，还没画完就 10 秒后再读一次，不重点。
- **只读“全部”**（用户 2026-10-27 选 A）：不点分类标签，不滚动，只读已加载的评价，最多 20 条。2026-10-27 探查时页面只显示“全部(142)”一个分类，不滚动就有 19 条。
- **任务类型** `pdd_reviews`，结果格式 3：格式 2 多了 `page_notes`，格式 3 每条评价只留认得出的块、其他块只记个数（`other_blocks_skipped`）。当天早些时候保存的格式 1、2 结果照原样回读。读完后标签页停在评价页，不返回、不关闭；同一个商品详情任务再开一个评价任务时，因为标签页已经不是商品页，会在点击前拒绝。
- **每条评价**（页面原文）：`spec` 购买的规格（如“型号：M330黑色【全新】”）、`text` 正文、`date`、`follow_up` 追评、`merchant_reply` 商家回复、`other_lines` 认不出的其他行、`images`／`videos` 评价图和视频的张数（不存地址：评价图是买家上传的，可能拍到个人信息）、`expand_shown` 页面有没有“展开”。长评被样式截成 5 行，但全文就在页面里，所以不点“展开”也能读全。日期、追评、商家回复在 2026-10-27 的 19 条里都没出现，页面有才读，没有就是 `null`。
- **怎么认出每条评价**：按评价人头像（不超过 60 像素宽、地址在 `avatar…pddpic.com` 的小图）切分，每个头像往上到“只含这一个头像”的最大一块就是一条评价。不能按“赞”来分：有的评价没有“赞”字，点赞数顶替了它，显示成“1 / 评论”（2026-10-27 鼠标第 7 条、连衣裙第 2 条）；最初按“赞”分时，鼠标页 20 条只认出 19 条，连衣裙页整个列表被当成一条。底部栏里的小图标和正文里的表情图片（47 像素，来自别的图片站）都不算头像。页面上任何一个“赞”或“评论”不在认出的评价里，或者头像那一块里含有“赞”或“评论”，都说明没认对，整页返回 `PAGE_STRUCTURE_CHANGED`，不返回半对的结果。
- **只留认得出的块**：每条评价只留规格行、紧跟在规格后面且在评价图之前的正文、以及以日期、“追评”或“商家回复”开头的块；其他块整块丢弃，只记个数。原因是评价下面会显示别人的回复预览，开头是回复人的昵称（2026-10-27 鼠标 2,669 条那页）。“评价总结小助手”这段也因此不保留。操作区可能只有图标和数字（没有“赞”“评论”两个字），也不读。只有图没有字的评价，`text` 为 `null`。
- **结果其他字段**：`tabs` 页面显示的分类标签原文（有的商品还会列出“手感很好(55)”这类印象标签，原样记下，不点），`page_notes` 列表下面到底部栏之间的说明（如“该商品还有3条默认好评”），`loaded_count` 已加载条数，`reviews_cut` 超过 20 条时为 true，`reviewer_names_skipped` 跳过的名称行数，`entry` 记下从哪个商品详情任务来、商品页上的评价数、点击和地址检查次数。
- **不读的内容**：每条评价的第一块是头像和评价人名称，整块丢弃，只记行数；第一块不是头像那一块的，整页返回 `PAGE_STRUCTURE_CHANGED`，宁可不读也不让名称漏出去。“赞”“评论”和它们旁边的数字不读不点。评价页里还带着商品页的底部栏和隐藏的规格面板，也不读。
- **导出**：`report-export` 支持 `pdd_reviews`：`product`、`review_summary`（分类标签、商品页评价数、已加载条数、跳过的名称数）、`review`（规格、正文、图片和视频张数）、`review_date`、`review_follow_up`、`review_reply`、`review_line`、`page_notice`（列表下面的说明）。

## 各规格价格（底部规格抽屉）

```sh
node scripts/shopping.mjs task-start --platform pdd --task pdd-mouse-2-specs --source-task pdd-mouse-2 --spec-prices
node scripts/shopping.mjs task-run --task pdd-mouse-2-specs
```

- **为什么要点购买按钮**：商品页上没有单独的“已选”行，规格抽屉只能从底部栏的购买按钮打开；抽屉头部只显示当前所选规格的价格，换一个规格才出现另一个价格（2026-10-28 探查 7 件商品）。用户 2026-10-28 同意点这些按钮和规格选项，**只有一条原则：绝不能代用户下单，也不能进入订单页面**。
- **怎么进入**：`--source-task` 是一个已完成的拼多多商品详情任务，任务用它的标签页（当时停在商品页）。商品详情任务没读到规格组的返回 `SPEC_GROUPS_MISSING`，价格被页面隐藏的返回 `PRICE_HIDDEN_BY_PAGE`，都不点击。
- **步骤**（每次点击前记下意图，中断后不重点；每次点击后都读一次抽屉并核对标签页还是这件商品的商品页，离开就返回 `TARGET_CHANGED` 停下）：
  1. 读一次底部栏，记下购买按钮的原文（如“单独购买”“最后4件 免拼购买”“快要抢光 免拼购买”）。页面里没有带这些规格组的抽屉时，什么都不点，结果写 `drawer_not_in_page`；
  2. 每个购买按钮各点一次，抽屉打开后读头部（价格、“已选”、其他字样如“券前¥340.99”“2件9.9折”）；
  3. 在抽屉里逐个点**没选中**的选项，按页面顺序一组一组来（每次只换一组），每点一次读一次头部，每个抽屉最多点 12 次，超出的记在 `not_clicked`。选中的选项（红字红框）绝不点：再点一次会把它取消（2026-10-28 手机壳）。看起来不可选的（半透明、删除线、不可点）也不点，记在 `unavailable`。每点一次之后都按抽屉**当时**的样子决定下一个点什么：被前一个选择弄灰的选项跳过，记在 `skipped_greyed`（2026-11-08 运动鞋：换成另一种颜色后 43～45 码变灰，旧做法按打开时的计划去点 43 码就停了）。2026-10-28 运动鞋上第一次遇到：缺货的颜色是浅灰字、不能点，程序认出后没点；
  4. 点抽屉头部的关闭图标一次，核对抽屉已关上，再处理下一个按钮。
- **绝不点**：抽屉底部的按钮（“确定”“单独购买”等，文字随入口变化）、“去拼单”、数量加减。页面脚本只认三种点击：底部栏的购买按钮（只在页面里已有带规格组的抽屉、且没有抽屉打开时）、一个未选中的选项、抽屉的关闭图标。
- **结果**（任务类型 `pdd_spec_prices`，格式 2，2026-11-08 起；格式 1 原样回读）：`buttons` 底部栏按钮原文；`drawers` 每个按钮一项：`kind`（`alone` 单独购买，`group` 其他）、`readings`（打开时和每次点选项后的 `chosen` “已选”原文、`price` 价格原文和解析（没选全时是区间，如“¥336.99-341.99”）、`notes` 头部其他字样、`selected` 各组当时选中的项、`confirmed` 页面是否显示点的那项已选中）、`groups` 选项列表、`unavailable`、`not_clicked`、`skipped_greyed`（格式 2：被前一个选择弄灰而没点的选项；有这项时 `coverage.status` 为 `partial`，`coverage.options_skipped_greyed` 是个数）、`other_lines` 抽屉其他文字、`closed`。任务中途停下没有结果时，`task-status` 的 `partial_readings` 按抽屉列出已经读到的价格（2026-11-08：最后关抽屉失败，6 个价格都读到了却一个没交出来）。“单独购买”和“免拼购买”的价格不同，规格选择在两个抽屉之间共用（2026-10-28 探查），所以第二个抽屉打开时停在第一个抽屉最后选的规格上。
- **不包括**：各组之间的所有组合（只每次换一组）、实付价、数量、抽屉里的按钮。
- **节奏**：点击和读取都不算页面加载；点完等 3.5～4 秒再读，读不到想要的状态 3 秒后最多再读 2 次。
- **导出**：`report-export` 支持 `pdd_spec_prices`：`product`、`spec_drawer_scan`（按钮和点击次数）、`spec_drawer`、`spec_price`（“已选”、价格原文、点了哪个选项、是否确认、其他字样）、`spec_option_unavailable`、`spec_option_not_clicked`、`spec_option_greyed_after_choice`（格式 2）。

## 订单列表（已加载的订单卡片）

```sh
node scripts/shopping.mjs page-open --platform pdd --orders
node scripts/shopping.mjs task-start --platform pdd --task pdd-orders-1 --orders --tab <ID>
node scripts/shopping.mjs task-run --task pdd-orders-1
```

- **只读打开时已加载的订单卡片**（用户 2026-10-27 选“不滚动”）：停在“全部”，不滚动、不切换分栏、不点击，最多 50 单。2026-10-27 探查时这个账户“全部”下有 10 单，后面写着“没有更多了...”。
- **任务类型** `pdd_orders`，结果格式 2：真实列表把数量写在规格前面（“×2，标准【断桥锁点】”），格式 2 认这种写法；当天先按格式 1 保存的结果照原样回读。每单（页面原文）：`shop` 店铺名、`status` 订单状态；`items` 每件商品的 `title`、`spec` 规格、`quantity` 数量（从“×2，”这类文字读出）、`tags` 其他标签（如“7天价保”）；`amount` 金额行：`label`（实付或应付）、`amount_text`、`pay_later_shown`（有没有“先用后付”）、`shipping_note`（如“免运费”）、`lines` 金额行原文。
- **列表上没有订单号和下单时间**，`order_id` 为 `null`，到订单详情任务里取得。
- **不读的内容**：金额行前面的小头像是拼单成员，只记个数（`group_avatars_skipped`）；按钮（售后详情、删除订单、再次拼单、更多等）和金额行的隐藏副本只记个数（`other_rows_skipped`）；“没有更多了”后面的“精选推荐”不读。
- **覆盖**：页面写着“没有更多了”且全部读到时 `coverage.status` 为 `complete`；否则为 `partial`，`missing` 含 `orders_not_loaded`。
- **导出**：`report-export` 支持 `pdd_orders`：`order_scan`、`order`、`order_shop`、`order_status`、`order_price`、`order_item`。

## 单个订单详情（从订单列表点进去）

```sh
node scripts/shopping.mjs task-start --platform pdd --task pdd-order-3 --source-task pdd-orders-1 --order-position 3
node scripts/shopping.mjs task-run --task pdd-order-3
```

- **只从订单列表进入**：来源必须是完成了的 `pdd_orders` 任务，用它的标签页，不直接打开 `order.html` 地址。
- **步骤**：
  1. 核对第 N 单的店铺名、状态和第一件商品的标题，和列表任务保存的一样才点；不一样返回 `ORDER_CHANGED`，什么都不点；
  2. **点一次商品名称**，不点卡片上的任何按钮。点击计一次页面加载，点之前记下意图，中断后不重点；
  3. 等 8 秒看地址，最多看 3 次（间隔 4 秒）。变成 `order.html?order_sn=…` 就继续，只保留 `order_sn`；变成登录页或验证页就停；还是列表返回 `ORDER_NOT_OPENED`；
  4. **点一次“查看更多订单和优惠信息”**（用户 2026-10-27 选“点开一次”；没有优惠的订单这个入口写作“查看更多订单信息”，2026-11-07 在测试机上发现，两种都认）：它在原页面里展开，地址不变。计一次页面内操作，点之前记下意图，不重点；页面上没有这个入口就不点，`entry.expand` 为 `not_shown`，时间为空；
  5. 读详情页一次，没画完就 10 秒后再读一次，不重点。
- **任务类型** `pdd_order_detail`，结果格式 2：格式 1 只认“查看更多订单和优惠信息”，遇到“查看更多订单信息”时不点开、没有时间，这行字留在 `lines`，`info_folded` 记为 false；格式 2 两种写法都认，`info_folded` 表示读取时入口还折叠着。以前保存的格式 1 结果照原样回读。字段：`order_id`（地址里的 `order_sn`），`order_number_shown`（页面上“订单编号”，和地址不一致返回 `ORDER_NUMBER_MISMATCH`），`status_words` 顶部认得出的状态词（如“已签收”；退款单顶部没有这一块，“退款成功”在订单块里，作为一行留在 `lines`，`status_words` 为空），`amount` 实付或应付，`discount_lines` 优惠说明（如“大促后共优惠 ¥0.02”），`times` 以“时间”结尾的各行（下单时间、拼单时间、发货时间、成交时间），`lines` 订单块其他行原文（按钮去掉），`entry` 记下从哪个列表任务、第几单、两次点击的结果和地址检查次数。
- **不读的内容**：
  - 顶部状态块里收货人、电话、地址和状态在一起，只留认得出的状态词，其他整块丢弃，只记个数（`top_parts_skipped`）。认不出的状态宁可不留；
  - 支付方式（含“已从微信支付…”一行）、物流公司、快递单号、收货人、地址、电话这类标签开头的行和它下面的行，整段跳过，只记个数（`rows_skipped`）；
  - 所有按钮和“复制”，下方推荐商品。
- 读完后标签页停在详情页，不返回、不关闭。要读另一单，重新打开订单列表、建新的列表任务；同一个列表任务再建详情任务时，因为标签页已经不是列表，会在点击前拒绝。
- **导出**：`report-export` 支持 `pdd_order_detail`：`order`、`order_detail_opening`、`order_status`、`order_price`、`order_amount`（优惠说明）、`order_time`、`order_line`。

## 节奏

拼多多有自己的账本 `pacing-pdd.json`，额度比淘宝、京东低（用户 2026-10-27 决定），见 [节奏](pacing.md#拼多多2026-10-27-起)。

## 探查得到的页面情况（供后续板块用）

- 搜索卡片和订单卡片上都没有链接或编号，点卡片靠页面脚本，在同一个标签页里跳转。
- 类名是随机字符串。订单列表有固定的 `data-test` 标记：店铺名称、店铺图片、订单状态、商品名称、商品图片。
- 商品页上“N 人已拼”下面列着其他买家的昵称，这一块不读不存。
- 下单面板里的规格名称已经在页面里，只是隐藏着，不打开面板就能读。面板头部只显示当前选中规格的价格，其他规格的价格要逐个点选才出现。
- 评价预览里有的显示真实昵称，有的显示“拼多多用户”，都不读。
- 订单详情页有“删除订单”“设为匿名”“联系商家”等按钮，一律不点。
