# 操作节奏与次数上限

2026-10-12 起，所有通过 CLI 执行的页面操作都受同一套节奏控制。起因是当天短时间内打开了约 10 个搜索页，又做了多次排序和筛选，之后出现疑似短时限流：已登录的搜索页只显示“网络信号走丢”，刷新后恢复。这套规则经用户确认，目标是降低风控风险；但它不能保证不触发风控，因为平台的真实阈值未知。

## 规则

| 项目 | 规则 |
| --- | --- |
| 读取页面前 | 距上一次页面操作随机等待 2～4 秒 |
| 普通动作前（鼠标移动、填写、展开、滚动、选择） | 随机等待 3～6 秒 |
| 加载类操作之后的下一步 | 随机等待 6～12 秒 |
| 搜索类加载：打开搜索页、跳到搜索页、翻页、销量切换、价格方向、区间确认 | 每 10 分钟最多 5 次，每小时最多 15 次 |
| 页面类加载：打开商品页、打开订单详情、订单列表“下一页” | 每 10 分钟最多 10 次，每小时最多 40 次 |

- **两次新搜索之间**（用户 2026-11-08）：不分淘宝、京东、拼多多，两次 `page-open --search` 之间随机隔 2～4 分钟，记在状态目录的 `search-gap.json`。剩下不到 90 秒就地等待；更久返回 `PACING_LIMIT`，`next_action` 写明可以继续的时间，什么也不发送。同一任务里的排序、价格区间、翻页仍按上表的随机间隔，不受这条影响。起因：11-07 一个外部 AI 在 27 分钟里开了 11 次搜索页，两次之间常常只隔 1～4 分钟，之后京东限流。
- **限流后锁平台**（用户 2026-11-08）：某个平台出现限流页、验证码或登录页（`RATE_LIMITED`、`VERIFICATION_REQUIRED`、`LOGIN_REQUIRED`，或 `page-open` 的 `landing` 为 `risk_page`、`login_page`）后，这个平台 15 分钟内不再打开页面、不再开始任务，返回 `PLATFORM_LOCKED`，记在 `platform-locks.json`。其他平台不受影响。用户说处理好了，用 `platform-unlock --platform 平台` 提前解锁；用户要求的 `task-resume` 不受锁限制，恢复后没有再遇到这些页面就自动解锁。不要删 `platform-locks.json` 或 `search-gap.json` 来跳过等待。
- **为什么只限加载类操作**：读取已打开页面的内容不会向平台发请求，所以不计次数，只按上表间隔执行。
- **账本**：每个平台一个，放在状态目录里：淘宝是 `pacing.json`，京东是 `pacing-jd.json`（2026-10-15 起），拼多多是 `pacing-pdd.json`（2026-10-27 起）。同一平台的所有任务和命令共用一个账本；京东的加载不占淘宝的额度，反过来也一样。随机抽到的等待时间会先写入账本再开始等待，进程中断后重新运行，沿用同一次抽到的值。确定没有派发出去的加载会退回额度。
- **不要删账本**：删除或改写 `pacing.json`、`pacing-jd.json`、`pacing-pdd.json` 来恢复额度，等于绕过这套保护。账本损坏时会报 `INVALID_PACING_STATE`，不会自动重置。
- **哪些命令受控**：`task-run`、`task-resume`、`task-next-batch`、`bind`、`probe`、`page-open`、`order-workflow-run`、`order-workflow-resume`。`doctor`、`tabs`、`task-status` 只读取元信息，`page-close` 只关闭本地标签页、不向平台发请求，这些都不受控。

## 额度用完时

- **剩余等待不超过 90 秒**：程序就地等待，然后继续。
- **剩余等待更久**：
  - 普通任务返回 `pending`，并给出 `pacing_hold.allowed_after`，在那个时间之前什么都不会发送。到时间后用同一任务再执行 `task-run` 即可继续。这次暂停不消耗重试或恢复额度，被拦下的动作也不会被当成已经执行过。
  - `page-open` 直接返回 `PACING_LIMIT`，`next_action` 里写明可以继续的时间。

## 打开页面

```sh
node scripts/shopping.mjs page-open --search '罗技 M330'
node scripts/shopping.mjs page-open --url 'https://item.taobao.com/item.htm?id=<商品编号>'
```

- 在扩展所在的 Chrome 当前窗口新开一个标签，打开规范化后的地址；商品链接里的跟踪参数会被去掉。
- 返回 `tab_id`、`kind` 和 `url_matches`，不回显网址。`url_matches: false` 通常表示被跳转到了登录或验证页，应先检查，不要直接开始任务。
- agent 应该用这个命令打开页面，而不是在程序之外开页，否则打开的页面不计入额度。
- 京东加 `--platform jd`，见下一节。

## 京东（2026-10-15 起）

```sh
node scripts/shopping.mjs page-open --platform jd --search '罗技 M330'
node scripts/shopping.mjs page-open --platform jd --url 'https://item.jd.com/<商品编号>.html'
node scripts/shopping.mjs page-open --platform jd --orders
node scripts/shopping.mjs page-open --platform jd --cart
```

