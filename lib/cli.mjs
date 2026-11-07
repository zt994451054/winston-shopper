import { parseArgs } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { BrowserBridge } from './bridge.mjs';
import { DEFAULT_BRIDGE_ENDPOINT, requireReadyBridge, requireLiveTaskChannel } from './bridge-protocol.mjs';
import { inspectExtensionToken } from './playwright-config.mjs';
import { createBlockedPageDisplay, needsPageAssistance } from './foreground.mjs';
import { Pacer } from './pacing.mjs';
import { ShoppingError, publicError } from './errors.mjs';
import { parseTabId, summarizeTab } from './targets.mjs';
import { loadBinding, saveBinding } from './state.mjs';
import { inspectPlaywrightBackend, preparePlaywrightBackend } from './setup.mjs';
import { EXTENSION_STORE_URL, chromeUserDataDirectory, findExtensionProfiles, openExtensionStore, saveTokenFromClipboard, saveTokenFromDialog } from './first-run.mjs';
import { startBridgeService, stopBridgeService } from './bridge-service.mjs';
import { createTask, endTask, rebindTask, runTask, taskStatus } from './tasks.mjs';
import { taskName, loadTask } from './task-store.mjs';
import { workflowName } from './order-workflow-state.mjs';
import { createOrderWorkflow, runOrderWorkflow, orderWorkflowStatus, endOrderWorkflow } from './order-workflow.mjs';
import { exportReport } from './report-export.mjs';
import { planSearchPriceRequest } from './search-price-request.mjs';
import { checkCachedSearchPrices } from './search-price-check.mjs';
import { diagnoseTask } from './task-diagnostics.mjs';
import { checkOpenedPages, closeOpenedPage, recordOpenedPage } from './opened-pages.mjs';
import { searchTarget } from './search.mjs';
import { layoutDiagnosis, checkSavedLayoutProposal } from './layout-assistance.mjs';
import { pacingFile, pacingPolicy, parsePlatform } from './platforms.mjs';
import { productParserOf } from './platform-targets.mjs';
import { jdLandingKind, jdRiskPageError, summarizeJdTab } from './jd/targets.mjs';
import { pddLandingKind, pddRiskPageError, summarizePddTab } from './pdd/targets.mjs';
import { recordThrottleObservation } from './throttle-log.mjs';

