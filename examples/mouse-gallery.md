# 鼠标顶部静态图集实页交付

商品：537601894090，来源为[原天猫商品页](https://detail.tmall.com/item.htm?id=537601894090)。观察时间：2026-09-28 17:59:51.434（Asia/Singapore），即 `2026-09-28T09:59:51.434Z`。

[机器可读原始快照](data/mouse-gallery.json)逐字段等于本次生产 `BrowserBridge.readGallery` 返回的规范化结果。来源是 `main-images-mouse-add2-20260925` 原诊断收据的 `gallery_read_followup`，不是新建正式图集任务；不使用这个名字调用文件导出。原主图任务仍停止，当前交付不补写旧结果。

本次在支持的顶部图片区观察6个图片元素，扫描6个、重复URL省略1个，返回5个；未扫描0个、不支持URL省略0个。保留原位置，第二个元素因去重省略，不重新编号。

| 原position | 实际URL | 自然尺寸 | 加载状态 |
| --- | --- | --- | --- |
| 1 | [图片元素链接](https://gw.alicdn.com/imgextra/O1CN01mWwq84dzMNK1chua_!!428722076-0-picasso.jpg_q50.jpg_.webp) | 800×800 | 已加载 |
| 3 | [图片元素链接](https://gw.alicdn.com/imgextra/O1CN01Gs7V7k1RCqkkg6uaz_!!428722076.jpg_q50.jpg_.webp) | 800×800 | 已加载 |
| 4 | [图片元素链接](https://gw.alicdn.com/imgextra/O1CN01YBsKsw1RCrB0QY9O2_!!428722076.jpg_q50.jpg_.webp) | 800×800 | 已加载 |
| 5 | [图片元素链接](https://gw.alicdn.com/imgextra/O1CN01SOdfZJ1RCrAvWyFt7_!!428722076.jpg_q50.jpg_.webp) | 800×800 | 已加载 |
| 6 | [图片元素链接](https://gw.alicdn.com/imgextra/O1CN01XwR2FQ1RCrChsLaJI_!!428722076.jpg_q50.jpg_.webp) | 750×750 | 已加载 |

这些是缩略图元素的实际currentSrc／src，未改写后缀取得所谓原图。链接、顺序、尺寸、加载及覆盖计数与2026-09-22历史图集一致，但本次观察时间独立保留；只能说明两个观察时点一致，不保证长期稳定。

这次只取得元素数据，没有下载或识图，没有观察当前大图或点击选中状态，不把五张链接称为五张已确认大图。最高原始分辨率、完整图集和SKU图片归属均未验证，`sku_id:null`。本次也没有标题、规格或价格读取，不能建立价格归属。

原批次累计4/8读取、恢复3/3（原2次加用户明确追加1次）、等待35000ms；本次一次性授权已完成，不继续填满剩余读取数。已有六张图片缓存及下载预算保持，未新增下载。实际验证与边界。
