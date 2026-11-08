# 命令接口

单订单统一入口为 `order-workflow-start --workflow NAME --tab ID --order-position N`（N为1–5），随后使用同名 run／status／resume／end。固定列表→入口→正文子任务，整条链共享2次显式恢复、5次平台重试、1次频控探测和120000ms原等待额度；2026-10-12 实页 2 单通过，见[命令、预算与边界](order-workflow.md)。不接受 source-task、替换 tab／位置或续批参数；status／end 仅本地。

新规格图片任务使用格式3：先单独保存完整已扫描名称，再按每项最多3次图片读取自动分批（每普通批最多5项）。名称最多3次单独计数，总保护按3＋3×带支持图片容器的选项数计算；不再固定总10次。详情正文、详情图、主图、评价及下载各有自己的预算，不占此规格次数。见[规格流程与限制](specification-images.md)。

缺图满足来源／几何条件才每项最多预留一次滚动，保护及只读后查各占该项一次，后查不扣其他项次数。动作先落盘，中断不重发；原暂停、共享故障重试和平台停止不变。旧格式1／2及手动批次保持原预算，不升级；新格式已有短袖单商品正式实页正例：47名称及39个颜色图片链接，25读／2实际滚动；见实页验收。部分结果在operations[0].image_collection，已得数据与缺项分别交付。

所有路径都相对安装包解析，工作目录可以不同。示例中的 `node` 必须为 22 或更新版本。

## 命令与作用

