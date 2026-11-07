import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ShoppingError } from './errors.mjs';
import { parseOrderDetailUrl, parseOrderListUrl } from './order-target.mjs';
import { parseCartUrl } from './cart-target.mjs';
import { parseProductUrl, parseTabId } from './targets.mjs';
import { jdPageStillMatches } from './jd/targets.mjs';
import { pddPageStillMatches } from './pdd/targets.mjs';
import { PLATFORMS } from './platforms.mjs';
import { loadTask } from './task-store.mjs';
import { readOrderWorkflow } from './order-workflow-store.mjs';
import { WORKFLOW_FINISHED } from './order-workflow-state.mjs';

const LEDGER_FILE = 'opened-pages.json';
const MAX_ENTRIES = 500;
const KINDS = new Set(['search', 'product', 'orders', 'cart']);
// Same rule as the platform lock: only these statuses release a task's pages.
const FINISHED = new Set(['complete', 'partial', 'ended']);

function invalidLedger() {
  return new ShoppingError('INVALID_OPENED_PAGES', 'The local record of opened pages is unreadable or inconsistent; nothing was closed.',
    'Inspect opened-pages.json in the state directory.');
}

function validEntry(entry) {
  const time = value => typeof value === 'string' && !Number.isNaN(Date.parse(value));
  try { parseTabId(entry?.tab_id); } catch { return false; }
  // Entries written before JD support have no platform field; they are Taobao pages.
  const legacy = !Object.hasOwn(entry, 'platform');
  return Object.keys(entry).length === (legacy ? 6 : 7) && (legacy || PLATFORMS.includes(entry.platform)) &&
    KINDS.has(entry.kind) && time(entry.opened_at) && typeof entry.url_matches === 'boolean' &&
    (entry.closed_at === null || time(entry.closed_at)) &&
    (['orders', 'cart'].includes(entry.kind) ? entry.key === null : typeof entry.key === 'string' && entry.key.length > 0 && entry.key.length <= 200);
}