const HELP = `Consumer shopping — public product snapshots and browser diagnostics

Usage: node scripts/shopping.mjs <command> [options]

  doctor                   Check the actual runtime, bridge protocol, and extension
  setup [--install] [--open-store [--new-profile]]  Check dependencies, the extension and the token; --install installs the
                           pinned backend, --open-store opens the extension store page (--new-profile in a new Chrome profile)
  token-save [--dialog]    Save the extension token the user copied with the extension's Copy button, read from the macOS
                           clipboard (cleared afterwards); --dialog shows a hidden dialog to paste it into instead. Saved with 0600
  bridge-start [--profile NAME]  Reuse or start the persistent Playwright service; without a saved or given profile it uses
                           the one Chrome profile that has the Playwright extension
  bridge-stop              Explicitly stop this installation's recorded Playwright service
  tabs [--platform jd|pdd] List redacted Taobao/Tmall (or JD, PDD) pages available to the Playwright connection
  page-open [--platform jd|pdd] --search QUERY | --url ITEM_URL | --orders | --cart  Open one canonical search first page, item page, buyer order list or cart (PDD has neither a cart nor --url); counts towards that platform's pacing quota
  page-close --tab ID      Close a tab that page-open or an order entry task opened, if no unfinished task uses it and its address still matches
  bind [--platform jd|pdd] --tab ID  Bind an existing public product tab to a named local record
  probe                    Recheck a binding and read only its public title and item ID
  task-start --task NAME --bindings NAMES  Save a task from 1–50 comma-separated bindings
  task-start --task NAME --plan FILE      Save 1–20 explicitly specified combinations
  task-start --task NAME --cart --tab ID  Save a read-only snapshot task for the first five loaded cart rows
  task-start --task NAME --orders --tab ID  Save a read-only snapshot task for the first five loaded buyer orders
  task-start --task NAME --orders --order-rows N --tab ID  Collect 1-50 loaded buyer orders in batches of five
  task-start --task NAME --orders --pages N --tab ID  Read 1-10 whole buyer order-list pages from page 1 of 所有订单, one guarded 下一页 per page
  task-start --task NAME --search QUERY --tab ID [--source tmall] [--filters 包邮] [--sort price-asc|price-desc] [--min-price CNY] [--max-price CNY] [--pages N]
                           Apply a price direction and/or range on the default first search page and read it once settled
  task-start --task NAME --order-detail --source-task NAME --order-position N --tab ID  Open one saved order once and check page state; body is a separate task
  task-start --task NAME --order-body --source-task NAME  Read one completed entry's confirmed new page; up to ten loaded items, status and amount text
  order-workflow-start --workflow NAME --tab ID --order-position N  Plan one of the first five loaded orders: list, entry and body
  order-workflow-run --workflow NAME  Continue the saved three-stage chain with shared limits
  order-workflow-status --workflow NAME  Return original per-stage observations and budgets locally
  order-workflow-resume --workflow NAME --after-*  Recover the original paused stage only
  order-workflow-end --workflow NAME  End this round locally, retaining all stage checkpoints
  task-start --task NAME --cart --cart-rows N --tab ID  Save a 1–50 loaded-row collection, at most five new rows per batch
  task-start --task NAME --search QUERY --tab ID  Search from the exact Taobao homepage, or read the same query's first page
  task-start --platform pdd --task NAME --search QUERY --tab ID  Read the loaded cards of a PDD search page opened by page-open --platform pdd; nothing is clicked or scrolled
  task-start --platform pdd --task NAME --search QUERY --tab ID [--min-price A --max-price B] [--sort sales|price-asc|price-desc]  On that fresh search page set the price range in 筛选 (whole yuan), then click 销量, 价格 or 价格 twice, checking the page after each action, then read the loaded cards
  task-start --platform pdd --task NAME --source-task SEARCH_TASK --position N  On that search task's tab, check card N still shows the saved title and price, click it once and read the product page it opens in the same tab
  task-start --platform pdd --task NAME --orders --tab ID  Read the loaded order cards of a PDD order list opened by page-open --platform pdd --orders; nothing is clicked or scrolled
  task-start --platform pdd --task NAME --source-task ORDERS_TASK --order-position N  On that list task's tab, check order N, click its product name once, unfold 查看更多订单和优惠信息 once and read the order page without consignee, payment or logistics rows
  task-start --platform pdd --task NAME --source-task PRODUCT_TASK --reviews  On that product task's tab, click 查看全部 once and read the loaded reviews of the default list (at most 20, no scrolling, no reviewer names); a product without reviews is answered without a click
  task-start --platform pdd --task NAME --source-task PRODUCT_TASK --spec-prices  On that product task's tab, open the spec drawer of each bottom bar buy button once, click the unselected options one at a time (at most 12 per drawer), read the price after each and close the drawer; never 确定, never the quantity, stops if the tab leaves the product page
  task-start --platform jd --task NAME --search QUERY --tab ID  Read the loaded first screen of a JD search page opened by page-open --platform jd
  task-start --platform jd --task NAME --search QUERY --tab ID --pages N  From page 1 of that search, read the loaded first screen of pages 1..N (2-5), clicking 下一页 once per page; stops if a page does not change
  task-start --platform jd --task NAME --search QUERY --tab ID --sort sales|price-desc|price-asc [--pages N]  From page 1 in the default 综合 sort, click 销量 once or 价格 once (high to low) or twice (low to high), check the sort, then read pages 1..N
  task-start --platform jd --task NAME --bindings NAME --details  Read one bound JD product page; scrolls once to its 商品详情 section if it has not loaded
  task-start --platform jd --task NAME --cart --tab ID  Read the loaded rows of a JD cart page opened by page-open --platform jd --cart; nothing is clicked or scrolled
  task-start --platform jd --task NAME --orders --tab ID  Read the loaded order cards of a JD order list opened by page-open --platform jd --orders; nothing is clicked, scrolled or paged
  task-start --platform jd --task NAME --order-detail --tab ID --order-position N  Click 订单详情 once on loaded order N (1-10) of that JD order list, read the new detail tab, then close it; needs pop-ups allowed for order.jd.com
  task-start --platform jd --task NAME --bindings NAME --review-categories FILE  Read up to three 全部评价 categories on one bound JD product; the page must be visible, and the panel is closed only if this task opened it
  task-start --task NAME --search QUERY --tab ID --pages N  Read 1–5 pages, at most 25 loaded cards per page, with saved adjacent-page intent
  task-start --task NAME --search QUERY --tab ID --inspect-controls  Inspect bounded visible sort controls without clicking
  task-start --task NAME --search QUERY --tab ID --inspect-price  Click the price entry once and record before/after controls; no direction claim
  task-start --task NAME --search QUERY --tab ID --inspect-price-hover  Hover the price entry once using a fresh scoped reference; inspect visible direction labels
  task-start --task NAME --search QUERY --tab ID --sort sales  Switch the visible sales tab once and observe up to 25 cards
  search-price-plan --search QUERY [--sort price-asc|price-desc] [--min-price CNY] [--max-price CNY]
                           Plan price intent locally; platform price-sort/filter UI is not implemented
  search-price-check --task NAME [--sort price-asc|price-desc] [--min-price CNY] [--max-price CNY]
                           Check cached displayed prices in their original ranking; no platform action
  task-start --task NAME --bindings NAMES --reviews  Expand loaded reviews for 1–10 products
  task-start --task NAME --bindings NAME --review-categories FILE  Sample up to three text categories, ten positions each, with at most one guarded panel opening
  task-next-batch --task NAME  Continue an order/cart or legacy specification-image batch without resetting budgets
  task-start --task NAME --bindings NAME --specification-images  Collect specification images with bounded reads and conditional scrolling
  task-start --task NAME --bindings NAME --gallery  Read up to twenty static thumbnail elements only; no image switching
  task-start --task NAME --bindings NAMES --details  Read loaded parameters, image links, shop and service labels for 1–10 products
  task-start --task NAME --bindings NAME --description-image-load POSITION  Observe one description IMG, with at most one guarded scroll
  task-start --task NAME --bindings NAME --description-expand  Expand one explicitly bound description entry and confirm text; no scroll
  task-start --task NAME --bindings NAMES --services  Open service summaries once if needed, retaining details for 1–10 products
  task-start --task NAME --bindings NAME --main-images FILE  Select up to three observed static thumbnails and confirm their displayed main images
  task-run --task NAME      Read loaded product regions, with durable retry limits
  task-status --task NAME   Read saved progress without contacting the browser
  report-export --task NAME --format markdown|csv --output FILE  Export cached observations locally
  task-diagnose --task NAME Compare saved targets with tabs; no page reads or budget changes
  layout-diagnosis --task NAME --operation N  Return saved bounded layout evidence; offline
  layout-check --task NAME --operation N --proposal FILE  Check model node references against saved evidence; offline
  task-resume --task NAME   Continue after an explicit recovery action below
  task-rebind --task NAME --binding NAME  Reattach the same product after its tab closes
  task-rebind --task NAME --tab ID        Reattach the same cart/order-list route, or a query page allowed by saved intent
  task-end --task NAME      Explicitly end a round locally, retaining results and counters
                           Explicitly retry one recorded transfer failure; same budget, five-second wait

Options:
  --endpoint URL           Loopback bridge origin (default http://127.0.0.1:19825)
  --profile NAME           Chrome profile directory name (bridge-start only; saved locally)
  --timeout-ms N           Per-request deadline, 20–30000 (default 5000)
  --state-dir PATH         Private binding directory (default ~/.consumer-shopping/bindings)
  --binding NAME           Binding name (default default)
  --replace                Explicitly replace an existing binding (bind only)
  --platform taobao|jd|pdd Platform for tabs, page-open, bind and task-start (default taobao). PDD tasks read the loaded search cards (--search QUERY --tab ID), open one card's product page (--source-task NAME --position N) its review page (--source-task PRODUCT_TASK --reviews) or its spec drawers (--source-task PRODUCT_TASK --spec-prices), read the order list (--orders --tab ID) or one order (--source-task ORDERS_TASK --order-position N)
  --after-user             User reports completing login/verification (task-resume)
  --after-cooldown         User explicitly requests the single cooldown probe (task-resume)
  --after-connection       Connection or original target restored (task-resume)
  --json                   Accepted for clarity; command results are always JSON
  --format markdown|csv    Cached report format (report-export only)
  --output FILE            Unused filename outside the source state directory
  --help                   Show this help

Reads loaded public regions and can select explicitly planned specification options.
Search navigation is limited to a designated Taobao homepage. No purchases, login
automation, arbitrary JavaScript, unlimited pagination or account identity/payment reads.
Cart snapshots contain private shopping rows and must remain local.
`;

