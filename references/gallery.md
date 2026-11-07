# 顶部静态商品图集只读

只需要商品顶部图集时，优先返回已有结果中的图片元素数据。需要新的、已授权且原平台状态允许的读取时，使用 `--gallery`：只读唯一商品图片区的 `IMG.thumbnailPic`，不依赖标题、价格、详情正文或当前大图。当前大图显示视频，不阻止其他缩略图元素的数据交付。

## 使用与范围

```sh
node scripts/shopping.mjs task-start --task <请求任务名> --bindings <一个商品绑定> --gallery --state-dir <原状态目录>
node scripts/shopping.mjs task-run --task <原任务名> --state-dir <原状态目录>
node scripts/shopping.mjs task-status --task <原任务名> --state-dir <原状态目录>
```

每批一个已绑定商品，与 `--details`、`--main-images`、规格、服务、搜索及评价模式互斥。执行前按正常流程核对连接和tabs；开发使用 `.runtime/verification-bindings`。原平台任务停止时不能新建本模式来继续失败批次或刷新额度。

新任务类型为 `product_gallery`，每次尝试只派发一次受保护的图集DOM采集；目标地址检查另保留。每次读取前持久化尝试数，复用[原任务暂停与限次重试](tasks.md)，没有新的重试预算。完成任务回读缓存，不刷新时间。结构不支持／歧义停止，明确登录、验证码和频控仍暂停。

最多读取20个符合范围的图片元素的URL、自然尺寸与加载状态，保留扫描及省略数量。仅使用元素实际 `currentSrc` 或 `src`，不改写后缀、抓取私有状态或请求接口。隐藏祖先下的图片及已识别视频区域排除；不读视频地址或封面。不切图、滚动、触发加载、关闭营销弹窗或评价，不调用点击位置检查。未知弹层本身不阻止图集DOM读取。

URL可取得但尚未加载的图片仍可返回，`loaded:false` 和尺寸照实保留。未加载不自动归因为懒加载或失败；自然尺寸也不证明最高原始分辨率。`--details` 复用同一图集提取器，其其他区域和页面保护保持原规则，旧快照不补写。

## 结果

结果位于 `operations[0].result`，格式版本1，来源 `loaded_gallery_thumbnail_dom`。

| 字段 | 含义 |
| --- | --- |
| `product_id`、`url`、`observed_at` | 已核对商品身份与原观察时间 |
| `gallery.items` | 实际URL、原position、自然宽高、loaded及gallery_thumbnail来源 |
| `gallery.elements_seen`／`elements_scanned` | 范围内元素数与实际处理行数，去重及不支持URL省略另计 |
| `availability` | 返回、已加载、未加载及未扫描数量；有链接与未见支持链接分别表达 |
| `coverage.current_main_image_read` | 固定false；未观察当前大图，不能把它写成静态、视频或为空 |
| `coverage` | 固定局部覆盖；全图集、选中图片关系、原始分辨率、已下载、已识图及视频读取均不保证 |
| `association` | SKU ID固定null，SKU图片归属未验证 |
| `missing` | 已观察图集内未返回支持链接时包含gallery_image_links，不等于商品无图片 |

找不到支持的商品图片区时返回 `UNSUPPORTED_CAPABILITY`；多个候选返回 `PAGE_STRUCTURE_CHANGED`。找到唯一图片区但没有支持的链接，可以交付明确的空观察。它与当前主图采样的 `image:null` 是不同范围，不互相推导。

## 文件及来源

图集结果只给链接，kill 不再下载图片（用户决定）：只交付图片链接，调用方需要文件或看图时自己按链接取得。


## 验证边界

2026-09-28新增20项回归，Node.js22.16.0／24.13.0各464项完整测试通过。覆盖视频首屏、遮罩下只读、隐藏及视频图片排除、20行上限、未加载、空集合、明确访问限制、CLI／桥接、暂停、限次重试、停止任务、缓存、文件导出及原收据恢复。

上述实现轮仅离线验收，1290个历史文件不变，见实现与验证。

同日用户明确授权原批次追加一次只读检查后，生产 `BrowserBridge.readGallery` 在原鼠标页一次返回5个已加载链接：6元素去重1，原position为1／3／4／5／6，四个800×800、一个750×750。实际URL、顺序和加载字段与历史图集一致，观察时间另存；没有点击、滚动、处理弹窗、读取当前大图或下载。生产读取器已有这一个实页正例，CLI完整任务链和新图集来源文件导出仍为离线验收，不保证其他布局或长期稳定性。

[公开快照](../examples/data/mouse-gallery.json)来自原诊断收据的追加观察，不是新建的product_gallery任务结果，不可直接作为image-export任务使用。原追加两张主图任务仍stopped，累计4/8读取、恢复3/3（原2次加用户明确追加1次）、等待35000ms；本次授权已用完，不能重放或换任务续预算。旧两段恢复、检查点和图片收据完整保留。见实页记录及[交付示例](../examples/mouse-gallery.md)。