async function loadLedger(stateDirectory) {
  let value;
  try { value = JSON.parse(await readFile(path.join(stateDirectory, LEDGER_FILE), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { schema_version: 1, pages: [] };
    throw invalidLedger();
  }
  if (value?.schema_version !== 1 || !Array.isArray(value.pages) || value.pages.length > MAX_ENTRIES || !value.pages.every(validEntry)) throw invalidLedger();
  return value;
}

async function saveLedger(stateDirectory, ledger) {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const file = path.join(stateDirectory, LEDGER_FILE), temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(ledger, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await rename(temporary, file);
}

/**
 * Whether a tab's current address still shows the page that was recorded, allowing later pages, sorting or tracking parameters.
 * @param {{platform?: 'taobao'|'jd'|'pdd', kind: 'search'|'product'|'orders'|'cart'|'order_detail', key: string|null}} page Taobao when platform is absent.
 * @param {string} url @returns {boolean}
 * @example pageStillMatches({ kind: 'search', key: '罗技 M330' }, 'https://s.taobao.com/search?q=罗技+M330&page=2') // true
 */
export function pageStillMatches(page, url) {
  if (page.platform === 'jd') return jdPageStillMatches(page, url);
  if (page.platform === 'pdd') return pddPageStillMatches(page, url);
  if (page.kind === 'product') return parseProductUrl(url)?.product_id === page.key;
  if (page.kind === 'orders') return parseOrderListUrl(url) !== null;
  if (page.kind === 'cart') return parseCartUrl(url) !== null;
  if (page.kind === 'order_detail') return parseOrderDetailUrl(url)?.order_id === page.key;
  try {
    const parsed = new URL(url);
    return parsed.origin === 'https://s.taobao.com' && parsed.pathname === '/search' && !parsed.username && !parsed.password &&
      parsed.searchParams.getAll('q').length === 1 && parsed.searchParams.get('q') === page.key;
  } catch { return false; }
}

/** @param {string} stateDirectory @returns {Promise<void>} @throws {ShoppingError} INVALID_OPENED_PAGES when the record cannot be extended. */
export async function checkOpenedPages(stateDirectory) {
  await loadLedger(stateDirectory);
}

/**
 * Remember a tab that page-open created, so page-close can later close it.
 * @param {string} stateDirectory @param {{tab_id: number, platform: 'taobao'|'jd', kind: string, url_matches: boolean}} opened
 * @param {string|null} key Query, product ID or null. @param {Date} [now] @returns {Promise<void>} @throws {ShoppingError} INVALID_OPENED_PAGES.
 */
export async function recordOpenedPage(stateDirectory, opened, key, now = new Date()) {
  const ledger = await loadLedger(stateDirectory);
  ledger.pages.push({ tab_id: opened.tab_id, platform: opened.platform, kind: opened.kind, key, opened_at: now.toISOString(),
    url_matches: opened.url_matches, closed_at: null });
  // Keep the newest records; dropping old ones only means very old tabs can no longer be closed by this command.
  ledger.pages = ledger.pages.slice(-MAX_ENTRIES);
  await saveLedger(stateDirectory, ledger);
}

/**
 * Decide whether a tab may be closed: it must have been opened by page-open or by an order entry task, and no unfinished task may use it.
 * @param {{tabId: number, pages: object[], tasks: object[], workflows?: object[]}} input Ledger pages, loaded tasks and order workflows.
 * @returns {{source: 'page_open'|'order_entry_task', platform: 'taobao'|'jd', kind: string, key: string|null, task?: string}}
 * @throws {ShoppingError} TAB_NOT_OPENED_BY_PROGRAM or TAB_IN_USE.
 */
export function closeDecision({ tabId, pages, tasks, workflows = [] }) {
  const user = tasks.find(task => !FINISHED.has(task.status) &&
    task.operations.some(op => op.tab_id === tabId || op.order_detail_check?.detail_tab_id === tabId))
    // A workflow holds its list tab before it creates any subtask.
    ?? workflows.find(workflow => !WORKFLOW_FINISHED.includes(workflow.status) && workflow.tab_id === tabId);
  if (user) {
    throw new ShoppingError('TAB_IN_USE', `The unfinished task ${user.id} still uses this tab; nothing was closed.`,
      'Finish or end that task first, or leave the tab open.');
  }
  const recorded = pages.filter(page => page.tab_id === tabId && page.closed_at === null).at(-1);
  if (recorded) return { source: 'page_open', platform: recorded.platform ?? 'taobao', kind: recorded.kind, key: recorded.key };
  const entry = tasks.filter(task => task.kind === 'order_detail_check' && task.operations[0].order_detail_check?.detail_tab_id === tabId)
    .sort((a, b) => a.updated_at.localeCompare(b.updated_at)).at(-1);
  if (entry) return { source: 'order_entry_task', platform: 'taobao', kind: 'order_detail', key: entry.operations[0].target.order_id, task: entry.id };
  throw new ShoppingError('TAB_NOT_OPENED_BY_PROGRAM', 'This tab was not opened by page-open or an order entry task in this state directory; nothing was closed.',
    'Close it yourself in the browser if it is no longer needed.');
}

async function savedNames(directory) {
  try { return (await readdir(directory)).filter(file => /^[a-z0-9][a-z0-9_-]*\.json$/.test(file)).map(file => file.slice(0, -'.json'.length)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

// A task or workflow that cannot be read could still be using the tab, so its error stops the close.
async function loadAll(stateDirectory) {
  const tasks = [], workflows = [];
  for (const name of await savedNames(path.join(stateDirectory, 'tasks'))) tasks.push(await loadTask(stateDirectory, name));
  for (const name of await savedNames(path.join(stateDirectory, 'order-workflows'))) workflows.push(await readOrderWorkflow(stateDirectory, name));
  return { tasks, workflows };
}

/**
 * Close one tab that this program opened, after checking its record, current use and current address.
 * @param {{stateDirectory: string, tabId: number, bridge: object, now?: Date}} options
 * @returns {Promise<{ok: true, status: 'page_closed', tab_id: number, platform: string, kind: string, source: string, task?: string}>} No URL is returned.
 * @throws {ShoppingError} TAB_NOT_OPENED_BY_PROGRAM, TAB_IN_USE, TARGET_MISSING, TAB_ADDRESS_CHANGED, INVALID_OPENED_PAGES or bridge errors.
 * @example await closeOpenedPage({ stateDirectory, tabId: 123, bridge });
 */
export async function closeOpenedPage({ stateDirectory, tabId, bridge, now = new Date() }) {
  const ledger = await loadLedger(stateDirectory);
  const decision = closeDecision({ tabId, pages: ledger.pages, ...(await loadAll(stateDirectory)) });
  await bridge.closeTab(tabId, url => pageStillMatches(decision, url));
  if (decision.source === 'page_open') {
    const latest = await loadLedger(stateDirectory);
    const page = latest.pages.filter(item => item.tab_id === tabId && item.closed_at === null).at(-1);
    if (page) { page.closed_at = now.toISOString(); await saveLedger(stateDirectory, latest); }
  }
  return { ok: true, status: 'page_closed', tab_id: tabId, platform: decision.platform, kind: decision.kind, source: decision.source,
    ...(decision.task ? { task: decision.task } : {}) };
}