const COMMON = ['endpoint', 'timeout-ms', 'json'];
const BROWSER_OPTIONS = [...COMMON, 'state-dir'];
const WORKFLOW_OPTIONS = [...COMMON, 'state-dir', 'workflow'];
const COMMAND_OPTIONS = {
  'order-workflow-start': [...WORKFLOW_OPTIONS, 'tab', 'order-position'],
  'order-workflow-run': WORKFLOW_OPTIONS,
  'order-workflow-status': ['workflow', 'state-dir', 'json'],
  'order-workflow-resume': [...WORKFLOW_OPTIONS, 'after-user', 'after-cooldown', 'after-connection'],
  'order-workflow-end': ['workflow', 'state-dir', 'json'],
  doctor: BROWSER_OPTIONS,
  setup: ['install', 'open-store', 'new-profile', 'json'],
  'token-save': ['dialog', 'json'],
  'bridge-start': ['endpoint', 'profile', 'json'],
  'bridge-stop': ['endpoint', 'json'],
  tabs: [...BROWSER_OPTIONS, 'platform'],
  'page-open': [...BROWSER_OPTIONS, 'platform', 'search', 'url', 'orders', 'cart'],
  'page-close': [...BROWSER_OPTIONS, 'tab'],
  bind: [...BROWSER_OPTIONS, 'platform', 'tab', 'binding', 'replace'],
  probe: [...BROWSER_OPTIONS, 'binding'],
  'task-start': [...BROWSER_OPTIONS, 'platform', 'task', 'bindings', 'plan', 'review-categories', 'main-images', 'search', 'cart', 'cart-rows', 'orders', 'order-rows', 'order-detail', 'order-body', 'source-task', 'order-position', 'position', 'tab', 'pages', 'sort', 'min-price', 'max-price', 'source', 'filters', 'inspect-controls', 'inspect-price', 'inspect-price-hover', 'reviews', 'spec-prices', 'details', 'services', 'description-expand', 'description-image-load', 'gallery', 'specification-images'],
  'task-next-batch': [...BROWSER_OPTIONS, 'task'],
  'task-run': [...BROWSER_OPTIONS, 'task'],
  'task-status': ['task', 'state-dir', 'json'],
  'report-export': ['task', 'state-dir', 'format', 'output', 'json'],
  'search-price-plan': ['search', 'sort', 'min-price', 'max-price', 'json'],
  'search-price-check': ['task', 'state-dir', 'sort', 'min-price', 'max-price', 'json'],
  'task-diagnose': [...BROWSER_OPTIONS, 'task'],
  'layout-diagnosis': ['task', 'operation', 'state-dir', 'json'],
  'layout-check': ['task', 'operation', 'proposal', 'state-dir', 'json'],
  'task-rebind': [...BROWSER_OPTIONS, 'task', 'binding', 'tab'],
  'task-end': ['task', 'state-dir', 'json'],
  'task-resume': [...BROWSER_OPTIONS, 'task', 'after-user', 'after-cooldown', 'after-connection'],
};

