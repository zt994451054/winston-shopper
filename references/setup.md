# 环境准备与连接

本 Skill 通过 Playwright 扩展连接用户已登录的 Chrome。本机服务会一直运行，任务停下等用户时也要保留这条连接。

## 需要准备什么

| 需要什么 | 说明 |
| --- | --- |
| Node.js 22 或更新版本 | 带配套的 npm；已在 macOS、Node.js 22 和 24 下验证 |
| Google Chrome | 可以直接用平时的 Chrome 资料（通常已登录各平台），也可以让程序一键新建一个专用资料 |
| Playwright 扩展 | 程序会打开商店页，用户点一次“添加至 Chrome”：<https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm> |
| 本地连接依赖 | `setup --install` 按 `runtime/playwright-backend/` 的锁文件安装，不装全局依赖，也不下载另一份 Chrome |
| 平台账号 | 由用户自己登录；程序不自动登录，遇到登录页会停下并把页面显示出来 |

## 首次准备

第一次使用时，AI 依次运行下面的命令，每一步的结果里 `status` 和 `next_action` 会说明下一步。用户只需要：选一种资料方式、点一次“添加至 Chrome”、在扩展里点一次“复制”并在聊天里说一声，没登录的平台扫码登录。令牌由程序直接从剪贴板读取，不发给 agent，不出现在聊天、命令参数或日志里。

| `setup` 的 `status` | 意思 | 下一步 |
| --- | --- | --- |
| `installation_plan` | 缺本地依赖 | `setup --install` |
| `needs_extension` | 哪个 Chrome 资料里都没找到扩展 | 问用户用哪种资料，再 `setup --open-store`（或加 `--new-profile`） |
| `store_opened` | 商店页已打开 | 请用户点“添加至 Chrome”并确认，然后再运行 `setup` |
| `needs_token` | 扩展已装，令牌还没存 | 请用户在扩展里点“复制”后说一声，再 `token-save` |
| `ready_for_bridge_start` | 都准备好了 | `bridge-start`，然后 `doctor` |

### 1. 安装本地依赖

```sh
node scripts/shopping.mjs setup --install
```

首次下载依赖需要联网，安装使用同一份 Node 配套的 npm 和随包锁文件。依赖齐全且锁文件核对通过时会复用，不会每次重装；安装中断可以重跑。锁文件核对不代表检查了所有已安装文件是否被修改。

### 2. 选资料并装扩展

先问用户想用哪种方式：

- **用平时的 Chrome（推荐）**：通常已经登录了淘宝、京东、拼多多，最省事。程序打开的标签页都在后台，不碰用户自己的标签页；连接时 Chrome 会到前面一次。
- **新建一个专用资料**：和平时浏览完全分开，但要在新资料里重新登录各平台。程序让 Chrome 自己建一个名为 `Shopping Assistant` 的新资料（已有同名时加编号），不改 Chrome 的设置文件。

```sh
node scripts/shopping.mjs setup --open-store                 # 平时的 Chrome
node scripts/shopping.mjs setup --open-store --new-profile   # 新建专用资料
```

Chrome 会打开 Playwright 扩展的商店页，请用户点“添加至 Chrome”，在确认框里点“添加扩展程序”。之后再运行 `setup`：`extension.profiles` 列出装了扩展的资料目录名，`extension.profile_names` 给出这些资料在 Chrome 里显示的名字（例如 `"Profile 8": "购物助手"`），跟用户说话时用这个名字。程序只看各资料里有没有这个扩展的安装文件夹，并从 Chrome 的资料列表（`Local State`）只取这些资料的显示名；不打开资料里的设置、Cookie 或其他数据。

`--open-store` 目前只支持 macOS；其他系统会返回商店链接，请用户自己在 Chrome 里打开。

### 3. 保存令牌

先请用户在 Chrome 工具栏点 Playwright 扩展图标，按“复制”，然后在聊天里回一句“复制好了”。**不要让用户把令牌贴进聊天。** 用户回复后运行：

```sh
node scripts/shopping.mjs token-save
```