| 命令 | 输入 | 返回值 | 副作用 |
| --- | --- | --- | --- |
| `doctor` | 可选 endpoint、timeout | Node、依赖和服务状态；零任务页面也可就绪 | 只查询状态，不启动、不重连、不读页面 |
| `setup` | 无 | 依赖、装了扩展的资料（`extension.profiles` 目录名，`extension.profile_names` 用户看到的名字）、令牌状态，`status` 和 `next_action` 说明首次使用的下一步 | 只检查，不安装、不连接；只看各资料里有没有扩展的安装文件夹，并从 Chrome 的资料列表（`Local State`）取这些资料的名字 |
| `setup --install` | 无 | 同上，并给出依赖路径、版本、锁文件核对 | 按锁安装本机 Playwright 依赖；不打印令牌 |
| `setup --open-store` | 可选 `--new-profile` | `store_opened`，新建时给出新资料目录名 | macOS 上在 Chrome 打开扩展商店页；`--new-profile` 让 Chrome 自己新建一个专用资料。用户自己点“添加至 Chrome” |
| `platform-unlock` | 必需 `--platform taobao\|jd\|pdd`；可选 state-dir | `platform_unlocked`，`unlocked` 表示原来是否锁着 | 平台出现限流、验证码或登录页后会锁 15 分钟（`PLATFORM_LOCKED`）；只在用户说已经处理好后运行，提前解锁。不向平台发送任何请求 |
| `token-save` | `--dialog` | `token_saved` | macOS 从剪贴板读取用户在扩展里“复制”的令牌，保存为权限 `600` 的文件并清空剪贴板；`--dialog` 改为弹出隐藏输入对话框让用户粘贴。不打印令牌 |
| `bridge-start` | 可选 `--profile 资料目录名`、endpoint | `bridge_connected`、`started`、`state`、PID、`instance_id` | 启动或复用常驻服务，不重复连接扩展；没有保存或给定资料时，自动用唯一装了扩展的资料 |
| `bridge-stop` | 可选 endpoint | `bridge_stopped`、是否实际停止 | 仅停止本安装记录的服务及其子进程；不关闭整个 Chrome |
| `tabs` | 可选 `--platform taobao`（默认）、`jd` 或 `pdd` | 脱敏的淘宝／天猫、京东或拼多多标签页 | 只读；排除其他网站 |
| `page-open` | `--search 关键词`、`--url 商品链接`、`--orders`、`--cart` 四选一（拼多多没有 `--cart` 和 `--url`）；可选 `--platform jd` 或 `pdd`、连接和 state-dir | `platform`、`tab_id`、`kind`、`url_matches`，京东和拼多多另有 `landing`；不回显网址 | 在本次 Playwright 连接中新开一个标签页，计入[节奏](pacing.md)的加载次数；记入状态目录的 `opened-pages.json` |
| `page-close` | 必需 tab；可选连接和 state-dir | `tab_id`、`platform`、`kind`、`source`（`page_open` 或 `order_entry_task`），订单详情页还有 `task` | 只关闭 `page-open` 或订单入口任务打开的页面。以下情况拒绝，什么也不关：未完成的任务或订单工作流仍在使用（`TAB_IN_USE`）；当前地址已不是原来的页面（`TAB_ADDRESS_CHANGED`）；页面已不存在（`TARGET_MISSING`）。在别的窗口里的页面，会按编号核对后照常关闭；不是本程序打开的（`TAB_NOT_OPENED_BY_PROGRAM`）。地址核对允许同一关键词翻页、排序和跟踪参数；关闭时总是指定标签页编号，并在关闭后确认它已不存在 |
| `bind` | 必需 tab；可选 `--platform jd` 或 `pdd`、binding、state-dir、replace | 平台、绑定名称、保存路径和规范目标链接 | 读取公开元信息并保存本地绑定 |
| `probe` | 可选 binding、state-dir | 重新核对后的标题、商品 ID、来源与读取时间 | 只读；不改绑定文件 |
| `task-start` | 必需 task；bindings、plan、search 三选一；可选连接和 state-dir | 去重后的商品数、操作数、任务类型 | 保存绑定、组合计划或搜索目标，不访问浏览器 |
| `task-run` | 必需 task；可选连接和 state-dir | 读取结果、预算、缺失项、暂停状态 | 按类型读取、切换指定规格、导航搜索、限定翻页／销量切换／价格入口点击或悬停检查／展开评价或服务说明；保存检查点 |
| `task-next-batch` | 必需task；可选原连接和state-dir | 旧批次规格图片任务的下一批及累计覆盖 | 仅从awaiting_batch续读最多5项，预留原读取预算，至少间隔1.5秒；新采集日志由task-run自动续读，不解除故障暂停 |
| `task-status` | 必需 task；可选 state-dir | 保存的结果、计数与下一步 | 只读检查点，不访问浏览器 |
| `report-export` | 必需 task、format=markdown或csv、output；可选 state-dir、json | 私有报告路径、条数、字节数和 SHA-256 | 仅本地读取有效缓存，独占写入原状态目录之外的新文件，不改变预算；见[导出说明](report-export.md) |
| `task-diagnose` | 必需 task；可选连接和 state-dir | 原目标与本次连接可见页面的匹配原因、相同目标候选 ID | 查询一次标签页元信息，不读取 DOM、不修改检查点或预算 |
| `task-resume` | 必需 task 和一种 after-*；可选连接和 state-dir | 显式恢复后的进度 | 按原预算读取并保存 |
| `task-rebind` | 必需 task；商品用 binding，搜索用 tab；可选连接和 state-dir | 新标签页的绑定状态 | 商品在本地接回绑定；搜索检查标签页身份；均保留预算 |
| `task-end` | 必需 task；可选 state-dir | 保留结果与预算的 ended 状态 | 用户明确结束本轮时更新本地任务 |

通用连接选项：`--endpoint`、`--timeout-ms`、`--json`。默认地址为 `http://127.0.0.1:19825`。`setup` 只接受安装和 JSON 选项；`bridge-start` 只接受 endpoint、profile 和 JSON 选项，`bridge-stop` 只接受 endpoint 和 JSON 选项。安装顺序、隐藏输入令牌和资料目录名见[环境准备](setup.md)。