function optionsFrom(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: {
      endpoint: { type: 'string' }, profile: { type: 'string' }, 'timeout-ms': { type: 'string' },
      'state-dir': { type: 'string' }, binding: { type: 'string' }, tab: { type: 'string' },
      platform: { type: 'string' }, replace: { type: 'boolean' }, install: { type: 'boolean' },
      'open-store': { type: 'boolean' }, 'new-profile': { type: 'boolean' }, dialog: { type: 'boolean' },
      json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      task: { type: 'string' }, workflow: { type: 'string' }, bindings: { type: 'string' }, plan: { type: 'string' },
      operation: { type: 'string' }, proposal: { type: 'string' },
      format: { type: 'string' }, output: { type: 'string' },
      'min-price': { type: 'string' }, 'max-price': { type: 'string' }, source: { type: 'string' }, filters: { type: 'string' },
      'review-categories': { type: 'string' },
      'order-detail': { type:'boolean' }, 'order-body': { type:'boolean' }, 'source-task': { type:'string' }, 'order-position': { type:'string' },
      'main-images': { type: 'string' }, 'specification-images': { type: 'boolean' }, 'description-expand': { type: 'boolean' }, 'description-image-load': { type: 'string' },
      cart: { type: 'boolean' }, 'cart-rows': { type: 'string' }, orders: { type: 'boolean' }, 'order-rows': { type: 'string' }, search: { type: 'string' }, pages: { type: 'string' }, sort: { type: 'string' }, 'inspect-controls': { type: 'boolean' }, 'inspect-price': { type: 'boolean' }, 'inspect-price-hover': { type: 'boolean' }, reviews: { type: 'boolean' }, 'spec-prices': { type: 'boolean' }, details: { type: 'boolean' }, services: { type: 'boolean' }, gallery: { type: 'boolean' },
      position: { type: 'string' }, url: { type: 'string' },
      'after-user': { type: 'boolean' }, 'after-cooldown': { type: 'boolean' }, 'after-connection': { type: 'boolean' },
    } });
  } catch { throw new ShoppingError('INVALID_ARGUMENTS', 'The command contains an unknown option or a missing option value.', 'Run --help for supported arguments.'); }
  if (parsed.values.help || parsed.positionals.length === 0) return { help: true };
  const [command] = parsed.positionals;
  const allowed = COMMAND_OPTIONS[command];
  if (!allowed || parsed.positionals.length !== 1 || Object.keys(parsed.values).some(key => !allowed.includes(key))) {
    throw new ShoppingError('INVALID_ARGUMENTS', 'Use one supported command and only its documented options.', 'Run --help.');
  }
  const values = parsed.values;
  if (command === 'search-price-plan' || command === 'search-price-check') {
    const request = { sort: values.sort ?? null, minPrice: values['min-price'] ?? null, maxPrice: values['max-price'] ?? null };
    if (command === 'search-price-plan') return { command, query: values.search ?? null, ...request };
    taskName(values.task);
    return { command, task: values.task, ...request,
      stateDirectory: path.resolve(values['state-dir'] ?? process.env.SHOPPING_STATE_DIR ?? path.join(os.homedir(), '.consumer-shopping', 'bindings')) };
  }
  const isTask = command.startsWith('task-') || ['report-export', 'layout-diagnosis', 'layout-check'].includes(command);
  if (isTask) taskName(values.task);
  if (command === 'report-export') return {
    command, task: values.task, format: values.format, output: values.output,
    stateDirectory: path.resolve(values['state-dir'] ?? process.env.SHOPPING_STATE_DIR ?? path.join(os.homedir(), '.consumer-shopping', 'bindings')),
  };
  if (command.startsWith('order-workflow-')) workflowName(values.workflow);
  const recoveries = ['user', 'cooldown', 'connection'].filter(kind => values[`after-${kind}`]);
  if (['task-resume', 'order-workflow-resume'].includes(command) && recoveries.length !== 1) {
    throw new ShoppingError('INVALID_RECOVERY', 'Resume requires exactly one documented --after-* recovery flag.');
  }
  const platform = parsePlatform(values.platform);
  if (command === 'task-rebind' && values.tab !== undefined && values.binding !== undefined) {
    throw new ShoppingError('INVALID_ARGUMENTS', 'Choose --tab for search/cart/order-list reattachment or --binding for product reattachment.');
  }
  const binding = values.binding ?? 'default';
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(binding)) {
    throw new ShoppingError('INVALID_BINDING_NAME', 'Use a short lowercase binding name without path separators.');
  }
  const endpoint = values.endpoint ?? process.env.SHOPPING_BRIDGE_ENDPOINT ?? DEFAULT_BRIDGE_ENDPOINT;
  const timeoutMs = values['timeout-ms'] === undefined ? 5000 : Number(values['timeout-ms']);
  // Only commands that accept --endpoint talk to the browser; local commands must not fail on a bad endpoint setting.
  const bridge = COMMAND_OPTIONS[command].includes('endpoint') ? new BrowserBridge(endpoint, { timeoutMs }) : null;
  return {
    command, bridge, platform, profile: values.profile, explicitEndpoint: values.endpoint !== undefined, binding: command === 'task-rebind' && values.tab !== undefined ? undefined : binding, nextBatch: command === 'task-next-batch',
    stateDirectory: path.resolve(values['state-dir'] ?? process.env.SHOPPING_STATE_DIR ?? path.join(os.homedir(), '.consumer-shopping', 'bindings')),
    replace: values.replace ?? false, install: values.install ?? false, openStore: values['open-store'] ?? false, newProfile: values['new-profile'] ?? false, dialog: values.dialog ?? false,
    task: values.task, workflow: values.workflow, bindings: values.bindings?.split(','), plan: values.plan ? path.resolve(values.plan) : undefined, recovery: recoveries[0],
    operation: values.operation === undefined ? undefined : Number(values.operation),
    proposal: values.proposal === undefined ? undefined : path.resolve(values.proposal),
    reviewCategories: values['review-categories'] === undefined ? undefined : path.resolve(values['review-categories']),
    mainImages: values['main-images'] === undefined ? undefined : path.resolve(values['main-images']),
    cart: values.cart ?? false, cartRows: values['cart-rows'] === undefined ? undefined : Number(values['cart-rows']), orders: values.orders ?? false,
    orderRows: values['order-rows'] === undefined ? undefined : Number(values['order-rows']), search: values.search, url: values.url, sort: values.sort, minPrice: values['min-price'], maxPrice: values['max-price'], source: values.source,
    filters: values.filters === undefined ? undefined : values.filters.split(',').map(label => label.trim()), inspectControls: values['inspect-controls'] ?? false, inspectPrice: values['inspect-price'] ?? false, inspectPriceHover: values['inspect-price-hover'] ?? false, pages: values.pages === undefined ? undefined : Number(values.pages), reviews: values.reviews ?? false, specPrices: values['spec-prices'] ?? false, details: values.details ?? false, services: values.services ?? false, descriptionExpand: values['description-expand'] ?? false, descriptionImageLoad: values['description-image-load'] === undefined ? undefined : Number(values['description-image-load']), gallery: values.gallery ?? false, specificationImages: values['specification-images'] ?? false,
    orderDetail:values['order-detail'] ?? false, orderBody:values['order-body'] ?? false, sourceTask:values['source-task'], orderPosition:values['order-position'] === undefined ? undefined : Number(values['order-position']),
    position: values.position === undefined ? undefined : Number(values.position),
    ...(command === 'bind' || values.tab !== undefined ? { tabId: parseTabId(values.tab) } : {}),
  };
}

