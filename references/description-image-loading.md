# 单张详情图的有限加载观察

`--description-image-load POSITION`是独立单商品入口，观察调用方指定的一个原始详情IMG位置，必要时预留一次正常滚动，并有限后读。普通`--details`仍只读；正文展开、规格图集合与图片文件预算分别保留。当前完整路径仅离线验收，未取得新的平台加载成功样本，不恢复已结束的小图或SKU研究。

```sh
node scripts/shopping.mjs task-start --task requested-description-image --bindings product --description-image-load 1 --state-dir <原状态目录>
node scripts/shopping.mjs task-run --task requested-description-image --state-dir <原状态目录>
node scripts/shopping.mjs task-status --task requested-description-image --state-dir <原状态目录> --json
```

使用原平台状态目录，并先查tabs核对商品。参数为1–60的一个原始IMG扫描位置，即`details.description.image_readiness.entries[].position`，不是去重后`items`数组下标，也不是规格位置或SKU ID。只能一个绑定，与详情、正文展开、服务、评价、指定规格、图集、主图及搜索模式互斥。该入口补查一个明确缺项，不自动遍历全部详情图。

## 来源与动作保护

同次读取既有商品详情与唯一`imageTextInfo`区域中指定IMG的归属和几何。只接受唯一`.descV8-container`内的图片；记录容器及图片扫描数量、原位置、视口和裁剪祖先的交集。隐藏、inert、aria-hidden、视频／公益祖先或无法达到BODY的节点不成为动作目标。多个容器、未扫描位置、无支持URL或无有效几何保持未验证；清单截断时不滚动，已有正常图片只按已扫描位置交付。

只有支持URL、异常小图或未加载、归属明确、清单未截断且未完全进入可见交集时，才考虑一次正常`scrollIntoView`。资源已正常、已经在视口内或来源不明时不额外滚动；不切规格／主图，不展开正文，不处理其他弹窗。

动作意图先落盘，再重新核对商品与页面拦截、容器／图片数量、原位置、URL及原加载／自然尺寸。来源变化或新遮挡停止；图片在保护时已正常或已进入视口则返回零滚动回执。保护返回的是动作前观察，不能被当作滚动后的图片。

已观察的同区域位置和数量不能证明物理DOM节点跨次不变，所以`physical_element_identity_verified`始终false。滚动后URL允许更新，但不能把位置稳定升级为平台SKU图片归属。

## 预算、暂停与恢复

每次请求最多六次内容观察（包含首次、动作保护、故障／中断预留）、一次滚动意图和三个后检查。派发前必须还剩保护及至少两次后读额度；每次后读按1500ms节奏进行。此预算只属于该单张详情图请求，不占规格图每项3次或其他详情能力的额度。

回包不明或进程退出后保留意图，后续只观察，不补发滚动；明确未派发也不退还预留。故障或中断打断连续确认。原平台暂停、最多两次操作重试、5／15秒等待及共享恢复预算不变；登录、验证及频控分别按原流程处理。

三次后检查仍未确认正常图片时，交付`image_unresolved`及最后有效观察，任务完成表示限定请求已交付，不表示缺图已解决。故障／结构错误仍按原机制暂停或停止。完成任务只回缓存；不能换任务名、商品或状态目录重复同一已结束请求取新额度。

## 数据交付

正式结果为原详情快照加`description_image_loading`子格式1；不同观察不混写原时间。

| 状态 | 本次含义 |
| --- | --- |
| `already_ready` | 首读取得归属及几何支持的正常尺寸图片；零滚动，未执行连续确认 |
| `target_unverified` | 没有本入口支持的动作目标或该资源已在视口；交付已有数据，零滚动，不推断商品无图 |
| `normal_image_confirmed` | 一次意图之后，同一支持位置／清单范围连续两次正常图片的URL和自然尺寸一致 |
| `image_unresolved` | 原后检查或内容上限到达，仍未完成连续正常图片确认；保留最后有效数据 |

记录`initial_image`／`final_image`、各自时间、最终`source_scope`、动作前`guard_scope`／`guard_observed_at`、意图数、`scrolled`（true／false／null）、保护原因、回包错误、内容／后检查数。`normal_image_stability_confirmed`只在两次正常观察一致时为true；它不证明是滚动导致加载，`scrolling_caused_loading_verified`始终false。全文、物理节点身份和SKU直接价格关联仍未验证。

暂停／失败的操作返回`unconfirmed_description_image_observations`对象，含`initial`／`guard`／`last`（各可为null），每份有效数据位于其`.snapshot`，确认标记为false；动作信息在`description_image_action`，错误看操作的`error`。不把故障前后文字／图片拼成连续确认。

本入口只观察图片链接和加载状态，不下载文件。正文、标题、参数、价格等只是同次详情附带数据，不因本入口升级完整性或实付。实页边界仍见[详情能力验收表](detail-capabilities.md)。
