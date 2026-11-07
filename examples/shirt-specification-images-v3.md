# 回力短袖：规格图片正式流程验收

后续下载抽查已完成：第1／26／36项均首次下载为800×800 WebP，缓存回读成功。仅这3张验证下载，其他36项未测；[下载证据JSON](data/shirt-specification-download-check.json)与抽查记录单列，下面原页面读取结果不回填。

[商品页](https://detail.tmall.com/item.htm?id=898515922780)。本页商品ID为898515922780，不是SKU ID。

2026-09-29T15:07:49.794Z至15:08:27.773Z，正式任务specification-loading-shirt-20260929完成新格式3采集：先保存39个颜色＋8个尺码名称，再取得39个颜色各自的800×800已加载图片链接；本次支持范围内图片缺项为0。8个尺码未见支持图片容器，只保留文字，不据此断言其他位置不存在图片。

[完整结构化JSON](data/shirt-specification-collection-v3.json)逐字段等于正式任务结果，保留所有首次小图、加载保护、后读时间与关联。与[旧47项结果](data/shirt-specification-collection.json)分别保留，不回填旧时间或旧缺项。

实际读取25次：名称1、图片首读8、加载保护14、滚动后读2。14次加载意图中只有2次实际滚动（颜色26／36），12次保护发现来源已更新为正常图片，跳过滚动。每项实际读取：25项1次、12项2次、2项3次；总保护120未用满即完成，零故障重试／故障等待。

本次是元素链接与选项的DOM关联验收，没有下载或识图，不切规格。sku_id:null、SKU／价格绑定false；不把颜色列表与尺码列表的笛卡尔积当作平台SKU矩阵，不推断优惠价或实付。各项观察时间不同，cross_read_image_state_verified:false。

## 颜色与图片

| 原位置 | 名称 | 已观察图片链接 | 本项读取次数 |
| --- | --- | --- | --- |
| 1 | 【220克重磅纯棉】白 [透气且有型] | [800×800](https://gw.alicdn.com/bao/uploaded/i2/2216780549508/O1CN014u3DZwDrYuJ1chua_!!2216780549508.png_.webp) | 1 |
| 2 | 【220克重磅纯棉】黑色 [透气且有型] | [800×800](https://gw.alicdn.com/bao/uploaded/i4/2216780549508/O1CN01EuPCHT2K6ipmpjIcd_!!2216780549508.png_.webp) | 1 |
| 3 | 【凉感科技-UPF50+防晒】白色 [40°都清爽] | [800×800](https://gw.alicdn.com/bao/uploaded/i3/2216780549508/O1CN01PrIUDW2K6iq9GkzV0_!!2216780549508.jpg_.webp) | 1 |
| 4 | 【纯棉两件更划算】白色+白色 [透气且有型] | [800×800](https://gw.alicdn.com/bao/uploaded/i3/2216780549508/O1CN01abLfEx2K6ipq5KYnd_!!2216780549508.png_.webp) | 1 |
| 5 | 【防晒两件更划算】白色+白色 [40°都清爽] | [800×800](https://gw.alicdn.com/bao/uploaded/i3/2216780549508/O1CN01sn8ZZ32K6iqDYxdyG_!!2216780549508.jpg_.webp) | 1 |
| 6 | 【纯棉两件更划算】白色+黑色 [透气且有型] | [800×800](https://gw.alicdn.com/bao/uploaded/i2/2216780549508/O1CN01F63wWr2K6ipnvMGNW_!!2216780549508.png_.webp) | 1 |
| 7 | 【纯棉两件更划算】白色+浅米 [透气且有型] | [800×800](https://gw.alicdn.com/bao/uploaded/i4/2216780549508/O1CN01BRrAOs2K6ipmphDmH_!!2216780549508.png_.webp) | 1 |
| 8 | 【纯棉两件更划算】白色+冰川蓝 [透气且有型] | [800×800](https://gw.alicdn.com/bao/uploaded/i4/2216780549508/O1CN01PRrIiz2K6ipolv1SX_!!2216780549508.png_.webp) | 1 |
| 9 | 【220克重磅纯棉】浅米 [透气且有型] | [800×800](https://gw.alicdn.com/bao/uploaded/i3/2216780549508/O1CN01QDHMtR2K6ippXwSrK_!!2216780549508.png_.webp) | 1 |
| 10 | 【220克重磅纯棉】冰川蓝 [透气且有型] | [800×800](https://gw.alicdn.com/bao/uploaded/i3/2216780549508/O1CN011zLhTq2K6ipnvNbaY_!!2216780549508.png_.webp) | 1 |
| 11 | 【220克重磅纯棉】棕榈绿 [透气且有型] | [800×800](https://gw.alicdn.com/bao/uploaded/i3/2216780549508/O1CN01SA01jN2K6ipoieABO_!!2216780549508.png_.webp) | 1 |
| 12 | 【220克重磅纯棉】麻灰 [透气且有型] | [800×800](https://gw.alicdn.com/bao/uploaded/i2/2216780549508/O1CN01q73YSp2K6ippaugUG_!!2216780549508.png_.webp) | 1 |
| 13 | 【220克重磅纯棉】深灰 [透气且有型] | [800×800](https://gw.alicdn.com/bao/uploaded/i3/2216780549508/O1CN01YSjnRy2K6ipqUmpTo_!!2216780549508.png_.webp) | 1 |
| 14 | 【220克重磅纯棉】沙色 [透气且有型] | [800×800](https://gw.alicdn.com/bao/uploaded/i1/2216780549508/O1CN01fj8GJq2K6ivDSGGSr_!!2216780549508.jpg_.webp) | 1 |
| 15 | 【220克重磅纯棉】酒红 [透气且有型] | [800×800](https://gw.alicdn.com/bao/uploaded/i1/2216780549508/O1CN01OPvhCS2K6ipmCLPtn_!!2216780549508.png_.webp) | 1 |
| 16 | 【220克重磅纯棉】藏青 [透气且有型] | [800×800](https://gw.alicdn.com/bao/uploaded/i3/2216780549508/O1CN019btpCV2K6iphvljXR_!!2216780549508.png_.webp) | 1 |
| 17 | 【220克重磅纯棉】晨绿 [透气且有型] | [800×800](https://gw.alicdn.com/bao/uploaded/i4/2216780549508/O1CN01z15MHH2K6ivlYflJJ_!!2216780549508.jpg_.webp) | 1 |
| 18 | 【220克重磅纯棉】卡其 [透气且有型] | [800×800](https://gw.alicdn.com/bao/uploaded/i1/2216780549508/O1CN01zls9632K6ipoxW3nz_!!2216780549508.png_.webp) | 1 |
| 19 | 【凉感科技-UPF50+防晒】黑色 [40°都清爽] | [800×800](https://gw.alicdn.com/bao/uploaded/i2/2216780549508/O1CN01s5S7Cd2K6iqFMn5zG_!!2216780549508.jpg_.webp) | 1 |
| 20 | 【凉感科技-UPF50+防晒】卡其 [40°都清爽] | [800×800](https://gw.alicdn.com/bao/uploaded/i3/2216780549508/O1CN01JqME2i2K6iqGHgUdh_!!2216780549508.jpg_.webp) | 1 |
| 21 | 【凉感科技-UPF50+防晒】浅灰 [40°都清爽] | [800×800](https://gw.alicdn.com/bao/uploaded/i3/2216780549508/O1CN013inOuS2K6iqGgazn5_!!2216780549508.jpg_.webp) | 1 |
| 22 | 【凉感科技-UPF50+防晒】水绿 [40°都清爽] | [800×800](https://gw.alicdn.com/bao/uploaded/i3/2216780549508/O1CN01GeNgh82K6iqFLMUW1_!!2216780549508.jpg_.webp) | 1 |
| 23 | 【凉感科技-UPF50+防晒】深灰 [40°都清爽] | [800×800](https://gw.alicdn.com/bao/uploaded/i3/2216780549508/O1CN01y1cogw2K6iqEErYBO_!!2216780549508.jpg_.webp) | 1 |
| 24 | 【凉感科技-UPF50+防晒】冰川蓝 [40°都清爽] | [800×800](https://gw.alicdn.com/bao/uploaded/i1/2216780549508/O1CN01autzcB2K6iqDe80Yu_!!2216780549508.jpg_.webp) | 1 |
| 25 | 【纯棉两件更划算】白色+浅紫 [透气且有型] | [800×800](https://gw.alicdn.com/bao/uploaded/i1/2216780549508/O1CN01kakTyB2K6ivQuQthx_!!2216780549508.jpg_.webp) | 1 |
| 26 | 【纯棉两件更划算】白色+卡其 [透气且有型] | [800×800](https://gw.alicdn.com/bao/uploaded/i1/2216780549508/O1CN01Dl26Sd2K6ipp91ctJ_!!2216780549508.png_.webp) | 3 |
| 27 | 【纯棉两件更划算】白色+棕榈绿 [透气且有型] | [800×800](https://gw.alicdn.com/bao/uploaded/i4/2216780549508/O1CN0188tP6I2K6ipolugeq_!!2216780549508.png_.webp) | 2 |
| 28 | 【纯棉两件更划算】白色+晨绿 [透气且有型] | [800×800](https://gw.alicdn.com/bao/uploaded/i3/2216780549508/O1CN01V6GA4u2K6ivkvIzwF_!!2216780549508.jpg_.webp) | 2 |
| 29 | 【纯棉两件更划算】白色+深灰 [透气且有型] | [800×800](https://gw.alicdn.com/bao/uploaded/i1/2216780549508/O1CN01kigtjN2K6iphvjWJE_!!2216780549508.png_.webp) | 2 |
| 30 | 【纯棉两件更划算】白色+藏青 [透气且有型] | [800×800](https://gw.alicdn.com/bao/uploaded/i4/2216780549508/O1CN01Qv6rcX2K6ipoxWGK4_!!2216780549508.png_.webp) | 2 |
| 31 | 【纯棉两件更划算】白色+麻灰 [透气且有型] | [800×800](https://gw.alicdn.com/bao/uploaded/i2/2216780549508/O1CN012nuc4Y2K6ipolw1o3_!!2216780549508.png_.webp) | 2 |
| 32 | 【防晒两件更划算】白色+黑色 [40°都清爽] | [800×800](https://gw.alicdn.com/bao/uploaded/i3/2216780549508/O1CN01pCZ74u2K6iqHWypl9_!!2216780549508.jpg_.webp) | 2 |
| 33 | 【防晒两件更划算】白色+卡其 [40°都清爽] | [800×800](https://gw.alicdn.com/bao/uploaded/i3/2216780549508/O1CN01kZNPdv2K6iqGdrkTh_!!2216780549508.jpg_.webp) | 2 |
| 34 | 【防晒两件更划算】白色+浅灰 [40°都清爽] | [800×800](https://gw.alicdn.com/bao/uploaded/i3/2216780549508/O1CN01GNFgt42K6iqG5I0gK_!!2216780549508.jpg_.webp) | 2 |
| 35 | 【防晒两件更划算】白色+深灰 [40°都清爽] | [800×800](https://gw.alicdn.com/bao/uploaded/i2/2216780549508/O1CN01OdBLif2K6iqDYwyOs_!!2216780549508.jpg_.webp) | 2 |
| 36 | 【防晒两件更划算】白色+水绿 [40°都清爽] | [800×800](https://gw.alicdn.com/bao/uploaded/i3/2216780549508/O1CN01j8D6sr2K6iq9GnTVi_!!2216780549508.jpg_.webp) | 3 |
| 37 | 【防晒两件更划算】白色+冰川蓝 [40°都清爽] | [800×800](https://gw.alicdn.com/bao/uploaded/i2/2216780549508/O1CN01NPw8Wu2K6iqFxR4ga_!!2216780549508.jpg_.webp) | 2 |
| 38 | 【更多人选择两件装】自由搭配联系客服 | [800×800](https://gw.alicdn.com/bao/uploaded/i2/2216780549508/O1CN01GJ4XZs2K6iqGgNZO3_!!2216780549508.jpg_.webp) | 2 |
| 39 | 【UPF50+防晒背心】白色 [40°都清爽] | [800×800](https://gw.alicdn.com/bao/uploaded/i4/2216780549508/O1CN0183xHj42K6iwCrxoyn_!!2216780549508.jpg_.webp) | 2 |

## 尺码

| 原位置 | 名称 | 图片来源 |
| --- | --- | --- |
| 1 | 165/S (收藏加购 优先发货) | 未见支持图片容器；文字保留 |
| 2 | 170/M (权威检测 4级抗起球) | 未见支持图片容器；文字保留 |
| 3 | 175/L (亲肤面料 舒适透气) | 未见支持图片容器；文字保留 |
| 4 | 180/XL (4-5级固色 可机洗) | 未见支持图片容器；文字保留 |
| 5 | 185/2XL (回力正品保障) | 未见支持图片容器；文字保留 |
| 6 | 3XL (推荐体重180-205斤) | 未见支持图片容器；文字保留 |
| 7 | 4XL (推荐体重205-230斤) | 未见支持图片容器；文字保留 |
| 8 | 5XL (推荐体重230-260斤) | 未见支持图片容器；文字保留 |

本次只验证同一商品与当前页面布局，不能据此认定所有商品的懒加载都能补齐；此前鼠标仍有14项实际图片未取得。完成后task-run只回缓存，不为填满剩余额度重读。见验收证据与限制。