async function doctor(bridge, environment) {
  const runtime = { node: process.versions.node, executable: process.execPath, os: process.platform, architecture: process.arch };
  let backend, connection = { endpoint: bridge.endpoint, protocol: bridge.protocol, inventory_scope: bridge.inventoryScope };
  try { backend = await environment.inspectBackend(); }
  catch (error) { backend = { installed: false, lock_verified: false, error: publicError(error) }; }
  try {
    const status = await bridge.status();
    connection = { ...connection, protocol: status.backend, running: status.running, extension_connected: status.extensionConnected,
      browser_connected: status.state === 'ready', state: status.state ?? 'legacy', instance_id: status.instance_id,
      protocol_version: status.protocol_version, mcp_running: status.mcp_running, capabilities: status.capabilities,
      error_code: status.error_code };
    requireReadyBridge(status);
    if (!backend.installed || !backend.lock_verified) throw new ShoppingError('BACKEND_MISSING',
      'The pinned Playwright backend is not installed and verified.', 'Run setup --install. No service was started or reconnected.');
    return {
      ok: true, status: 'ready', runtime, backend, connection,
      login_verified: false,
      next_action: 'Use page-open, then use its tab ID for the next task. Zero open pages is valid. Account login was not checked.',
    };
  } catch (error) {
    return { ok: false, status: 'needs_attention', runtime, backend, connection, error: publicError(error), login_verified: false };
  }
}

const FIRST_RUN_ACTIONS = {
  installation_plan: 'Run setup --install to install the pinned Playwright backend from its lockfile.',
  needs_extension: 'Ask the user whether to use their everyday Chrome profile (already logged in) or a new profile kept apart from everyday browsing, then run setup --open-store (add --new-profile for the second). The user clicks 添加至 Chrome once.',
  store_opened: 'Tell the user to click 添加至 Chrome on the opened page and confirm 添加扩展程序, then run setup again.',
  needs_token: 'Tell the user to click the Playwright extension icon in Chrome, press Copy, and reply when done (do not paste it in chat); then run token-save, which reads it from the clipboard. Never ask for the token in chat.',
  ready_for_bridge_start: 'Run bridge-start, then doctor. Chrome comes to the front once while connecting.',
};

async function setup({ install, openStore, newProfile }, environment) {
  const token = await environment.inspectToken();
  let backend;
  try { backend = await environment.prepareBackend({ install }); }
  catch (error) {
    return { ok: false, ready: false, status: 'needs_attention', backend: { installed: false, lock_verified: false, error: publicError(error) },
      token, error: publicError(error) };
  }
  const store = openStore ? await environment.openStore({ newProfile }) : null;
  const profiles = await environment.findProfiles();
  const dependenciesReady = backend.installed && backend.lock_verified;
  // An unsupported system cannot be scanned; the token step still applies there and bridge-start then needs --profile.
  const extensionFound = profiles.length > 0 || environment.profileScanUnsupported === true;
  const status = !dependenciesReady ? 'installation_plan' : store?.opened ? 'store_opened' : !extensionFound ? 'needs_extension'
    : !token.valid ? 'needs_token' : 'ready_for_bridge_start';
  return { ok: true, ready: status === 'ready_for_bridge_start', status, backend, token,
    extension: { store_url: EXTENSION_STORE_URL, profiles, ...(store ? { store_opened: store.opened, new_profile: store.profile } : {}) },
    next_action: status === 'needs_token' && token.status === 'permissions' ? token.next_action
      : store && !store.opened ? `Ask the user to open ${store.url} in Chrome and click 添加至 Chrome, then run setup again.` : FIRST_RUN_ACTIONS[status] };
}

