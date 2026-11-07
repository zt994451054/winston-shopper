# 搜索1–5页续读

新任务使用 `--pages N`（整数1–5），创建 `search_collection`；不指定 `--pages` 仍是原首屏 `search`。只能从已打开的同关键词第1页开始，使用页面显示“综合”选中的未筛选布局。新模式不从首页提交搜索、不跳页、不滚动，也不与销量／价格／控件模式组合。

```sh
node scripts/shopping.mjs task-start --task mouse-first-three --search '罗技 M330' --tab <标签页ID> --pages 3
node scripts/shopping.mjs task-run --task mouse-first-three
node scripts/shopping.mjs task-status --task mouse-first-three
```

## 保存与确认

每页最多读取50张已加载卡片；2026-10-14 之前开始的任务仍按前25张核对和继续，`limits.cards_per_page` 写明本任务的范围。保存第1页后，每个相邻页最多预留一次“下一页”意图；意图先落盘，再在页面内重核关键词、原页码、卡片位置／链接／数量和分页状态后点击。未知回执、进程中断或已确认未派发都保留这次预留，接续仅观察，不补点。唯一例外是本地节奏额度用完（`PACING_LIMIT`）：这时请求在发往页面之前就被拦下，程序撤销这次意图，任务以 `pending` 返回 `pacing_hold.allowed_after`，到时间后再运行同一任务会重新预留并点击一次（2026-10-13 起）。

确认下一页要求地址和可见页码匹配、相对前一页样本至少新增一个商品ID，以及两次连续观察的商品ID顺序与展示总页数一致。门禁或连接失败会清除未完成的连续确认候选，已确认页保持原字节数据和采集时间。展示总页数变化、卡片完全重叠、控件冲突或未知布局会停止，保留已有页。

达到请求页数时完成。也可提前遇到自然末页：必须当前页码等于展示总页数，且下一页禁用；两种分页区须一致。下一页禁用但页码未到展示末页属于结构异常，不能提前成功。没有可解析卡片仍是结构错误，不据此声称搜索为空。

## 整个任务共用预算

| 预算 | 上限与计数方式 |
| --- | --- |
| 页数与卡片 | 请求1–5页，每页最多扫描50张卡片（旧任务25张）；成功确认观察会重复采样，但结果每页只交付一次 |
| 下一页意图 | 最多 `N-1`，每个相邻转换最多1次；预留不退款 |
| 内容观察 | `1 + 4×(N-1) + 4`；普通读取和动作自身的卡片保护均计入，IO前保存 |
| 相邻转换检查 | 最多3次成功响应检查；过渡标记、旧页或无新增商品也计数 |
| 执行入口 | 最多6次，独立于内容观察；连接检查失败、恢复与进程中断不退还 |
| 显式恢复 | 登录／验证、连接与冷却共用2次，每次预留5000ms，跨页累计 |
| 自动故障重试 | 单项2次，平台5次；5000／15000ms，平台故障等待总计120000ms |
| 冷却探测 | 整个任务1次；仍受显式恢复额度约束，须有用户恢复请求 |

正常内容观察和动作之间至少1500ms；这些节奏间隔独立于故障等待预算。完成任务只返回本地缓存。最后页已落盘而外层结果尚未发布时，可纯本地收敛结果，零新增读取／动作／执行次数。

`waiting_connection` 时，先用 `task-diagnose`。没有翻页意图只允许当前确认页；有尚未确认的相邻意图只允许原当前页及它的下一页。`task-rebind --tab ID` 使用同一规则，拒绝更早页、未预留的未来页、其他关键词、排序或筛选参数；不重置任何预算。新模式没有清单外原ID后备读取，也不发现其他窗口。

```sh
node scripts/shopping.mjs task-diagnose --task mouse-first-three
node scripts/shopping.mjs task-rebind --task mouse-first-three --tab <符合原意图的标签页ID>
node scripts/shopping.mjs task-resume --task mouse-first-three --after-connection
```

恢复仅适用于原暂停状态；`stopped`不能重跑，不能改名或换目录续额度。门禁仍需用户完成登录／验证并报告，网站／工具访问拒绝不能换接口读取。

淘宝未登录时，搜索页保留搜索框和排序栏，但不渲染任何商品卡片，结果区只显示加载失败提示，标题也可能为空。所有搜索模式共用的采集器在“零商品卡片＋顶部导航指向 `login.taobao.com/member/login.jhtml` 的‘请登录’链接”同时成立时返回 `login_required`，任务进入 `waiting_user`。用户登录后，执行一次 `task-resume --after-user`。只有其中一个条件成立时仍按结构错误停止。该判断已在 2026-10-12 的真实未登录页面上核对。

## 输出

`operations[0].result.pages`逐页保存 `{search,pagination}`，含各页原 `observed_at`、来源、局部覆盖和省略数。`records`是各页已返回记录合计；`distinct_products`按跨页商品ID去重，两者不能互换。各页展示价仍不等于确定实付。

`end_reason`为 `requested_pages` 或 `visible_last_page`；同时分别输出 `requested_bound_reached` 与 `visible_last_page_verified`。`coverage.status`始终为 `partial`，`sort_verified`、`filters_verified`、`total_results_known`为false；展示末页不保证平台全量商品已经取得。

暂停／停止时 `partial_pages`只交付已确认页；未确认候选不冒充成功。`search_budget.reads_reserved`表示执行入口次数，`dom_observations_reserved`表示含动作保护的内容观察，`actions_reserved`表示可能已执行的意图数，并不保证点击成功。

旧 `search_pages`任务、两页解析器、缓存格式和原预算保持，不升级、不重放。2026-09-22两页21／13记录、去重23商品属于旧模式实证，不能替代新1–5页流程实页验收。新模式当前已完成离线实现与本地模拟，正常打开搜索页被工具策略拒绝，真实第3页尚未验收；证据见开发记录。