- **额度**：先与淘宝相同（用户 2026-10-14 决定），记在京东自己的账本 `pacing-jd.json`。以后根据实际遇到的限流逐步调低。
- **落地页面**：京东的结果多一个 `landing`，说明新标签停在哪类页面：`requested`（要打开的页面）、`login_page`（登录页）、`risk_page`（限流页，例如 `pc-frequent-pro.pf.jd.com`）或 `other_page`。只给类别，不回显网址。
- **遇到限流页就停**：`landing: risk_page` 时，`next_action` 要求立即停下所有京东操作，告诉用户是哪个页面，等用户说继续再打开京东页面。
- **打开后才跳到限流页**：2026-10-15 实页遇到过，`page-open` 报告停在要打开的商品页，几秒后标签页才跳到限流页。所以 `bind --platform jd` 和京东绑定的 `probe` 也按地址认出限流页，返回 `RATE_LIMITED` 并写入限流记录，同样要立即停下。
- **限流记录**：每次遇到京东的限流页或页面里的限流、验证提示，都会在状态目录的 `throttle-observations.json` 里追加一条：平台、时间、信号类别、页面类型，以及当时此前 10 分钟和 1 小时内的搜索类、页面类加载次数。调低额度时以这些记录为依据。这个文件只记次数，不记网址和页面内容。
- 京东现在能打开、关闭页面，列出标签页，绑定商品页并核对标题，读取搜索首屏和第 1～N 页的首屏，读取商品详情、分类评价、购物车已加载的行、订单列表已加载的订单和单个订单详情（见[京东](jd.md)）。读取不算加载，不占次数，只按“读取页面前”的间隔执行；订单详情任务在列表上点“订单详情”的那一次会打开新页面，按页面类加载计入京东的次数；搜索翻页任务每点一次“下一页”都换一页结果，按搜索类加载计入（5 页的任务点 4 次，加上 `page-open` 正好是 10 分钟内的 5 次）；搜索排序任务每点一次“销量”或“价格”也按搜索类加载计入（价格升序点两次），价格区间的“确定”也按一次搜索类加载计入（移入、填写按普通动作）；商品详情区的那一次滚动，以及分类评价里打开面板、切换分类、关闭面板的点击，按普通动作的间隔执行。

## 不做的事

不伪造鼠标轨迹、不隐藏自动化痕迹、不修改浏览器指纹、不自动处理验证码。这些属于对抗平台检测，可能违反平台规则，而且效果不可靠。降低风险的办法是请求少一点、慢一点、遇到异常就停：验证码、登录、限流提示、“网络信号走丢”占位出现时，按[任务规则](tasks.md)暂停，等用户确认后才继续。

## 本机负载很高时

2026-10-12 的验收中，Mac 负载约 110 时，订单入口的准备命令需要 7～8 秒，超过了默认的 5 秒时限。这时可以给执行命令加上 `--timeout-ms 15000`，最大为 30000。放宽时限只是多等一会儿回复，不会增加任何页面操作；自动重试的次数和间隔也不变。

## 当前覆盖与限制

- 账本是普通文件，没有跨进程加锁。同一个状态目录下同时运行多个命令时，记录可能互相覆盖；应该一次只运行一个命令。
- 节奏控制只覆盖 CLI 发出的操作。用户自己在浏览器里的操作，以及其他工具发出的操作，都不在计数之内。
- 限额数字是保守估计，以后根据实际情况调整。调整时应修改 `lib/pacing.mjs` 里的 `PACING_POLICY`，并附上理由和测试。

## 拼多多（2026-10-27 起）

```sh
node scripts/shopping.mjs page-open --platform pdd --search '罗技 M330'
node scripts/shopping.mjs page-open --platform pdd --url 'https://mobile.pinduoduo.com/goods.html?goods_id=<编号>'
node scripts/shopping.mjs page-open --platform pdd --orders
```

- **额度比淘宝、京东低**（用户 2026-10-27 决定，拼多多风控更严、账号风险更高）：
  - 搜索类加载每 10 分钟最多 3 次、每小时 10 次；
  - 页面类加载每 10 分钟最多 6 次、每小时 24 次。

  操作间隔和加载后的等待与淘宝相同，记在拼多多自己的账本 `pacing-pdd.json`。
- **任务间隔**：与淘宝、京东相同，搜索类任务之间至少 10 分钟，其他至少 3 分钟。
- **落地页面和限流记录**：与京东相同。`landing` 给出 `requested`、`login_page`、`risk_page`、`other_page` 之一；遇到 `risk_page` 时立即停下所有拼多多操作。绑定和 `probe` 也会按地址认出验证页并写入 `throttle-observations.json`（平台 `pdd`）。
- 拼多多没有购物车，`--cart` 会被拒绝。读取已打开的页面不算加载；全部能力见[拼多多](pdd.md)。