async function profilesOrNone(environment) {
  try { return await environment.findProfiles(); }
  catch { return []; }
}

// Each profile's extension has its own token, so a failed first connection with several profiles usually means the
// saved token belongs to another profile than the one being connected (for example after switching profiles).
async function explainConnectFailure(error, environment) {
  const profiles = error.code === 'PLAYWRIGHT_CONNECT_FAILED' ? await profilesOrNone(environment) : [];
  if (profiles.length < 2) return error;
  return new ShoppingError(error.code, `${error.message} Several Chrome profiles have the Playwright extension (${profiles.join(', ')}), and each has its own token.`,
    'The saved token probably belongs to another profile. Ask the user which profile to use; have them press Copy in that profile\'s extension and run token-save, then run bridge-start --profile NAME.');
}

async function startWithProfile(options, services, environment) {
  try { return await services.start({ endpoint: options.bridge.endpoint, profile: options.profile }); }
  catch (error) {
    if (error.code !== 'PLAYWRIGHT_PROFILE_REQUIRED' || options.profile !== undefined) throw await explainConnectFailure(error, environment);
    const profiles = await environment.findProfiles();
    if (profiles.length === 1) return services.start({ endpoint: options.bridge.endpoint, profile: profiles[0] });
    throw new ShoppingError('PLAYWRIGHT_PROFILE_REQUIRED', profiles.length
      ? `Several Chrome profiles have the Playwright extension: ${profiles.join(', ')}.` : 'No Chrome profile with the Playwright extension was found.',
    profiles.length ? 'Ask the user which profile to use, then run bridge-start --profile NAME once; it is saved for later starts.'
      : 'Run setup and follow its steps to add the extension first.');
  }
}

const RISK_LANDINGS = { jd: [jdLandingKind, jdRiskPageError], pdd: [pddLandingKind, pddRiskPageError] };
const PRODUCT_HINTS = { taobao: 'Select a public item.taobao.com or detail.tmall.com product page.', jd: 'Select an item.jd.com product page.',
  pdd: 'Select a mobile.pinduoduo.com goods page.' };

async function bindTarget(options) {
  const { bridge, platform, tabId, binding, stateDirectory, replace } = options;
  await bridge.requireConnected();
  const tab = (await bridge.listTabs()).find(item => item.id === tabId);
  if (!tab) throw new ShoppingError('TARGET_MISSING', 'The selected tab is not in the extension current-window inventory.', 'Bring the intended Chrome window forward, then run tabs.');
  const [landingKind, riskError] = RISK_LANDINGS[platform] ?? [];
  if (landingKind?.(tab.url) === 'risk_page') throw riskError();
  const target = productParserOf(platform)(tab.url);
  if (!target) throw new ShoppingError('UNSUPPORTED_TARGET', PRODUCT_HINTS[platform]);
  await bridge.readMetadata(tabId, target);
  const record = { schema_version: 1, platform, endpoint: bridge.endpoint,
    tab_id: tabId, target, created_at: new Date().toISOString() };
  const statePath = await saveBinding(stateDirectory, binding, record, { replace });
  return { ok: true, status: 'bound', platform, binding, state_path: statePath, tab_id: tabId,
    target: target.url, login_verified: false, next_action: 'Run probe with the same binding and state directory.' };
}

async function probeTarget({ bridge, binding, stateDirectory }) {
  const record = await loadBinding(stateDirectory, binding);
  if (record.endpoint !== bridge.endpoint) {
    throw new ShoppingError('BINDING_ENDPOINT_MISMATCH', 'The requested bridge differs from the saved binding.', 'Use the original endpoint or explicitly bind the intended page at the new endpoint.');
  }
  await bridge.requireConnected();
  const tab = (await bridge.listTabs()).find(item => item.id === record.tab_id);
  if (!tab) throw new ShoppingError('TARGET_MISSING', 'The bound tab is not in the extension current-window inventory.', 'Bring the original Chrome window forward and check tabs before replacing the binding.');
  if (productParserOf(record.platform)(tab.url)?.url !== record.target.url) {
    throw new ShoppingError('TARGET_CHANGED', 'The bound tab now points to another page.', 'Restore the intended page or explicitly create a new binding.');
  }
  const metadata = await bridge.readMetadata(record.tab_id, record.target);
  return { ok: true, status: 'public_metadata_observed', platform: record.platform, binding, tab_id: record.tab_id,
    observed_at: new Date().toISOString(), metadata, login_verified: false, automatic_retries: 0 };
}