服务在命令之间和暂停时保持运行；确定不再继续原页面时才用 `bridge-stop`。服务重启不能自动认回旧页面编号，不会自动迁移任务。旧通道入口已删除，检查点和缓存回读见[旧结果说明](dedicated-browser.md)。跳前台的有限例外见[窗口规则](setup.md#窗口何时会到前面)。

`--bindings` 为逗号分隔的绑定名，1–50 个，不含空项。`--task` 使用与绑定名相同的命名规则。`task-resume` 只能选择一个 `--after-user`、`--after-cooldown`、`--after-connection`，具体恢复条件见 [任务说明](tasks.md)。`task-status`、`task-end` 不接受连接参数。

`task-start --search <关键词> --tab <ID> --pages 2` 是实验性的限定两页模式，其他 pages 值和与商品模式组合均拒绝。只从同关键词第 1 页开始，最多一次“下一页”点击、每页 25 张卡片；结果在 `operations[0].result.pages`，暂停时已确认的页面在 `partial_pages`。已通过一个关键词在人工验证后的两页实测，覆盖和恢复边界见[搜索与评价](search-and-reviews.md)。

`task-start --orders --tab <ID> --pages N`（1～10）从“所有订单”第 1 页开始读多页订单，每页一次带核对的“下一页”点击；不能与 `--order-rows` 组合。规则见[订单多页](orders-reading.md#多页读取)。

`task-start --search <关键词> --tab <ID> --sort sales` 是实验性的单次销量切换；不接受其他 sort 值，不与 pages 或商品模式组合。仅从同关键词、综合选中的第 1／2 页开始，最多一次销量点击、每次前 25 张卡片。结果在 `operations[0].result.before`／`after`，暂停前快照在 `partial_search`；界面切换与排名算法保证分开，详见同一指引。不存在任意排序参数或 URL 导航入口。

`--plan` 指向最多 20 个组合的 JSON 文件，格式及动作范围见 [规格计划](selections.md)。同商品的不同组合是不同操作。任务结果将操作完成数与 `distinct_products` 分开，不将组合数当作商品数。

`--search <关键词>` 必须同时给出 `--tab <ID>`，创建一项首屏搜索操作。`--reviews` 必须与 `--bindings` 同用且最多 10 个绑定，创建展开评价任务。两者不能与规格计划混用，详见 [搜索与评价](search-and-reviews.md)。

`task-start --platform jd --search <关键词> --tab <ID>` 创建京东搜索首屏任务（`jd_search`），只读已加载的卡片，不点击、不滚动。加 `--pages <2～5>` 创建京东搜索翻页任务（`jd_search_pages`）：标签页要停在第 1 页，每多读一页在“下一页”上点一次，确认翻页栏页号和卡片都变了再读这一页的首屏；翻不过去就停，不重点。加 `--sort sales|price-desc|price-asc [--pages <1～5>]` 创建京东搜索排序任务（`jd_search_sort`）：标签页要是刚打开的第 1 页、“综合”选中；销量点“销量”一次，价格降序点“价格”一次，价格升序点两次（先确认已从高到低），每次点完核对选中样式、卡片和价格顺序再继续，可再按“下一页”读到第 N 页。再加 `--min-price A --max-price B`（整数元，可以不带 `--sort`）时，先打开“价格区间”下拉、用扩展填写两个价格、点一次“确定”，核对按钮写着这个区间且每张卡片都在区间内，再排序。`task-start --platform jd --bindings <一个京东绑定> --details` 创建京东商品详情任务（`jd_product`），详情区没加载时最多滚动一次。`task-start --platform jd --bindings <一个京东绑定> --review-categories <JSON路径>` 创建京东分类评价任务（`jd_review_categories`），读“全部评价”面板里 1～3 个分类已画出的卡片，后台页面由程序先切到前面再读，仍不可见时才暂停；不滚动。`task-start --platform jd --cart --tab <ID>` 创建京东购物车任务（`jd_cart`），标签页用 `page-open --platform jd --cart` 打开；只读已加载的行，不点击、不滚动。`task-start --platform jd --orders --tab <ID>` 创建京东订单列表任务（`jd_orders`），标签页用 `page-open --platform jd --orders` 打开；只读已加载的订单卡片，不点击、不滚动、不翻页。`task-start --platform jd --order-detail --tab <订单列表ID> --order-position <1～10>` 创建京东单个订单详情任务（`jd_order_detail`）：在列表第 N 单的“订单详情”上点一次，读新开的详情页后关闭它；需要用户先允许 order.jd.com 弹出窗口。京东任务不接受其他 task-start 选项（`UNSUPPORTED_PLATFORM`），也不能用 `task-diagnose`、`task-rebind`、布局和图片命令。字段和限制见 [京东](jd.md)。

`--review-categories <JSON路径>` 必须与一个 `--bindings` 同用，且与 `--reviews`、`--details`、`--services`、`--plan`、`--search` 互斥。计划是1–3个不重复的精确分类名称，或 `[null]` 仅取当前分类；文件最大8 KiB且不接受符号链接。每类十个主评位置、只采文字，最多一次自动打开正常面板，支持持久化暂停与部分分类交付。新任务未完成时，partial_category_samples返回已确认样本，unconfirmed_category_observations最多返回最后一份有效但未确认的文字和原因；旧任务缺少新字段不回填。详见[文字采样](review-text-sampling.md)。

`--details` 必须与 `--bindings` 同用且最多 10 个绑定，创建只读的商品详情任务，返回基础快照及参数、图片链接、店铺和服务文案。不能与 `--reviews`、`--plan` 或 `--search` 混用，字段和限制见 [商品结果说明](products.md)。

`--services` 必须与 `--bindings` 同用且最多 10 个绑定，创建有限服务展开任务；与 `--details`、`--reviews`、`--plan`、`--search` 互斥。面板已打开则不点击；否则最多预留一次服务入口动作，后观察有上限，暂停／恢复不重发。结果含基础快照、详情和 `service_evidence`；不打开二级规则或核实权益。见[服务任务](services.md)。

`--gallery` 与一个 `--bindings` 同用且与其他模式互斥，独立读取最多20个顶部静态缩略图元素，任务类型 `product_gallery`。不读当前大图或切图，结果在 `operations[0].result.gallery.items`；可按原position使用 `image-export --region gallery`。复用原平台停止、恢复与下载预算，见[图集只读](gallery.md)。

普通图片集先回读已有结果，新的独立读取用 `--gallery`；`--details` 的 `details.gallery.items` 继续兼容。明确需要指定缩略图对应的当前主图时，`--main-images <JSON路径>` 必须与一个 `--bindings` 同用，与其他读取／动作模式互斥；它可能切图。计划包含1–3个实际观察到的精确缩略图URL，每张最多4次观察和1次选择意图，连续两次确认后交付当前主图实际URL。结果位于 `operations[0].result.samples`，未完成时已确认图片位于 `partial_main_images`。新主图子格式2允许读取遮罩下的已加载主图，并用 `unconfirmed_main_image_observations` 保留尚未确认请求归属的观察；点击保护和明确访问限制仍保留，旧格式1不升级。不处理营销弹窗、关闭评价、自动滚动或下载，旧详情及其图片预算不变；见[静态主图采样](main-images.md)。

新的详情子格式 2 包含 `availability`，区分链接、加载状态及本次未扫描数量；旧子格式 1 缓存原样回读。详情任务可在本次连接清单未列原保存标签时先执行固定的地址核对，匹配后受保护读取；不聚焦或重新导航。

2026-10-28 起 Skill 不再下载图片（用户决定）：只交付图片链接，调用方需要文件或看图时自己按链接取得。原来的 `image-export`、`image-resume` 命令已删除，见[图片链接](image-reading.md)。

`bind` 与 `probe` 的默认绑定名为 `default`。已有文件不会隐式覆盖，只有 `bind --replace` 会更换它。名称只允许最多 64 位的小写字母、数字、下划线、连字符，并以字母或数字开始。

`tabs` 对商品页保留规范链接和商品 ID；对搜索页仅标记 `search`，精确首页标记 `search_home`，其他淘宝页面标记 `other`，均只返回来源站点与标签页 ID，不返回标题、关键词、路径、订单号或跟踪参数。清单只包含本次 Playwright 连接能看到的页面，输出 `inventory_scope: playwright_connected_pages`；看不到用户自己打开的页面或其他资料的页面，列表缺失不能证明页面已关闭。不要通过来回切窗口寻找未接入的页面，任务页面用 `page-open` 或约定的任务入口打开。`bind` 默认只接受 `item.taobao.com/item.htm?id=...` 与 `detail.tmall.com/item.htm?id=...` 的公开商品页；加 `--platform jd` 时只接受 `item.jd.com/<编号>.html`。京东的绑定可以 `probe`，也可以用于京东商品详情任务（`task-start --platform jd --bindings 名称 --details`）。

`tabs --platform jd` 把京东页面标为 `product`、`search`、`cart`、`orders_list`、`login_page`、`risk_page`、`home` 或 `other`；商品页保留规范链接和编号（京东每个规格一个编号），购物车和订单列表保留规范地址，其他页面（包括订单详情）只返回来源站点。页面打开、关闭和节奏的京东规则见 [节奏](pacing.md#京东2026-10-15-起)。

`tabs --platform pdd` 把拼多多手机网页版的页面标为 `product`、`reviews`、`search`、`orders_list`、`order_detail`、`login_page`、`risk_page`、`home` 或 `other`；商品页和评价页保留规范地址和商品编号（`goods_id`），订单列表保留规范地址，其他页面只返回来源站点。`bind --platform pdd` 只接受 `mobile.pinduoduo.com/goods.html?goods_id=`。`task-start --platform pdd --task 名称 --search 关键词 --tab ID` 创建拼多多搜索任务（`pdd_search`），只读已加载的卡片，不点击、不滚动；拼多多卡片没有商品编号，标题是截短的。加 `--sort sales|price-asc|price-desc` 创建排序任务（`pdd_search_sort`）：在刚打开的搜索页上点“销量”一次、“价格”一次（从低到高）或两次（从高到低），每次点完核对地址里的 `sort_type` 和排序栏选中项，再读已加载的卡片；价格排序还核对卡片顺序。加 `--min-price A --max-price B`（整数元，可不带 `--sort`）先在“筛选”里设价格区间：点一次“筛选”、填两个数、点一次“确认”，核对地址里的 `price=A,B` 和卡片都在区间内，然后再排序。`task-start --platform pdd --task 名称 --source-task 搜索任务 --position N` 创建商品详情任务（`pdd_product`），搜索任务可以是普通搜索或排序／价格区间任务（2.0.10 起）：在搜索任务的标签页上核对第 N 张卡片的标题和价格，点一次，读同一个标签页里打开的商品页；拼多多商品页只从搜索卡片进入，`page-open --platform pdd --url` 返回 `UNSUPPORTED_PLATFORM`。`task-start --platform pdd --task 名称 --source-task 商品详情任务 --reviews` 创建评价任务（`pdd_reviews`）：在商品详情任务的标签页上核对“商品评价(N)”，点一次“查看全部”，读同一个标签页里打开的评价页上已加载的评价（只读“全部”，最多 20 条，不滚动，不读评价人名称）；商品详情任务没读到评价的，不点击直接返回“没有评价”。`task-start --platform pdd --task 名称 --source-task 商品详情任务 --spec-prices` 创建各规格价格任务（`pdd_spec_prices`）：在商品详情任务的标签页上，底部栏每个购买按钮各点一次打开规格抽屉，逐个点没选中的选项（每个抽屉最多 12 次），每次读抽屉头部的价格和“已选”，再点关闭图标；不点“确定”、抽屉里的按钮和数量，标签页离开商品页就停。`task-start --platform pdd --task 名称 --orders --tab ID` 创建订单列表任务（`pdd_orders`），只读 `page-open --platform pdd --orders` 打开的列表上已加载的订单卡片，不点击、不滚动；列表上没有订单号。`task-start --platform pdd --task 名称 --source-task 订单列表任务 --order-position N` 创建订单详情任务（`pdd_order_detail`）：在列表任务的标签页上核对第 N 单，点一次商品名称，在同一个标签页打开的订单页上点一次“查看更多订单和优惠信息”再读，不读收货人、支付和物流。`--position` 只用于拼多多；`--order-position` 在拼多多要和 `--source-task` 一起用。其他拼多多任务选项返回 `UNSUPPORTED_PLATFORM`，见 [拼多多](pdd.md)。

`task-diagnose` 对尚未成功或单项失败的操作逐项比较地址；返回原任务已保存的 `expected_url`、`reason` 和本次连接中精确匹配的 `matching_tab_ids`。它不输出其他页面地址、关键词、标题或跟踪参数，不自动选候选页。`ok: true` 只表示诊断命令完成，不代表地址匹配或页面已可读；登录及验证码状态仍需受保护的任务读取确认。全部操作已完成时不查询浏览器。

## 示例

```sh
node scripts/shopping.mjs doctor --json
node scripts/shopping.mjs tabs --platform taobao
node scripts/shopping.mjs bind --tab 123 --binding mouse
node scripts/shopping.mjs probe --binding mouse
```

示例 `123` 需替换为当前真实标签页 ID。绑定后页面被切换、商品 ID 改变、标签页关闭或连接端点变化时，程序停止，不自动找一个相似商品继续。

## JSON 与退出码

除帮助文本外，标准输出为单个 JSON 对象。服务原始错误、无关页面资料不直接转发。

```json
{
  "schema_version": 1,
  "command": "probe",
  "ok": false,
  "status": "failed",
  "error": {
    "code": "TARGET_CHANGED",
    "message": "The bound tab now points to another page.",
    "next_action": "Restore the intended page or explicitly create a new binding."
  }
}
```

| 退出码 | 含义 |
| --- | --- |
| 0 | 命令成功；任务创建不表示已执行，任务 complete 不表示完整商品能力已取得 |
| 2 | 输入、连接或目标问题；任务暂停、部分失败或停止也使用此码；awaiting_batch为正常等待续批，仍返回ok:false及此码，task-status 同样反映保存的状态 |
| 1 | 意外内部错误或运行文件无法加载 |

连接错误码详见 [setup.md](setup.md)。另外，`INVALID_ARGUMENTS`、`INVALID_TAB`、`UNSUPPORTED_TARGET` 在输入或目标不符合要求时返回；`INVALID_RESPONSE` 表示服务协议数据不符合约定；绑定文件问题使用 `BINDING_*` 或 `STATE_*` 错误。

## 结果的实际含义

- `login_verified: false`：本程序没有验证账号登录，连接通过也不会改成 true。
- `metadata.page_state: "not_assessed"`：没有判定验证码、完整商品内容或价格加载状态。
- `probe` 的 `automatic_retries: 0`：元信息探测没有自动重试。启动服务时对本地健康状态的有限轮询不访问电商页面。商品任务的重试由执行层统一计数。
- 保存的绑定只是公开目标定位；`tasks/` 下另存商品任务检查点，两者均不包含私人账号连续性证明。
- 商品的 `coverage.status: partial`、价格条件及缺失项必须随结果反馈，详见 [商品结果说明](products.md)。

参数、结果及页面标题均作为数据处理。需要实现后续功能时应新增受限的具体命令，不能把通用 `eval` 或远程请求作为公开接口。

`task-start --search <关键词> --tab <ID> --inspect-controls` 只读有限可见控件；`--inspect-price` 改为检查一次价格 tab 点击前后的可见状态。两者互斥，不能与 sort、pages 或商品模式组合。价格入口每次扫描前 25 张卡片、至多一次点击、累计 8 次观察；暂停前证据在 `partial_inspection`。`price_direction` 保持 null，完成不代表排序或打开菜单成功。操作与输出边界见[搜索与评价](search-and-reviews.md)。

`task-start --search <关键词> --tab <ID> --inspect-price-hover` 是互斥的单次指针悬停检查，限声明的扩展后端。会重新取得限定控件 ref，可能滚动到控件；不点击方向项。读取预留包含引用读取，原预算不变。结果增加 `before/after.directions` 及扫描截断标志，`price_direction` 仍为 null；回包不明后只读、不得补发。complete 不代表悬停成功，必须一起报告 `action_evidence.acknowledgement_error`，见[搜索与评价](search-and-reviews.md)。
