# 消费者电商只读采集 Skill（淘宝／天猫、京东、拼多多）

这个 Skill 让 coding agent 通过用户已登录的 Chrome 读取淘宝／天猫、京东和拼多多（手机网页版）的数据。三个平台都已在真实页面上跑过两轮完整复测。

**能读取的内容**

| | 淘宝／天猫 | 京东 | 拼多多 |
| --- | --- | --- | --- |
| 搜索 | 1～5 页；销量、价格升降序、价格区间；只看天猫、包邮 | 1～5 页首屏；销量、价格升降序、价格区间 | 已画出的卡片；销量、价格升降序、价格区间 |
| 商品详情 | 标题、店铺、参数、规格及规格图、展示价、图集、主图、详情长图、服务说明 | 右侧面板、同组规格、商品详情区、默认评价区 | 从搜索卡片点进去读详情 |
| 各规格价格 | 指定规格组合的展示价（最多 20 个组合） | 不做（每个规格是独立商品） | 打开规格抽屉逐个点选项（每个抽屉最多 12 次） |
| 评价 | 按分类，每类前 10 条，含追评 | 1～3 个分类的首屏卡片 | “全部”里已加载的最多 20 条 |
| 购物车 | 已加载的行（最多 50），每行能否购买 | 已加载的行，每行能否购买 | 没有购物车 |
| 订单 | 列表 1～10 页；单个订单的详情正文 | 列表已加载的订单；单个订单详情 | 列表已加载的订单；单个订单详情 |
| 导出 | Markdown／CSV 报告 | Markdown／CSV 报告 | Markdown／CSV 报告 |

完整清单和每项的限制见[能力清单](references/capabilities.md)。

**运行方式**

- 全程只读：不加购、不下单、不改账户。
- 所有页面操作都按随机间隔执行，并有次数上限，以降低风控风险。
- 遇到登录、验证码或限流页面就停下，等用户处理；不自动过验证码。
- 中断后可以恢复，失败时按限定次数重试。

agent 使用说明见 [SKILL.md](SKILL.md)，各项功能的验收状态见[整体验收清单](references/skill-acceptance.md)。

**来源与更新**