// Commands that operate pages share one persistent pacing ledger per platform and state directory (lib/pacing.mjs).
const PACED_COMMANDS = new Set(['task-run', 'task-resume', 'task-next-batch', 'page-open', 'bind', 'probe', 'order-workflow-run', 'order-workflow-resume']);
async function withPacer(options) {
  if (!PACED_COMMANDS.has(options.command) || options.pacer) return options;
  const platform = await pacedPlatform(options);
  const pacer = new Pacer({ file: pacingFile(options.stateDirectory, platform), policy: pacingPolicy(platform) });
  options.bridge.usePacer(pacer);
  return { ...options, pacer };
}

// A saved task or binding keeps its platform; order workflows are Taobao-only.
async function pacedPlatform({ command, platform, stateDirectory, binding, task }) {
  if (['page-open', 'bind'].includes(command)) return platform;
  if (command === 'probe') return (await loadBinding(stateDirectory, binding)).platform;
  if (command.startsWith('task-')) return (await loadTask(stateDirectory, task)).platform;
  return 'taobao';
}

// Record a JD or PDD limit with the load counts of that platform's ledger at that moment, so its quotas can be lowered
// from evidence.
function limitRecorder({ stateDirectory, pacer }, platform) {
  return async ({ signal, page_kind }) => {
    await recordThrottleObservation(stateDirectory, { platform, signal, page_kind, loads: await pacer.recentLoads() });
  };
}

const TAOBAO_TASK_COMMANDS = new Set(['task-diagnose', 'layout-diagnosis', 'layout-check']);
async function rejectJdTask({ command, stateDirectory, task }) {
  if (TAOBAO_TASK_COMMANDS.has(command) && (await loadTask(stateDirectory, task)).platform !== 'taobao') {
    throw new ShoppingError('UNSUPPORTED_PLATFORM', `${command} is not available for JD tasks yet.`);
  }
}

const OPENERS = {
  taobao: { search: 'openSearchPage', product: 'openProductPage', orders: 'openOrderListPage', cart: 'openCartPage' },
  jd: { search: 'openJdSearchPage', product: 'openJdProductPage', orders: 'openJdOrderListPage', cart: 'openJdCartPage' },
  // PDD products are reached the way a person does, from a search card (user, 2026-10-27): a bare goods_id link showed a
  // page with its price hidden.
  pdd: { search: 'openPddSearchPage', orders: 'openPddOrderListPage' },
};
const PLATFORM_NAMES = { taobao: 'Taobao', jd: 'JD', pdd: 'PDD' };
const landingAction = (platform, landing) => ({
  risk_page: `${PLATFORM_NAMES[platform]} showed a verification or access-limit page. Stop all ${PLATFORM_NAMES[platform]} work now and tell the user which page; open no further ${PLATFORM_NAMES[platform]} pages until the user says to continue. The load counts were saved to throttle-observations.json.`,
  login_page: `${PLATFORM_NAMES[platform]} asks for login. Ask the user to log in to ${PLATFORM_NAMES[platform]} in this browser profile, then continue.`,
})[landing];

async function openPage({ bridge, pacer, stateDirectory, platform, search, url, orders, cart }) {
  if ([search !== undefined, url !== undefined, orders === true, cart === true].filter(Boolean).length !== 1) {
    throw new ShoppingError('INVALID_ARGUMENTS', 'Use exactly one of --search, --url, --orders or --cart.');
  }
  // Check the record first so a page is never opened that page-close could not later find.
  await checkOpenedPages(stateDirectory);
  const kind = search !== undefined ? 'search' : url !== undefined ? 'product' : orders ? 'orders' : 'cart';
  if (!OPENERS[platform][kind]) {
    throw new ShoppingError('UNSUPPORTED_PLATFORM', kind === 'cart' ? 'PDD has no cart page.'
      : 'PDD product pages are opened from a search card: task-start --platform pdd --source-task SEARCH_TASK --position N.');
  }
  const opened = await bridge[OPENERS[platform][kind]](kind === 'search' ? search : url);
  await recordOpenedPage(stateDirectory, { ...opened, platform },
    kind === 'search' ? searchTarget(search).query : kind === 'product' ? productParserOf(platform)(url).product_id : null);
  if (opened.landing === 'risk_page') {
    await recordThrottleObservation(stateDirectory, { platform, signal: 'risk_page', page_kind: kind, loads: await pacer.recentLoads() });
  }
  if (['login_page', 'risk_page'].includes(opened.landing)) await createBlockedPageDisplay(bridge)(opened.tab_id);
  return { ok: true, status: 'page_opened', platform, ...opened, login_verified: false,
    next_action: landingAction(platform, opened.landing) ?? (opened.url_matches ? 'Use this tab ID for the next task. The page may still require login or verification.'
      : 'The new tab did not land on the requested page (for example, a login or verification redirect). Inspect it before any task.') };
}

