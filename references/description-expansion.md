# 正文展开与有限后读

`--description-expand` 是独立的单商品任务，先读取已有详情和局部入口，再按明确的DOM归属决定是否展开。普通 `--details` 仍只读；旧任务与旧缓存不升级。每件最多一个展开意图、六次内容观察（含动作保护）、三个后检查，失败／中断也计数。原平台暂停、最多两次操作重试、5／15秒等待及共享恢复预算保持。

```sh
node scripts/shopping.mjs task-start --task book-description --bindings book --description-expand --state-dir <原状态目录>
node scripts/shopping.mjs task-run --task book-description --state-dir <原状态目录>
```

只接受一个绑定，与详情、服务、评价、图集、规格图片、指定规格及搜索模式互斥。先查tabs并确认商品；不换浏览器、活动标签、商品或状态目录来获取额度。

## 支持的入口与范围

只检查唯一 `imageTextInfo` 详情区域内最多八个可见语义控件。记录 `controls_seen`／`controls_scanned`／`controls_truncated`、支持正文容器数量、匹配展开语义的数量及已核对关系的入口。截断、多个候选或没有关系时不选择第一个。

支持两种明确关系：

- `aria_controls`：BUTTON或role=button的DIV，其唯一 `aria-controls` ID精确指向同区域内唯一 `.descV8-container`，全页没有重复ID，且 `aria-expanded` 明确为true或false。当前只支持1–128字符的ASCII字母开头、后续字母／数字／下划线／连字符ID。
- `native_details`：原生SUMMARY与正文容器属于同一个DETAILS，且只有一个直接SUMMARY子节点；实际 `open` 状态决定是否已展开。读取关系时不读取折叠正文的隐藏文字。

入口标签限于已支持的“展开详情／正文／全文／全部／更多”“查看详情／正文”等明确文字。标签匹配只提供候选；缺少上述关系仍为未验证。链接、表单、视频／公益模块及显式hidden／inert／aria-hidden祖先排除。“收起”标签和false展开标记相冲突时也不展开。不读取事件处理器、应用状态或内部接口。

动作前再次核对商品、拦截状态、原控件位置、类型、目标和清单范围。用户已展开时返回 `clicked: false`，不会关闭。目标必须启用、在视口内、祖先允许交互，且中心命中本控件或其后代；否则保留意图和失败并停止。此任务不滚动，不处理其他弹窗，也不为验证制造折叠状态。

## 后读与交付

动作保护计入六次读取；只有还剩保护及两次后读额度时才派发。展开意图和读取次数先保存，未知回包只允许后读，不再次点击；明确未派发也不退还额度。动作后按1500ms节奏观察。

只有同一局部控件／容器关系显示已展开、正文非空、遍历／文字／控件未截断且没有裁剪省略，并且连续两次正文完全一致，才确认展开状态及稳定文字。故障或进程中断会打断连续确认，保留最后已校验的文字和时间；不能将故障前的观察与恢复后的观察拼成确认。用户原本已展开的页面同样两次确认，但零展开动作。

结果包含完整详情快照及 `description_expansion` 子格式1：

| `status` | 含义 |
| --- | --- |
| `entry_not_observed` | 本次有限支持区域未观察到匹配语义入口；交付已有正文，不能推断全页无折叠 |
| `entry_unverified` | 有候选但关系、数量、禁用或扫描范围不足；零点击，交付已有详情 |
| `already_expanded` | 初读已展开，连续文字确认后返回；无本方展开意图 |
| `expansion_observed` | 已保存一次展开意图后，取得同关系的展开状态和两次一致正文；实际点击看独立回执 |

保存初始观察时间、前后字符数及 `text_changed`、最终入口证据、`actions_reserved`、`clicked`（true／false／null）、内容观察／后检查计数和 `acknowledgement_error`。点击回执只说明派发，不等于正文确认；回包丢失仍保留null。`same_entry_expanded_verified`及 `text_stability_confirmed`只在两次确认后为true；`full_description_verified`始终false。已有详情的 `description.observation.expansion_behavior_verified`也保持false，其含义是原单次文字观察没有验证展开行为；新流程证据另列，不回写旧观察。

暂停／失败时 `operations[].unconfirmed_description_observations`交付初始和最后已校验的观察，并显式保持关联／稳定确认false。`task-status`和完成后的 `task-run`只回缓存，不访问浏览器。新任务种类 `product_description_expansion`不会取得新的图片下载额度，图片文件仍按已支持的原来源与收据导出。

工程测试不能替代平台展开实测。实际正文、入口及预算结果见本轮验收。