程序从剪贴板读出令牌，去掉复制时带的 `PLAYWRIGHT_MCP_EXTENSION_TOKEN=` 前缀，核对格式后保存到当前 Skill 的 `.runtime/pw-ext-token`（权限 `600`），再清空剪贴板。命令结果只说明是否保存、剪贴板是否已清空（`clipboard_cleared`），不返回令牌内容。

剪贴板里不是令牌（空的、复制了别的东西）时返回 `TOKEN_CLIPBOARD_NOT_TOKEN`，什么也不保存，剪贴板原样不动，结果里也不带剪贴板内容；请用户在扩展里重新点“复制”后再运行。用户确实复制了却仍然这样，说明当前会话看不到桌面的剪贴板（比如通过 SSH 远程运行，2026-11-07 在测试机上实测如此），改用下面的 `--dialog`。读不到剪贴板时（不是 macOS，或者在没有桌面的远程会话里）返回 `TOKEN_CLIPBOARD_UNAVAILABLE`。

备用方式一：`token-save --dialog` 在屏幕上弹出隐藏输入的对话框，请用户把复制的内容粘贴进去、点“保存”。用户点“取消”返回 `TOKEN_ENTRY_CANCELLED`；弹不出来时返回 `TOKEN_DIALOG_UNAVAILABLE`。

备用方式二：上面两种都不行时，请用户在本机终端进入 Skill 目录，运行下面的命令粘贴令牌，输入不会显示：

```sh
bash -c '
set +x
set -eu
umask 077
if [ -L .runtime ] || [ -L .runtime/pw-ext-token ]; then
  printf "未保存：目录和令牌文件不能是符号链接。\n" >&2
  exit 1
fi
mkdir -p .runtime
chmod 700 .runtime
IFS= read -r -s -p "粘贴 Playwright 令牌（输入不显示）：" shopping_pw_token
printf "\n" >&2
if [ -z "$shopping_pw_token" ]; then
  printf "未保存：输入为空。\n" >&2
  exit 1
fi
touch .runtime/pw-ext-token
chmod 600 .runtime/pw-ext-token
printf "%s\n" "$shopping_pw_token" > .runtime/pw-ext-token
unset shopping_pw_token
'
```

令牌文件和 `.runtime` 目录不能是符号链接。不要把令牌放进环境变量或命令参数，不要用 `cat` 打印。

### 4. 启动服务

```sh
node scripts/shopping.mjs bridge-start
```

只有一个资料装了扩展时，程序自动用它，并把资料目录名存进本机配置，以后不用再选。好几个资料都装了时，会返回 `PLAYWRIGHT_PROFILE_REQUIRED` 并列出它们，请用户选一个，再运行一次 `bridge-start --profile "<资料目录名>"`。

成功时返回 `status: bridge_connected`、`state: ready`、`extensionConnected: true`，以及 `instance_id`。同一安装目录重复启动会复用原来的服务和连接，`started: false` 且 `instance_id` 不变。首次连接失败会报告明确错误码，例如 `PLAYWRIGHT_CONNECT_FAILED`，不会暗中再连一次；检查资料、扩展和令牌后，再明确决定是否重试。

### 5. 检查已运行的服务

```sh
node scripts/shopping.mjs doctor
```

`status: ready` 表示依赖和服务可用，连接中 `protocol` 为 `playwright-extension`、`state` 为 `ready`、`extension_connected` 为 `true`。`doctor` 只检查依赖和服务状态，不启动服务、不重连、不打开或读取页面，也不检查账号是否已登录。没有打开任何任务页面时也算就绪，不应拿浏览器总标签数来核对它。

### 6. 用程序打开任务页面

```sh
node scripts/shopping.mjs page-open --search "罗技 M330"
```

记下返回的 `tab_id`，再按 [SKILL.md](../SKILL.md) 创建任务。京东、拼多多分别加 `--platform jd`、`--platform pdd`。任务页面都用 `page-open` 或任务约定的入口打开，不由其他工具代开。

## 页面范围与常驻服务

`tabs` 只列出本次 Playwright 连接能看到的页面，`inventory_scope` 为 `playwright_connected_pages`。**看不到用户自己打开的页面，也看不到其他资料的页面**，不是 Chrome 全部窗口的清单。查不到页面时不要要求用户来回切窗口来“找回”；先核对原服务是否还在、端点和 `instance_id` 是否相同。程序没有把任意已有页面接进连接的命令。

