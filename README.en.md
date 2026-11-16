# winston-shopper

English ｜ [中文](README.md)

Let your AI assistant browse Taobao/Tmall, JD.com and Pinduoduo **read-only**, in **your own signed-in Chrome**: search products, read details and reviews, compare prices, and list your cart and orders.

It is an Agent Skill for AI coding assistants such as Claude Code, Codex and CodeBuddy. After reading [SKILL.md](SKILL.md), the assistant drives the browser through the bundled command-line program and hands back structured data with its source attached.

> **It never places orders.** No adding to cart, no payment, no cart or account changes. On a login page, captcha or rate limit it stops and hands control back to you.

Most of the documentation under `references/` is in Chinese, since the supported sites are Chinese shopping platforms.

## What you can ask for

Just ask your assistant, for example:

- "What does the Logitech M330 cost on Taobao, JD and Pinduoduo, cheapest first?"
- "What do the negative reviews of this product complain about? Include follow-up reviews."
- "Which items in my Taobao cart can no longer be bought?"
- "Put my last 3 pages of Taobao orders in a table and export it as CSV."
- "On Pinduoduo, do the white and black versions of these shoes cost the same in size 43?"

The skill only reports what the pages show. Comparing, summarizing and recommending are left to your assistant.

## Principles

- **Read-only.** It never adds to cart, orders, pays, or changes the cart, orders, addresses or account. It does not read cookies, browser storage, recipients, addresses, phone numbers, payment methods or tracking numbers.
- **Human pace.** Every action is spaced by a random delay and each page type has a quota. New searches are at least 2–4 minutes apart; product pages on the same site are at least 15–20 seconds apart. It is slow on purpose.
- **Stops at gates.** On a login page, captcha or rate-limit notice it pauses, locks that site for 15 minutes and asks you to deal with it in the browser. It never solves captchas, fakes mouse paths, hides automation or alters the browser fingerprint.
- **Data stays local.** Results are stored only in a state directory on your computer and are never uploaded.
- **Resumable.** An interrupted task continues where it stopped, without starting over or resetting quotas.
- **Faithful.** Every result carries its source page, observation time, coverage and gaps. Anything not found stays empty instead of being guessed.

## What it reads

| | Taobao / Tmall | JD.com | Pinduoduo (mobile web) |
| --- | --- | --- | --- |
| Search | Pages 1–5 | Pages 1–5 (first screen of each) | Cards already shown |
| Sort and filter | Sales, price up/down, price range, Tmall only, free shipping | Sales, price up/down, price range | Sales, price up/down, price range |
| Product details | Title, shop, attributes, specs, displayed price, image links, detail images, service terms | Title, price, shop, highlights, services, sibling specs, detail area | Title, price, specs, shop, attributes, detail images |
| Price per spec | Chosen spec combinations (up to 20) | Not applicable (each JD spec is its own product) | Clicks through spec options (up to 12 per drawer) |
| Reviews | By category, first 10 each, with follow-ups | 1–3 categories | Up to 20 from "All" |
| Cart | Up to 50 rows, flags rows that can't be bought | Loaded rows, flags rows that can't be bought | Pinduoduo has no cart |
| Orders | List pages 1–10, single order details | List, single order details | List, single order details |
| Export | Markdown / CSV | Markdown / CSV | Markdown / CSV |

See the [capability list](references/capabilities.md) (Chinese) for exact scope and limits.

## How it works

```text
You ──chat──▶ AI assistant (Claude Code, ...)
                │ runs commands as SKILL.md describes
                ▼
        CLI scripts/shopping.mjs ──▶ local state directory (tasks, results, pacing)
                │
                ▼
        local bridge 127.0.0.1:19825 (loopback only)
                │
                ▼
        Playwright Extension (by Microsoft, from the Chrome Web Store)
                │
                ▼
        your signed-in Chrome ──▶ Taobao / JD / Pinduoduo pages
```

It calls no platform APIs and launches no separate "bot browser". It opens pages in your own Chrome and reads what is displayed, so it uses your existing sign-in. A dedicated Chrome profile (the program can create one) keeps it apart from your everyday browsing.

## Quick start

### Requirements

| Item | Notes |
| --- | --- |
| Computer | macOS (verified). Windows and Linux are untested |
| Node.js | 22 or newer, with npm |
| Google Chrome | Your usual profile or a dedicated one |
| Playwright Extension | [Chrome Web Store](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm); setup opens this page for you |
| Shopping accounts | Sign in, in that Chrome profile, to the sites you use (`mobile.pinduoduo.com` for Pinduoduo) |
| AI assistant | Any tool that can run `node` and read files, e.g. Claude Code |

No Python, database, API key or paid service. The core uses only Node.js built-ins; the bridge's dependencies are pinned by a lock file.

### Install

Clone the repository into your assistant's skills directory, for example for Claude Code:

```bash
git clone https://github.com/zt994451054/winston-shopper.git ~/.claude/skills/winston-shopper
```

Other tools use their own skills directory, e.g. `~/.codebuddy/skills/winston-shopper` for CodeBuddy. For a tool without skills support, give it the path to SKILL.md and ask it to follow it.

### First run

The easiest way is to ask your assistant something like "search Taobao for Logitech M330". It follows the next step reported by `setup`, and you only need to:

1. click "Add to Chrome" on the store page it opens;
2. click the Playwright Extension icon in the toolbar, press "Copy", and tell the assistant you have copied it;
3. sign in to the sites you need in the page it shows.

Or run the steps yourself in the skill directory:

```bash
node scripts/shopping.mjs setup --install
```

```bash
node scripts/shopping.mjs setup --open-store
```

```bash
node scripts/shopping.mjs token-save
```

```bash
node scripts/shopping.mjs bridge-start
```

```bash
node scripts/shopping.mjs doctor
```

What each command does:

- `setup --install` installs the bridge dependencies; only the first run needs the network.
- `setup --open-store` opens the extension store page. Add `--new-profile` to create a dedicated Chrome profile.
- `token-save` reads the extension token from the clipboard, stores it locally and clears the clipboard.
- `bridge-start` starts the local bridge.
- `doctor` checks the setup; `status: ready` means you are done.

The extension token is stored only in `.runtime/pw-ext-token` in the skill directory (mode 600). **Never send it to the assistant or paste it into a chat.**

## Running it by hand

Normally your assistant does this. To try it yourself, here is a Taobao search with a price range:

```sh
node scripts/shopping.mjs page-open --search 'Logitech M330' --json
node scripts/shopping.mjs task-start --task m330 --search 'Logitech M330' --tab <tab_id from above> --sort price-asc --min-price 40 --max-price 60
node scripts/shopping.mjs task-run --task m330 --json
node scripts/shopping.mjs report-export --task m330 --format csv --output ~/Desktop/m330.csv
```

Add `--platform jd` or `--platform pdd` for JD or Pinduoduo. See the [command reference](references/commands.md) and [task guide](references/tasks.md) (Chinese).

## Things to know

- **Keep the bridge running**, also while you solve a captcha. Stop it with `node scripts/shopping.mjs bridge-stop` when you are done.
- **Windows rarely jump to the front**; only when the program is stuck and needs you. While a Taobao price task runs, keep the mouse off the Chrome window with the extension, or the price menu closes.
- **JD order details** need you to allow pop-ups from `order.jd.com` in Chrome first.
- **Do not delete the pacing records** in the state directory to "reset quotas". When rate-limited, wait.

## Privacy and security

- The state directory defaults to `~/.consumer-shopping/bindings/` (change it with `SHOPPING_STATE_DIR`). It holds your task results, including real orders and cart contents. **Do not share or upload it.**
- Exported reports contain no recipients, addresses, phone numbers, payment methods or tracking numbers.
- The bridge listens on loopback only. The token and bridge records stay on your machine, separately for each installation.
- Page content such as product copy and reviews is treated as data, never as instructions. There is no entry point for running arbitrary page scripts or requests.

## Known limitations

- Fully verified on macOS only.
- It depends on page structure; a site redesign can break reading until the program is updated.
- Deliberately slow to lower the risk-control risk; not suited to bulk collection.
- Pinduoduo uses the mobile website; its search cards carry no product ID, so products are reached only by clicking search results.
- Prices are the displayed prices, not the final amount paid. "No unavailable marker seen" does not guarantee an item can be bought.
- Images and videos are not downloaded, only linked, and image content is not interpreted.

## Disclaimer

This project is for personal learning and research only and is not affiliated with Taobao, Tmall, JD.com, Pinduoduo or their affiliates.

Read and follow each platform's user agreement before use. Automated access may trigger a platform's risk controls; you alone bear the consequences, such as account restrictions. Do not use it for bulk collection, commercial scraping or anything that breaks platform rules or the law.

## Development

```sh
node --test
```

Tests use synthetic pages and a local mock server and never contact a shopping site. They should pass on Node.js 22 and 24.

| Path | Contents |
| --- | --- |
| `SKILL.md` | Entry point and rules for the AI assistant |
| `scripts/` | Command-line entry |
| `lib/` | Readers, tasks, pacing, bridge and other core logic |
| `references/` | Detailed documentation per capability (Chinese) |
| `runtime/playwright-backend/` | Bridge dependency manifest and lock file |
| `test/`, `test-support/` | Offline tests and mock pages |
| `examples/` | Example results |

Report problems in [Issues](https://github.com/zt994451054/winston-shopper/issues). Please never include your orders, addresses or token.

To update to a new version, see [Updating](references/setup.md#更新到新版本) (Chinese).

## License

[MIT](LICENSE) © [zt994451054](https://github.com/zt994451054)