- 来源：<https://github.com/zt994451054/winston-shopper>（私有仓库，`package.json` 的 `repository` 也写着）。只从这里取新版；不要为找来源去翻 shell 历史、聊天记录、下载文件夹或别的目录，取不到就问用户。
- 更新：`bridge-stop` → 把仓库克隆到新的临时目录并核对 `MANIFEST.json` → 用新文件覆盖本目录，**保留 `.runtime/` 和 `runtime/playwright-backend/`** → `setup`、`doctor`（不用跑完整测试）→ 删掉临时目录。详见[更新到新版本](references/setup.md#更新到新版本)。
- **不要做备份副本**：`.runtime/` 里有扩展令牌，状态目录（默认 `~/.consumer-shopping/bindings`）里有真实订单和购物车，都不要复制到 `/tmp`、文稿或其他位置。更新只换程序文件，不会碰它们；要回退就从仓库取旧版本的提交。

## 安装前提

| 需要什么 | 说明 |
| --- | --- |
| 电脑 | macOS（已验证）。Windows、Linux 没验证过 |
| Node.js 22 或更新版本 | 带 npm。已验证 22.16 和 24.13 |
| Google Chrome | 用平时的资料，或让程序一键新建专用资料，见[环境准备](references/setup.md) |
| 浏览器扩展 | 从 Chrome 应用商店安装 Playwright 扩展：<https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm> |
| 本地连接服务 | `setup --install` 按锁文件安装 Playwright 依赖；首次下载需要联网，不装全局依赖 |
| 平台账号 | 在那个 Chrome 资料里由用户自己登录淘宝、京东、拼多多（`mobile.pinduoduo.com`）。用到哪个平台登录哪个 |
| 一个 coding agent | 能运行 `node` 命令、读文件，例如 Claude Code |
| 京东订单详情 | 用户要在 Chrome 里允许 order.jd.com 弹出窗口 |

不需要 Python、数据库、API 密钥或付费服务。核心程序只用 Node.js 内置库。

## 快速开始

按以下顺序准备，所有命令都在本目录用 Node.js 22 或更新版本运行：

1. `setup --install` 安装依赖。
2. `setup --open-store` 在平时的 Chrome 里打开扩展商店页（想和平时浏览分开就加 `--new-profile`，程序会让 Chrome 新建一个专用资料），点“添加至 Chrome”。
3. 在 Chrome 工具栏点 Playwright 扩展图标、按“复制”，然后运行 `token-save`：程序从剪贴板读出令牌存好，再清空剪贴板（读不到时用 `token-save --dialog` 弹框粘贴）。令牌只存在本机 `.runtime/pw-ext-token`（权限 `600`），不要发给 agent、贴进聊天或命令参数。
4. `bridge-start` 启动服务：只有一个资料装了扩展时自动选用它。
5. `doctor` 确认 `status: ready` 后，用 `page-open` 打开任务页面；没登录的平台会停在登录页，登录后继续。

用 Claude Code 等 AI 工具时，这些命令由 AI 按 `setup` 返回的 `next_action` 依次运行，你只需要点一次“添加”、在扩展里点一次“复制”并告诉 AI 复制好了。

命令依次是：

```sh
node scripts/shopping.mjs setup --install
node scripts/shopping.mjs setup --open-store
node scripts/shopping.mjs token-save
node scripts/shopping.mjs bridge-start
node scripts/shopping.mjs doctor
node scripts/shopping.mjs page-open --search "罗技 M330"
```

`setup` 分别报告依赖、扩展和令牌状态，并在 `next_action` 里说明下一步；准备齐全时为 `ready_for_bridge_start`。`bridge-start` 成功为 `bridge_connected`，所用资料保存在本机，以后不用再选。好几个资料都装了扩展时，用 `bridge-start --profile "<资料目录名>"` 选一个。默认地址为 `http://127.0.0.1:19825`，重复启动复用同一服务。`doctor` 不启动、不重连、不读页面，没有任务页面时也算就绪。

服务要一直运行，暂停等用户时也不要关闭；重启后无法自动认回原页面编号。确定不再继续原页面时，用 `node scripts/shopping.mjs bridge-stop` 明确停止。页面清单只包括本次连接能看到的页面，看不到用户自己打开的页面；任务页面要用 `page-open` 或任务约定的入口打开。

在新环境里从头验收见[纯净环境验收](references/clean-install-acceptance.md)；错误码、服务文件和连接说明见[环境准备](references/setup.md)。

## 窗口与鼠标

平时不跳前台，程序能自己读就先自己读。建立扩展连接时装了扩展的 Chrome 窗口会跳一次；京东订单详情弹出页会被带到前面。淘宝价格菜单需要真实移入、京东分类评价需要读取时，如果页面在后台，程序会先把该页面切到前面。登录、验证码或限流导致停下时，先保存暂停状态，再显示对应页面一次；显示失败不改变原来的错误或暂停。

**淘宝价格任务整个运行期间，鼠标不要经过装了扩展的 Chrome 窗口**，否则会收起价格菜单。其他窗口可以照常使用。完整说明见[窗口规则](references/setup.md#窗口何时会到前面)。

## 常用示例

搜索第 1 页，按价格从低到高排序，并筛选 40～60 元：

```sh
node scripts/shopping.mjs page-open --search '罗技 M330' --json
node scripts/shopping.mjs task-start --task m330-price --search '罗技 M330' --tab <返回的tab_id> --sort price-asc --min-price 40 --max-price 60
node scripts/shopping.mjs task-run --task m330-price --json
```

读取一件商品的详情：

```sh
node scripts/shopping.mjs page-open --url 'https://item.taobao.com/item.htm?id=<商品编号>' --json
node scripts/shopping.mjs bind --tab <返回的tab_id> --binding sample
node scripts/shopping.mjs task-start --task sample-details --bindings sample --details
node scripts/shopping.mjs task-run --task sample-details --json
```

读取订单列表中的第 1 单（列表 → 详情正文）：

```sh
node scripts/shopping.mjs page-open --orders --json
node scripts/shopping.mjs order-workflow-start --workflow first-order --tab <返回的tab_id> --order-position 1
node scripts/shopping.mjs order-workflow-run --workflow first-order --json
```

读完订单列表里列出的全部订单（最多 10 页，到最后一页自动停止）：

```sh
node scripts/shopping.mjs page-open --orders --json
node scripts/shopping.mjs task-start --task all-orders --orders --pages 10 --tab <返回的tab_id>
node scripts/shopping.mjs task-run --task all-orders --json
```

把结果导出为本地报告：

```sh
node scripts/shopping.mjs report-export --task m330-price --format csv --output ~/Desktop/m330-price.csv
```

完整命令见[命令接口](references/commands.md)，暂停与恢复见[任务说明](references/tasks.md)。

## 在 coding agent 中使用

- **通用方式**：把 [SKILL.md](SKILL.md) 的路径交给 agent，让它读取并按说明执行。不需要配置专门的 MCP 工具。
- **作为 skill 安装**：把目录放进 agent 的 skills 目录，例如 Claude Code 的 `~/.claude/skills/winston-shopper/`，再按上面的顺序准备；每份安装都有自己的本机配置，不复制令牌和服务记录。
- **运行位置**：命令必须在 Chrome 和本机服务所在的机器上执行；连接服务只接受本机地址。只上传 Markdown 文件无法建立连接。

复制时排除以下内容：

- 所有 `node_modules/`、`.runtime/`、`.npm-cache/`；保留 `runtime/playwright-backend/` 下的 `package.json` 和锁文件，在目标机器重新安装依赖；
- 状态目录，默认是 `~/.consumer-shopping/`。

状态目录里有私人订单和购物车数据，不要分享。

## 设计与依赖

- 核心程序只使用 Node.js 内置库。
- Playwright 连接依赖由 `runtime/playwright-backend/` 的清单和锁文件固定，使用 `@playwright/mcp`，不需要全局安装或给 agent 配置 MCP 工具。
- 本机服务通过 Playwright 扩展使用所选 Chrome 资料里的登录状态。令牌只留在本机，扩展从商店单独安装。
- 旧浏览器通道已删除；旧任务检查点和缓存原样保留，不自动迁移，见[旧结果说明](references/dedicated-browser.md)。

## 测试

```sh
node --test
```

测试使用本地模拟服务、合成页面和临时子进程，不访问电商平台；需要允许测试进程监听本地临时端口。Node.js 22 和 24 都要通过，离线测试不代替真实扩展验收。

## 生成安装包

在开发仓库中运行（要求工作区已提交、没有未提交的修改）：

```sh
node scripts/build-package.mjs --output ../dist
```

打包规则：

- 只收录 git 已提交、且在白名单内的文件；具体规则见 `lib/package-contents.mjs`，每次打包的文件见 `MANIFEST.json`。
- 私人状态、已安装的依赖和开发历史不会进包。
- 说明文档中指向包外开发记录的链接，会改成纯文字。
- 任何文件里出现本机用户路径或手机号时，打包中止。

输出的 `winston-shopper/MANIFEST.json` 记录了来源提交和每个文件的 SHA-256，另外生成同名的 `.tar.gz` 压缩包。发布前要确认包里有 `runtime/playwright-backend/` 的清单和锁文件，并在新目录按[纯净环境验收](references/clean-install-acceptance.md)从头安装检查；旧安装包不能用作新版通道的安装验证。

## 历史记录

精简前的 README 和 SKILL.md 原文只保存在开发仓库的 README-HISTORY.md 和 SKILL-HISTORY.md 中，安装包不含这两个文件。