服务运行期间，每个页面编号保持可用；服务一旦停止或重启，就不能自动认回原来的页面编号。任务暂停、复测脚本退出或用户处理验证码时，都不要关服务。断开后不会自动重连，旧任务也不会自动迁入新连接。

确定任务已收尾、无需在原页面继续时，显式停止：

```sh
node scripts/shopping.mjs bridge-stop
```

它只停止当前安装目录记录的服务和该服务的子进程，不关闭用户的整个 Chrome。不要用查端口后直接杀进程的方法代替它。换资料或端口前也应先明确停止旧服务。

默认地址是 `http://127.0.0.1:19825`，协议名为 `playwright-extension`。可用 `--endpoint` 或 `SHOPPING_BRIDGE_ENDPOINT` 指定其他本机地址；启动、检查、停止和任务命令须使用同一地址。程序只接受本机 HTTP 地址，不使用外部代理、不跟随重定向，也不自动寻找旧服务或换端口。端口被其他服务或另一安装占用时会拒绝启动，不停止或接管对方。

## 窗口何时会到前面

平时读数据、翻页、点击和填写都不主动把窗口提到前面。程序先自行完成约定范围内的操作，只在确实被卡住、绕不过去时请用户配合。下面这些情况例外：

| 情况 | 行为 |
| --- | --- |
| 建立扩展连接 | 每次新建服务连接扩展时，装了扩展的那个 Chrome 窗口会跳到前面一次；复用原服务不会再连接一次 |
| 京东订单详情弹出页 | 新打开的详情页会被 Chrome 带到前面 |
| 淘宝价格菜单需要真实鼠标移入，但页面在后台 | 程序先把该页面切到前面再移入；页面已可见时不提窗 |
| 京东分类评价页面在后台 | 程序先把该页面切到前面再读；仍不可见时才暂停并请用户配合 |
| 登录、验证码或限流导致任务停下 | 先保存暂停状态，再尝试显示对应页面一次，方便用户处理；显示失败不改变原来的错误和暂停状态 |

**淘宝价格任务运行期间，用户的鼠标不要经过程序正在操作的那个 Chrome 窗口**，否则会收起价格菜单。可以照常使用其他窗口。这个提醒适用于整个价格任务，不限于开始的一分钟；浮层意外关闭时，程序只按原任务的有限次数尝试重开。

## 故障处理

| 状态或错误 | 下一步 |
| --- | --- |
| `UNSUPPORTED_NODE` / `NPM_MISSING` | 使用 Node.js 22+ 及其配套 npm |
| `INSTALL_IN_PROGRESS` | 等已有安装结束；不要同时运行另一份安装 |
| `INSTALL_FAILED` / `INSTALL_TIMEOUT` / `BACKEND_MISSING` | 检查下载网络和目录写权限，再明确运行 `setup --install` |
| `PLAYWRIGHT_TOKEN_MISSING` / `PLAYWRIGHT_TOKEN_INVALID` | 请用户在扩展里重新点“复制”，再运行 `token-save`；不要让用户发送令牌内容 |
| `TOKEN_CLIPBOARD_NOT_TOKEN` / `TOKEN_CLIPBOARD_UNAVAILABLE` | 剪贴板里不是令牌，请用户重新点“复制”再运行；读不到剪贴板时改用 `token-save --dialog` 或终端隐藏输入 |
| `PLAYWRIGHT_PROFILE_REQUIRED` | 没找到或找到好几个装了扩展的资料；按 `next_action` 先装扩展，或请用户选一个资料后 `bridge-start --profile` |
| `TOKEN_ENTRY_CANCELLED` / `TOKEN_DIALOG_UNAVAILABLE` | `--dialog` 时用户取消了，或对话框弹不出来；重新运行，或改用上面的终端隐藏输入 |
| `PLAYWRIGHT_TOKEN_PERMISSIONS` | 在 Skill 目录运行 `chmod 600 .runtime/pw-ext-token` |
| `PLAYWRIGHT_TOKEN_FILE_INVALID` / `PLAYWRIGHT_TOKEN_ACCESS_FAILED` | 检查本机目录和文件访问权限；不要用符号链接存令牌 |
| `PLAYWRIGHT_PROFILE_REQUIRED` | 查所选资料的目录名，首次 `bridge-start` 加 `--profile` |
| `BRIDGE_UNAVAILABLE` | 检查端点，明确运行 `bridge-start`；`doctor` 不会替你启动 |
| `PLAYWRIGHT_CONNECT_FAILED` / `EXTENSION_DISCONNECTED` / `MCP_DISCONNECTED` | 保留任务，检查原服务、所选资料、扩展及令牌；不要循环重连。决定重启前先确认旧任务不能再靠原页面继续 |
| `BRIDGE_PORT_IN_USE` / `INCOMPATIBLE_BRIDGE` | 地址上是其他服务；确认正确安装目录和地址，不接管、不自动换端口 |
| `BRIDGE_START_IN_PROGRESS` / `BRIDGE_START_UNCERTAIN` / `BRIDGE_LOCK_UNCERTAIN` | 启动仍在进行或记录不能确认；先检查原进程和本机记录，不删锁强行再开 |
| `BRIDGE_CONFIG_MISMATCH` | 原实例使用另一资料或端口；明确停止后再改配置 |
| `BRIDGE_TIMEOUT` | 检查原服务；需要时给任务加 `--timeout-ms 15000`，不要重发不明点击 |
| `TARGET_CHANGED` / `TARGET_MISSING` | 核对原服务和页面；淘宝任务可用 `task-diagnose`，再按原任务允许的恢复规则处理，不能拿相似页面顶替 |
| `LEGACY_BROWSER_TASK` | 旧通道检查点仅保留回读，见[旧通道与已保存结果](dedicated-browser.md) |

