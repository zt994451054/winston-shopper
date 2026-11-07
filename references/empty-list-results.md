# 明确空列表结果合同

更新：2026-10-10。购物车与订单列表的明确空结果、保存校验、任务完成／缓存、有限恢复和报告展示已通过离线测试；**实际淘宝空页面的DOM识别尚未接入，也未实页验收**。现有生产DOM读取器遇到0行／0组仍返回 `structure_changed`，不能据此报告空购物车或没有订单。

本合同供之后依据自然页面证据审查的读取适配器使用。结构校验只验证上游提交的限定证据，不判断任意文字是否语义上表示空状态。本轮没有猜测淘宝空提示文案、CSS类或选择器，没有扫描整页寻找“没有商品／订单”，也没有改变账户状态制造空页面。

## 接受条件与范围

原标签与HTTPS路由保护先执行。适配器必须在当前列表的唯一根区域观察到唯一、可见、完整的明确空提示，同时确认页面已就绪、没有登录／验证／频控门控、没有商品行／订单组。隐藏节点、区域外提示、截断消息、多个候选、加载中的零行、提取失败以及“零行＋没有证据”都不能作为空结果。

原始响应的新判别值为 `state:'observed_empty'`；`url`、`observed_at`、`source`沿原合同保留。购物车仅接受 `trade_cart_item_info_dom`，订单仅接受 `trade_bought_list_order_dom`。`loaded_rows_seen/loaded_orders_seen`为0，`rows/orders`为空数组，另含以下精确字段：

```json
{
  "empty_evidence": {
    "scope": "current_list_view",
    "basis": "explicit_empty_notice",
    "message": { "text": "由适配器保存的原提示文字", "truncated": false },
    "list_root_count": 1,
    "notice_count": 1,
    "notice_visible": true,
    "notice_within_list": true,
    "document_ready": true,
    "gates_clear": true
  }
}
```

上例仅说明字段，不是淘宝真实提示。消息须是1–500字符的非空原文，首尾无空白且不含Unicode控制字符，不自动清洗或补全文字。缺失／多余字段、矛盾计数和有项目却声称空均返回 `INVALID_RESPONSE`。读取器仍需依据具体布局保证这些断言，不能仅按提取数量填写它们。

## 保存与兼容

仅明确空 snapshot、batch和集合交付使用 `schema_version:3`，保存 `empty_evidence`。旧非空snapshot格式1、batch格式2和集合格式1保持原样，不升级或回填旧检查点。保存校验重建原始证据和全部派生字段，严格深比较；伪造全车、总量、账户身份或空标记均返回 `INVALID_CHECKPOINT`。

| 字段 | 购物车 | 订单列表 |
| --- | --- | --- |
| 项目 | `rows:[]` | `orders:[]` |
| loaded／returned／omitted | 全部0 | 全部0 |
| 当前视图空证据 | `empty_cart_verified:true` | `empty_orders_verified:true` |
| 覆盖 | `status:'partial'` | `status:'partial'` |
| 页面／账户总量 | `page_total_rows:null` | `page_total_orders:null` |
| 全量声明 | `full_cart:false` | `full_order_history:false` |
| 账户与结算 | 原未验证标记保持false | 原未验证标记保持false |

`empty_*_verified`只描述原采集时间的当前列表区域；不证明账户身份、全部购物车、所有筛选或全历史。结果不能外推其他时间的页面。

## 正式任务、续批与恢复

无需新CLI模式；未来适配器识别空状态后，既有 `--cart`／`--orders` 单次和分批任务沿原预留、保存和缓存机制接收结果。当前DOM适配器还不会发出此新形态，不能把离线模拟CLI成功当作真实空页面成功。

首次分批仅接受位置1、原加载数null、空前缀和与预留一致的start／limit／prefix。首空批自然完成当时已加载范围：`requested_loaded_range_read:true`、`requested_limit_reached:false`，不再请求后批。此前已保存非空批次后观察到明确空状态，则返回 `CART_ROWS_CHANGED`／`ORDER_ROWS_CHANGED`，保留原批次与预算并停止。

读取仍先预留、失败次数不退还，原2次共享显式恢复、每次5000ms、原自动重试及等待总上限不变。登录／连接暂停后，只能沿同任务、原标签和原预算恢复；本轮离线验证了恢复后得到空结果，未触发真实现场恢复。完成／停止后再次run或status只回缓存。

统一订单工作流若列表明确为空，会保存完成的列表子任务及原空证据，在选定位置不存在时 `stopped/ORDER_DETAIL_SOURCE_UNVERIFIED`，不创建入口／正文子任务、不点击、不换订单。统一摘要保留 `order:null`、原时间、空证据和覆盖；整轮并不声明完成。

## 报告与后续验收

Markdown／CSV增加 `empty_notice`记录，保留原提示、来源／时间、`current_list_view`范围与 `explicit_empty_notice`依据，附当前视图范围说明。它与尚无缓存的操作分别呈现；原JSON保留完整结构证据。

下一步需要正常授权且允许访问的自然空购物车／空订单来源，核对唯一列表区域、明确提示的实际结构和门控优先级，再实现严格DOM分支并限定实页验收。不改车、不删订单、不换接口读取已被拒绝的订单页面。本轮实现、测试及旧状态保全见离线记录。