async function execute(options, services, environment) {
  if (options.command === 'bridge-start') return startWithProfile(options, services, environment);
  if (options.command === 'bridge-stop') return services.stop({ endpoint: options.bridge.endpoint });
  if (options.command === 'setup') return setup(options, environment);
  if (options.command === 'token-save') return { ok: true, status: 'token_saved', ...(await (options.dialog ? environment.saveTokenWithDialog() : environment.saveToken())),
    next_action: 'Run setup to confirm the token, then bridge-start.' };
  if (options.command === 'doctor') {
    return doctor(options.bridge, environment);
  }
  if (options.command === 'search-price-plan' || options.command === 'search-price-check') {
    const { command, ...request } = options;
    return command === 'search-price-plan' ? planSearchPriceRequest(request) : checkCachedSearchPrices(request);
  }
  if (options.command === 'report-export') return exportReport(options);
  await rejectJdTask(options);
  if (options.command === 'order-workflow-start') return createOrderWorkflow(options);
  if (options.command === 'order-workflow-status') return orderWorkflowStatus(options);
  if (options.command === 'order-workflow-end') return endOrderWorkflow(options);
  if (['order-workflow-run', 'order-workflow-resume'].includes(options.command)) return runOrderWorkflow(await withPacer(options));
  if (options.command === 'layout-diagnosis') return layoutDiagnosis(options);
  if (options.command === 'layout-check') return checkSavedLayoutProposal(options);
  if (['task-run', 'task-resume', 'task-next-batch', 'task-rebind', 'task-diagnose'].includes(options.command)) {
    const saved = await loadTask(options.stateDirectory, options.task);
    if (saved.browser_session === 'dedicated') {
      const cached = ['task-run', 'task-resume', 'task-next-batch'].includes(options.command) &&
        ['complete', 'partial', 'stopped', 'ended'].includes(saved.status);
      if (!cached) requireLiveTaskChannel(saved);
      if (options.explicitEndpoint && options.bridge.endpoint !== saved.endpoint) throw new ShoppingError('BINDING_ENDPOINT_MISMATCH', 'Keep the cached task at its original endpoint.');
      // Terminal legacy tasks return their original cache without loading a browser-session record or issuing HTTP.
      options = { ...options, bridge: new BrowserBridge(saved.endpoint, { timeoutMs: options.bridge.timeoutMs }) };
    }
  }
  options = await withPacer(options);
  const { command, bridge } = options;
  if (command === 'page-open') return openPage(options);
  if (command === 'page-close') {
    if (options.tabId === undefined) throw new ShoppingError('INVALID_ARGUMENTS', 'Use page-close --tab ID.');
    return closeOpenedPage({ stateDirectory: options.stateDirectory, tabId: options.tabId, bridge });
  }
  if (command === 'task-start') return createTask(options);
  if (command === 'task-status') return taskStatus(options);
  if (command === 'task-diagnose') return diagnoseTask(options);
  if (command === 'task-rebind') return rebindTask(options);
  if (command === 'task-end') return endTask(options);
  if (command === 'task-run' || command === 'task-resume' || command === 'task-next-batch') return runTask({ ...options, onPlatformLimit: limitRecorder(options, await pacedPlatform(options)) });
  if (command === 'tabs') {
    await bridge.requireConnected();
    const summarize = { taobao: summarizeTab, jd: summarizeJdTab, pdd: summarizePddTab }[options.platform];
    return { ok: true, status: 'listed', platform: options.platform, inventory_scope: bridge.inventoryScope,
      tabs: (await bridge.listTabs()).map(summarize).filter(Boolean), login_verified: false };
  }
  const platform = await pacedPlatform(options);
  try {
    return command === 'bind' ? await bindTarget(options) : await probeTarget(options);
  } catch (error) {
    // A JD or PDD limit met while binding or probing is recorded like one met by a task.
    if (['jd', 'pdd'].includes(platform) && error.code === 'RATE_LIMITED') await limitRecorder(options, platform)({ signal: 'rate_limited', page_kind: 'product' });
    if (needsPageAssistance(error.code)) {
      // Finding the saved probe tab is also best-effort; it must not replace the original page failure.
      let tabId = options.tabId;
      if (command === 'probe') { try { tabId = (await loadBinding(options.stateDirectory, options.binding)).tab_id; } catch {} }
      await createBlockedPageDisplay(bridge)(tabId);
    }
    throw error;
  }
}

/**
 * Execute the portable command interface. Results and errors are one JSON object.
 * @param {string[]} argv CLI arguments without the Node executable and script.
 * @param {{write?: (text: string) => void, services?: {start: Function, stop: Function}, environment?: object}} io
 *   Output and offline hooks for service control, dependency preparation/inspection and token inspection.
 * @returns {Promise<number>} 0 for success, 2 for expected failures, 1 for internal failures.
 * @example await main(['doctor', '--json']);
 */
export async function main(argv, { write = text => process.stdout.write(text), services = { start: startBridgeService, stop: stopBridgeService },
  environment = {} } = {}) {
  let command = 'unknown';
  try {
    const options = optionsFrom(argv);
    if (options.help) { write(HELP); return 0; }
    command = options.command;
    const result = await execute(options, services, { inspectBackend: inspectPlaywrightBackend,
      prepareBackend: preparePlaywrightBackend, inspectToken: inspectExtensionToken, findProfiles: findExtensionProfiles,
      profileScanUnsupported: chromeUserDataDirectory() === null, openStore: openExtensionStore, saveToken: saveTokenFromClipboard, saveTokenWithDialog: saveTokenFromDialog, ...environment });
    write(`${JSON.stringify({ schema_version: 1, command, ...result }, null, 2)}\n`);
    return result.ok ? 0 : 2;
  } catch (error) {
    write(`${JSON.stringify({ schema_version: 1, command, ok: false, status: 'failed', error: publicError(error) }, null, 2)}\n`);
    return error instanceof ShoppingError ? 2 : 1;
  }
}