## 更新到新版本

安装包来自 `package.json` 里 `repository` 写的 GitHub 仓库（私有仓库要用用户已登录的 `git` 或 `gh` 取得）。不要为了找来源去翻 shell 历史、其他 agent 的记录或别的目录；仓库取不到时问用户。

1. 先确认没有未收尾的任务（`task-status`），再在本安装目录运行 `bridge-stop`。
2. 把仓库克隆或下载到一个新的临时目录，看 `package.json` 的 `version`，核对 `MANIFEST.json` 里的文件和校验值。
3. 用新文件覆盖本安装目录，**保留**这两个目录：`.runtime/`（令牌和服务记录）、`runtime/playwright-backend/`（已装的依赖；新版 `setup` 提示要装时再运行 `setup --install`）。
4. 状态目录（默认 `~/.consumer-shopping/bindings`）不在安装目录里，更新不会碰它。**不要做备份副本**：不要把状态目录（真实订单和购物车）或整个安装目录（`.runtime/` 里有令牌）复制到 `/tmp`、文稿或其他位置。要回退就从仓库取旧版本的提交，同样只换程序文件。
5. 运行 `setup` 和 `doctor`，再 `bridge-start`。旧任务结果照常可读。
6. 删掉第 2 步的临时目录。

## 本机文件与清理

服务文件位于本 Skill 的 `.runtime/`，不随 `--state-dir` 改变：

- `pw-ext-token`：扩展令牌；
- `playwright-service-config.json`：用户明确选择的资料目录名；
- `bridge-service.json`：服务实例和独立的停止凭据；停止凭据不是扩展令牌，不要打印或分享整个文件；
- `bridge-service.log`：最多 64 KiB，只记服务生命周期事件和固定错误码，不记令牌或页面数据。扩展断开时记一条 `extension_disconnected`（2026-11-08 起），用来对照任务在什么时候失去了连接。

目录权限为 `700`，上述文件权限为 `600`。不要复制这些文件到另一安装目录，不要提交或分享 `.runtime/`。

任务、绑定、节奏和结果默认保存在 `~/.consumer-shopping/bindings/`，也可用 `--state-dir` 或 `SHOPPING_STATE_DIR` 指定。同一轮始终用原目录，不删除账本来恢复额度。旧任务结果原样保留，不自动迁移到新通道。

卸载前先确认任务已收尾，再用原安装目录的 `bridge-stop` 停止服务。按需移除扩展、安装目录和私人任务文件；程序不会清空 Chrome 登录状态。
