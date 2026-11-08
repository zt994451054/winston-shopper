import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ShoppingError } from './errors.mjs';
import { CONNECT_FAILED_ACTION, PLAYWRIGHT_BACKEND_DIRECTORY, readExtensionToken } from './playwright-config.mjs';

export { PLAYWRIGHT_BACKEND_DIRECTORY, readExtensionToken } from './playwright-config.mjs';

const RUN_TOOL = 'browser_run_code_unsafe';
const MCP_PROTOCOL_VERSION = '2025-06-18';
const MCP_CALL_TIMEOUT_MS = 60000;
const MAX_BODY_BYTES = 1048576;
// The extension makes its connect tab active just after connecting; a tab opened sooner stayed hidden behind it (2026-11-03).
const CONNECT_SETTLE_MS = 5000;
const STOP_TIMEOUT_MS = 5000;
const MCP_STOP_TIMEOUT_MS = 3000;
const PLAYWRIGHT_VERSION = '1.65.0-alpha-2026-10-30';
const SERVICE_SCRIPT = fileURLToPath(new URL('../scripts/playwright-service.mjs', import.meta.url));
const COMMANDS = Object.freeze(['tab_list', 'tab_new', 'tab_close', 'eval', 'snapshot', 'tab_show', 'hover', 'click', 'fill']);
const ACTION_TIMEOUT_MS = 4000;
const POINTER_TIMEOUT_MS = 12000;
const SHOW_SETTLE_MS = 3000;
const OPEN_TIMEOUT_MS = 25000;
const INTERACTIVE_ROLES = new Set(['button', 'checkbox', 'combobox', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'option', 'radio', 'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'textbox', 'treeitem']);

const connectionError = () => new ShoppingError('EXTENSION_DISCONNECTED', 'The original Playwright connection ended. No new connection was opened.',
  'Inspect the original browser and task before explicitly restarting the service. Restarting may lose the saved page associations.');
const stoppingError = () => new ShoppingError('SERVICE_STOPPING', 'The Playwright service is stopping; no new command was dispatched.');

async function settlesWithin(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([Promise.resolve(promise).then(() => true, () => false),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
  } finally { clearTimeout(timer); }
}

/**
 * Read the JSON string a run-code call returned. Its result is one JSON-encoded line, so page text cannot fake a section.
 * @param {string} text Tool output. @returns {unknown} The decoded value.
 * @throws {ShoppingError} INVALID_RESPONSE when the section is missing or malformed.
 */
export function parseRunResult(text) {
  const lines = String(text).split('\n');
  const index = lines.indexOf('### Result');
  try {
    if (index >= 0) return JSON.parse(JSON.parse(lines[index + 1]));
  } catch { /* Reported below without the page's text. */ }
  throw new ShoppingError('INVALID_RESPONSE', 'The browser connection returned an unreadable result.');
}

/**
 * Turn an accessibility snapshot into the interactive references the bridge validates.
 * @param {string} text Lines such as `- tab "价格" [ref=e2]`. @param {number} [maxDepth] Deepest nesting to keep.
 * @returns {Record<string, {role: string, name: string, backendDOMNodeId: number}>} `backendDOMNodeId` is the reference's
 *   number: callers only require a positive integer, and Playwright exposes no DOM node ID.
 */
export function parseAriaReferences(text, maxDepth = Number.POSITIVE_INFINITY) {
  const references = {};
  for (const line of String(text).split('\n')) {
    const match = /^(\s*)- ([a-z]+)(?: "((?:[^"\\]|\\.)*)")?.*\[ref=(e(\d+))\]/.exec(line);
    if (!match || !INTERACTIVE_ROLES.has(match[2]) || match[1].length / 2 > maxDepth) continue;
    let name = match[3] ?? '';
    try { name = JSON.parse(`"${name}"`); } catch { /* Keep the raw text; validators compare it exactly. */ }
    references[match[4]] = { role: match[2], name, backendDOMNodeId: Number(match[5]) };
  }
  return references;
}

// IDs live on the Page objects because a run-code call's globals do not survive to the next call (2026-11-03).
// PDD's order list replaced its page object a few seconds after opening, so its ID changed and the task lost the page
// (2026-11-04, 2026-11-07). A page that appears within REPLACED_PAGE_MS after a page on the same site closed by itself
// keeps that page's ID. Pages the service opens or closes never take part, so a closed task tab is never reused.
// The window is measured from when the page appeared, not from when a command first lists it: on 2026-11-08 a caller
// talked to the user for two minutes after opening the list, and the page, replaced within seconds, got a new ID.
export const REPLACED_PAGE_MS = 30_000;
export const pageCode = (firstTabId, body) => `async page => {
  const context = page.context();
  context.__shopperNextTabId ??= ${firstTabId};
  if (!context.__shopperWatching) {
    context.__shopperWatching = true;
    context.on('page', item => { item.__shopperAppearedAt ??= Date.now(); });
  }
  const originOf = item => { try { return new URL(item.url()).origin; } catch { return null; } };
  const label = (item, fresh = false) => {
    if (item.__shopperTabId !== undefined) return item;
    const gone = context.__shopperReplaced, origin = originOf(item);
    // The replacement may appear just before or just after the old page closes.
    const appearedAt = item.__shopperAppearedAt ?? Date.now();
    const inherits = !fresh && gone && gone.origin === origin && Math.abs(appearedAt - gone.at) < ${REPLACED_PAGE_MS}
      && !context.pages().some(other => other.__shopperTabId === gone.id);
    item.__shopperTabId = inherits ? gone.id : context.__shopperNextTabId++;
    if (inherits) context.__shopperReplaced = null;
    item.once?.('close', () => {
      if (!item.__shopperClosedByService) context.__shopperReplaced = { id: item.__shopperTabId, origin: originOf(item), at: Date.now() };
    });
    return item;
  };
  const listed = () => context.pages().filter(item => /^https?:/.test(item.url())).map(label);
  const tab = id => { const found = listed().find(item => item.__shopperTabId === id); if (!found) throw new Error('tab not found'); return found; };
  ${body}
}`;

/** One explicit connection and a queue of fixed commands; a lost connection is never replaced. */
export class PlaywrightService {
  #tools; #firstTabId; #settleMs; #wait; #queue = Promise.resolve(); #references = new Map();
  #state = 'starting'; #errorCode = null; #connectPromise; #stopPromise; #unsubscribe;
  #instanceId; #stopTimeoutMs; #abort = new AbortController(); #connectionLost = false; #attached = false; #onDisconnected;

  /**
   * @param {{tools?: object, firstTabId?: number, settleMs?: number, wait?: Function, instanceId?: string, stopTimeoutMs?: number,
   *   onDisconnected?: Function}} options
   *   `firstTabId` keeps IDs from one service run from matching tabs saved by an earlier one. `onDisconnected` runs once when a
   *   ready or starting service loses the extension, so the lifecycle log shows when it happened.
   */
  constructor({ tools, firstTabId = Math.floor(Date.now() / 1000), settleMs = CONNECT_SETTLE_MS, wait = delay,
    instanceId = randomUUID(), stopTimeoutMs = STOP_TIMEOUT_MS, onDisconnected = () => {} } = {}) {
    this.#firstTabId = firstTabId; this.#settleMs = settleMs; this.#wait = wait;
    this.#instanceId = instanceId; this.#stopTimeoutMs = stopTimeoutMs; this.#onDisconnected = onDisconnected;
    if (tools) this.attachTools(tools);
  }

  get connected() { return this.#state === 'ready'; }
  get state() { return this.#state; }

  /** @returns {object} Safe local state only; does not call MCP, inspect pages or reconnect. */
  status() {
    return { running: this.#state !== 'stopped', extensionConnected: this.connected, backend: 'playwright-extension',
      protocol_version: 1, instance_id: this.#instanceId, state: this.#state, error_code: this.#errorCode,
      mcp_running: this.#tools?.alive ?? false, capabilities: [...COMMANDS] };
  }

  /**
   * Attach the initialized child after the HTTP listener owns its port.
   * @param {object} tools MCP calls, stop and optional disconnect subscription.
   * @returns {void} @throws {ShoppingError} SERVICE_STOPPING or INVALID_ARGUMENTS.
   */
  attachTools(tools) {
    if (this.#state !== 'starting') throw stoppingError();
    if (this.#tools || typeof tools?.call !== 'function' || typeof tools.stop !== 'function') {
      throw new ShoppingError('INVALID_ARGUMENTS', 'Attach one initialized Playwright child only.');
    }
    this.#tools = tools;
    this.#unsubscribe = tools.onDisconnect?.(() => this.disconnect());
    if (tools.closed) this.disconnect();
  }

  /** @returns {void} Latch a connection loss; later commands cannot cause a reconnect. */
  disconnect() {
    this.#connectionLost = true;
    if (['stopping', 'stopped', 'failed', 'disconnected'].includes(this.#state)) return;
    this.#state = 'disconnected'; this.#errorCode = 'EXTENSION_DISCONNECTED';
    this.#abort.abort();
    this.#onDisconnected();
  }

  /** @param {string} code A fixed local error code. @returns {void} Record a startup failure without external text. */
  fail(code) {
    if (['stopping', 'stopped'].includes(this.#state)) return;
    this.#state = 'failed'; this.#errorCode = code;
  }

  /**
   * Connect once and wait for the extension's activation to settle. Repeated calls share that attempt.
   * @returns {Promise<void>} @throws {ShoppingError} PLAYWRIGHT_CONNECT_FAILED, EXTENSION_DISCONNECTED or SERVICE_STOPPING.
   */
  connect() {
    if (['disconnected', 'stopping', 'stopped'].includes(this.#state)) return Promise.reject(this.#unavailableError());
    if (this.#connectPromise) return this.#connectPromise;
    if (this.#state !== 'starting' || !this.#tools) return Promise.reject(this.#unavailableError());
    this.#state = 'connecting';
    this.#connectPromise = (async () => {
      try {
        await this.#tools.call('browser_tabs', { action: 'list' });
        this.#attached = true;
        await this.#wait(this.#settleMs, { signal: this.#abort.signal });
        if (this.#state !== 'connecting') throw this.#unavailableError();
        this.#state = 'ready';
      } catch {
        if (['stopping', 'stopped'].includes(this.#state)) throw stoppingError();
        if (this.#state === 'disconnected') throw connectionError();
        this.fail('PLAYWRIGHT_CONNECT_FAILED');
        throw new ShoppingError('PLAYWRIGHT_CONNECT_FAILED', 'The first Playwright extension connection attempt failed. It was not retried.',
          CONNECT_FAILED_ACTION);
      }
    })();
    return this.#connectPromise;
  }

  #unavailableError() {
    if (['stopping', 'stopped'].includes(this.#state)) return stoppingError();
    if (this.#state === 'disconnected') return connectionError();
    return new ShoppingError('SERVICE_NOT_READY', 'The Playwright service is not ready; no page command was dispatched.',
      'Wait for startup and inspect service status. Status checks do not reconnect.');
  }

  async #run(body) {
    let result;
    try { result = await this.#tools.call(RUN_TOOL, { code: pageCode(this.#firstTabId, body) }); }
    catch (error) {
      if (['EXTENSION_DISCONNECTED', 'MCP_DISCONNECTED', 'MCP_TIMEOUT', 'MCP_PROTOCOL_ERROR'].includes(error.code)) {
        this.disconnect(); throw connectionError();
      }
      throw new ShoppingError('BROWSER_COMMAND_FAILED', 'The browser could not complete the fixed command. External details were withheld.');
    }
    try { return parseRunResult(result); }
    catch (error) { this.fail('INVALID_RESPONSE'); throw error; }
  }

  #reference(tabId, ref) {
    const found = this.#references.get(tabId)?.[ref];
    if (!found) throw new ShoppingError('TARGET_CHANGED', 'The element reference is not from this tab\'s latest snapshot.');
    return found;
  }

  #locate(tabId, ref) {
    this.#reference(tabId, ref);
    return `tab(${tabId}).locator(${JSON.stringify(`aria-ref=${ref}`)})`;
  }

  async #dispatch(action, fields) {
    const { tabId, ref, url, script, selector, text, maxDepth } = fields;
    if (action !== 'tab_list' && action !== 'tab_new' && !(Number.isSafeInteger(tabId) && tabId > 0)) {
      throw new ShoppingError('INVALID_ARGUMENTS', 'The command needs an explicit tab ID.');
    }
    switch (action) {
      case 'tab_list':
        return { tabs: await this.#run(`return JSON.stringify(listed().map(item => ({ id: item.__shopperTabId, url: item.url() })));`) };
      case 'tab_new':
        if (!/^https?:\/\//.test(String(url))) throw new ShoppingError('INVALID_ARGUMENTS', 'Only web pages can be opened.');
        return this.#run(`const opened = label(await context.newPage(), true);
  await opened.goto(${JSON.stringify(url)}, { waitUntil: 'domcontentloaded', timeout: ${OPEN_TIMEOUT_MS} });
  return JSON.stringify({ tabId: opened.__shopperTabId, url: opened.url() });`);
      case 'tab_close':
        await this.#run(`const closing = tab(${tabId}); closing.__shopperClosedByService = true; await closing.close(); return JSON.stringify(true);`);
        this.#references.delete(tabId);
        return {};
      case 'eval':
        if (typeof script !== 'string') throw new ShoppingError('INVALID_ARGUMENTS', 'The command needs a script.');
        return { result: (await this.#run(`const value = await tab(${tabId}).evaluate(${JSON.stringify(script)}); return JSON.stringify({ value: value ?? null });`)).value };
      case 'snapshot': {
        if (typeof selector !== 'string') throw new ShoppingError('INVALID_ARGUMENTS', 'The command needs a selector.');
        const shot = await this.#run(`const item = tab(${tabId});
  const text = await item.locator(${JSON.stringify(selector)}).first().ariaSnapshot({ mode: 'ai', timeout: ${ACTION_TIMEOUT_MS} });
  return JSON.stringify({ url: item.url(), text });`);
        const refs = parseAriaReferences(shot.text, maxDepth);
        this.#references.set(tabId, refs);
        return { url: shot.url, snapshotData: { refs } };
      }
      case 'tab_show':
        // Only an already blocked task or a committed user pause may request this command.
        return { visible: await this.#run(`const item = tab(${tabId});
  if (await item.evaluate(() => document.visibilityState) === 'hidden') await item.bringToFront();
  // The page reports the change a moment after the tab is activated: read right away, a raised JD page still said hidden (2026-11-04).
  for (let wait = 0; wait < ${SHOW_SETTLE_MS}; wait += 200) {
    if (await item.evaluate(() => document.visibilityState) === 'visible') return JSON.stringify(true);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return JSON.stringify(await item.evaluate(() => document.visibilityState) === 'visible');`) };
      case 'hover':
        // A real pointer needs a painted page: a hidden one never opened Taobao's price menu (2026-11-03). The user allows
        // the window to come forward only when the program is blocked, so it is raised here and for tab_show, nowhere else.
        await this.#run(`const item = tab(${tabId});
  if (await item.evaluate(() => document.visibilityState) === 'hidden') await item.bringToFront();
  await ${this.#locate(tabId, ref)}.hover({ timeout: ${POINTER_TIMEOUT_MS} }); return JSON.stringify(true);`);
        return { ...this.#reference(tabId, ref) };
      case 'click':
        await this.#run(`await ${this.#locate(tabId, ref)}.click({ timeout: ${ACTION_TIMEOUT_MS} }); return JSON.stringify(true);`);
        return { ...this.#reference(tabId, ref) };
      case 'fill': {
        if (typeof text !== 'string') throw new ShoppingError('INVALID_ARGUMENTS', 'The command needs text.');
        const locator = this.#locate(tabId, ref);
        const filledText = await this.#run(`await ${locator}.fill(${JSON.stringify(text)}, { timeout: ${ACTION_TIMEOUT_MS} }); return JSON.stringify(await ${locator}.inputValue());`);
        return { ...this.#reference(tabId, ref), filledText };
      }
      default:
        throw new ShoppingError('INVALID_ARGUMENTS', 'The command is not one of the fixed browser commands.');
    }
  }

  /**
   * Run one command after the ones before it; nothing is retried, since a failed action may already have reached the page.
   * @param {string} action @param {object} fields @returns {Promise<object>} The reply data the bridge expects.
   * @throws {Error} Whatever the browser reported; the HTTP layer withholds the text.
   */
  command(action, fields = {}) {
    if (!this.connected) return Promise.reject(this.#unavailableError());
    const result = this.#queue.then(() => {
      if (!this.connected) throw this.#unavailableError();
      return this.#dispatch(action, fields);
    });
    this.#queue = result.catch(() => {});
    return result;
  }

  /**
   * Drain in-flight work within a deadline, close only the connect page, then stop the child. Shopping tabs stay open.
   * @returns {Promise<void>} @throws {ShoppingError} MCP_STOP_FAILED when the owned child cannot confirm exit.
   */
  stop() {
    if (this.#stopPromise) return this.#stopPromise;
    const wasConnected = this.#attached;
    this.#state = 'stopping'; this.#abort.abort();
    this.#stopPromise = (async () => {
      try {
        const drained = await settlesWithin(this.#queue, this.#stopTimeoutMs);
        if (drained && wasConnected && !this.#connectionLost) {
          await settlesWithin(this.#run(`await Promise.all(context.pages().filter(item => item.url().startsWith('chrome-extension://') && new URL(item.url()).pathname === '/connect.html').map(item => item.close())); return JSON.stringify(true);`), this.#stopTimeoutMs);
        }
      } finally {
        this.#unsubscribe?.(); this.#references.clear();
        try { await this.#tools?.stop(); }
        finally { this.#state = 'stopped'; }
      }
    })();
    return this.#stopPromise;
  }
}

/**
 * Create the pinned MCP factory with a one-attempt gate. Upstream clears its backend on disconnect and otherwise
 * creates another on the next tool call (0.0.84); the gate must live in that same process to avoid a notification race.
 * @param {{backend: object, config: object, options: object, onDisconnect?: Function}} options Pinned backend exports.
 * @returns {object} The MCP backend factory. @throws {ShoppingError} EXTENSION_DISCONNECTED on a second creation.
 */
export function singleConnectionFactory({ backend, config, options, onDisconnect = () => {} }) {
  const tools = backend.filteredTools(config);
  let attempted = false;
  return {
    name: 'consumer-shopping', nameInConfig: 'consumer-shopping', version: PLAYWRIGHT_VERSION,
    toolSchemas: tools.map(tool => tool.schema), ignoreRoots: true,
    async create(clientInfo) {
      if (attempted) throw connectionError();
      attempted = true;
      const info = await backend.createBrowserWithInfo(config, clientInfo, options,
        { title: clientInfo.clientName, workspaceDir: clientInfo.cwd });
      try {
        const context = config.browser.isolated ? await info.browser.newContext(config.browser.contextOptions) : info.browser.contexts()[0];
        if (!context) throw new ShoppingError('MCP_PROTOCOL_INCOMPATIBLE', 'The pinned backend supplied no browser context.');
        const result = new backend.BrowserBackend(config, context, tools, {
          idleTimer: info.idleTimer,
          // An attached Chrome belongs to the user: terminating our child disconnects the relay without closing Chrome.
          dispose: info.ownership === 'attached' ? undefined : () => info.browser.close(),
        });
        result.once('disconnected', onDisconnect);
        return result;
      } catch (error) {
        if (info.ownership !== 'attached') await info.browser.close().catch(() => {});
        throw error;
      }
    },
  };
}

/**
 * Run the private child adapter using pinned exports; never edit third-party files or poll by reopening a connection.
 * @param {string[]} args Only the extension/profile or local isolated headless arguments used by this service.
 * @param {{directory?: string, loadBackend?: Function, notify?: Function}} [dependencies] Offline-test hooks.
 * @returns {Promise<void>} @throws {ShoppingError} INVALID_ARGUMENTS, BACKEND_MISSING or MCP_PROTOCOL_INCOMPATIBLE.
 */
export async function runMcpChild(args, { directory = PLAYWRIGHT_BACKEND_DIRECTORY,
  loadBackend = root => createRequire(path.join(root, 'package.json'))('playwright-core/lib/coreBundle').tools,
  notify = message => { if (process.connected) process.send(message, () => {}); } } = {}) {
  let values;
  try {
    const parsed = parseArgs({ args, options: { extension: { type: 'boolean' }, 'profile-dir-name': { type: 'string' },
      browser: { type: 'string' }, headless: { type: 'boolean' }, isolated: { type: 'boolean' } } });
    values = parsed.values;
    if (values.extension ? !values['profile-dir-name'] || values.headless || values.isolated
      : values.browser !== 'chrome' || !values.headless || !values.isolated) throw new Error();
  } catch { throw new ShoppingError('INVALID_ARGUMENTS', 'Use an explicit extension profile or the local isolated headless mode.'); }
  let backend;
  try { backend = loadBackend(directory); }
  catch { throw new ShoppingError('BACKEND_MISSING', 'The pinned Playwright backend is not installed.'); }
  if (['filteredTools', 'createBrowserWithInfo', 'BrowserBackend', 'resolveCLIConfigForMCP', 'start'].some(name => typeof backend?.[name] !== 'function')) {
    throw new ShoppingError('MCP_PROTOCOL_INCOMPATIBLE', 'The pinned Playwright backend does not expose the required adapter interface.');
  }
  const options = { extension: values.extension ?? false, profileDirName: values['profile-dir-name'], browser: values.browser,
    headless: values.headless ?? false, isolated: values.isolated ?? false };
  backend.setupExitWatchdog?.();
  const config = await backend.resolveCLIConfigForMCP(options);
  await backend.start(singleConnectionFactory({ backend, config, options,
    onDisconnect: () => notify({ type: 'shopper_browser_disconnected' }) }));
}

/**
 * Start one owned MCP child with line-delimited JSON-RPC and a private IPC disconnect notification.
 * @param {string[]} args Browser-selection arguments; the extension token is passed only in env.
 * @param {{env?: object, directory?: string, onExit?: Function, signal?: AbortSignal, spawnProcess?: Function,
 *   callTimeoutMs?: number, stopTimeoutMs?: number}} [options] Process and timeout hooks allow synthetic children.
 * @returns {Promise<object>} Safe call/stop methods, alive/closed flags and onDisconnect subscription.
 * @throws {ShoppingError} BACKEND_MISSING, MCP_PROTOCOL_INCOMPATIBLE, MCP_PROTOCOL_ERROR, MCP_TIMEOUT or MCP_DISCONNECTED.
 */
export async function startMcpTools(args, { env = {}, directory = PLAYWRIGHT_BACKEND_DIRECTORY, onExit = () => {}, signal,
  spawnProcess = spawn, callTimeoutMs = MCP_CALL_TIMEOUT_MS, stopTimeoutMs = MCP_STOP_TIMEOUT_MS } = {}) {
  if (signal?.aborted) throw stoppingError();
  let child;
  try {
    child = spawnProcess(process.execPath, [SERVICE_SCRIPT, '--mcp-child', ...args], {
      cwd: directory, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'ignore', 'ipc'], windowsHide: true,
    });
  } catch { throw new ShoppingError('BACKEND_MISSING', 'The Playwright child could not be started.'); }
  const pending = new Map(), listeners = new Set();
  let nextId = 1, closed = false, exited = false, stopping = false, stopPromise;
  let resolveExit;
  const exitPromise = new Promise(resolve => { resolveExit = resolve; });
  const reader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const fail = code => {
    if (closed) return;
    closed = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new ShoppingError(code, 'The original MCP connection cannot continue. No command was retried.'));
    }
    pending.clear();
    for (const listener of listeners) listener(code);
  };
  const onEnded = () => {
    if (exited) return;
    exited = true; resolveExit(); fail('MCP_DISCONNECTED'); onExit();
  };
  const onMessage = message => { if (message?.type === 'shopper_browser_disconnected') fail('EXTENSION_DISCONNECTED'); };
  const onInputError = () => fail('MCP_DISCONNECTED');
  const onOutputEnd = () => fail('MCP_DISCONNECTED');
  child.once('exit', onEnded); child.once('error', onEnded);
  child.on('message', onMessage); child.stdin.on('error', onInputError);
  child.stdout.on('end', onOutputEnd); child.stdout.on('error', onOutputEnd);
  reader.on('line', line => {
    if (closed) return;
    let message;
    try { message = JSON.parse(line); } catch { fail('MCP_PROTOCOL_ERROR'); return; }
    if (!message || message.jsonrpc !== '2.0' || typeof message !== 'object') { fail('MCP_PROTOCOL_ERROR'); return; }
    if (!Object.hasOwn(message, 'id')) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer); pending.delete(message.id);
    if (message.error) entry.reject(new ShoppingError('MCP_REQUEST_FAILED', 'The MCP child rejected the fixed request. External details were withheld.'));
    else if (!Object.hasOwn(message, 'result')) { entry.reject(new ShoppingError('MCP_PROTOCOL_ERROR', 'The MCP reply has no result.')); fail('MCP_PROTOCOL_ERROR'); }
    else entry.resolve(message.result);
  });
  const write = message => {
    if (closed || stopping) throw new ShoppingError('MCP_DISCONNECTED', 'The original MCP child is no longer available.');
    try { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`, error => { if (error) fail('MCP_DISCONNECTED'); }); }
    catch { fail('MCP_DISCONNECTED'); throw new ShoppingError('MCP_DISCONNECTED', 'The MCP request could not be written.'); }
  };
  const send = (method, params) => new Promise((resolve, reject) => {
    if (closed || stopping) { reject(new ShoppingError('MCP_DISCONNECTED', 'The original MCP child is no longer available.')); return; }
    const id = nextId++;
    const timer = setTimeout(() => fail('MCP_TIMEOUT'), callTimeoutMs);
    pending.set(id, { resolve, reject, timer });
    try { write({ id, method, params }); } catch { fail('MCP_DISCONNECTED'); }
  });
  const stop = () => {
    if (stopPromise) return stopPromise;
    stopping = true; fail('MCP_DISCONNECTED');
    stopPromise = (async () => {
      try {
        if (!exited) child.kill('SIGTERM');
        if (!await settlesWithin(exitPromise, stopTimeoutMs)) {
          child.kill('SIGKILL');
          if (!await settlesWithin(exitPromise, stopTimeoutMs)) {
            throw new ShoppingError('MCP_STOP_FAILED', 'The owned MCP child did not confirm exit after termination.');
          }
        }
      } finally {
        signal?.removeEventListener('abort', onAbort);
        reader.close(); child.stdin.destroy(); child.stdout.destroy();
        child.removeListener('message', onMessage);
        child.stdin.removeListener('error', onInputError);
        child.stdout.removeListener('end', onOutputEnd); child.stdout.removeListener('error', onOutputEnd);
        listeners.clear();
      }
    })();
    return stopPromise;
  };
  const onAbort = () => { void stop().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const initialized = await send('initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {},
      clientInfo: { name: 'consumer-shopping', version: '1' } });
    if (initialized?.protocolVersion !== MCP_PROTOCOL_VERSION || !initialized.capabilities?.tools || typeof initialized.capabilities.tools !== 'object') {
      throw new ShoppingError('MCP_PROTOCOL_INCOMPATIBLE', 'The MCP child negotiated an unsupported protocol or capabilities.');
    }
    write({ method: 'notifications/initialized' });
    const inventory = await send('tools/list', {});
    if (!Array.isArray(inventory?.tools) || ![RUN_TOOL, 'browser_tabs'].every(name => inventory.tools.some(tool => tool?.name === name))) {
      throw new ShoppingError('MCP_PROTOCOL_INCOMPATIBLE', 'The MCP child does not expose the required fixed tools.');
    }
    return {
      get alive() { return !exited; }, get closed() { return closed; },
      onDisconnect(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      async call(name, input) {
        if (name !== RUN_TOOL && !(name === 'browser_tabs' && input?.action === 'list')) {
          throw new ShoppingError('INVALID_ARGUMENTS', 'Only the fixed run-code and initial tab-list tools are supported.');
        }
        const result = await send('tools/call', { name, arguments: input });
        if (!result || !Array.isArray(result.content) || result.content.some(item => !item || typeof item !== 'object')) {
          fail('MCP_PROTOCOL_ERROR'); throw new ShoppingError('MCP_PROTOCOL_ERROR', 'The MCP tool reply has an invalid shape.');
        }
        if (result.isError) throw new ShoppingError('BROWSER_COMMAND_FAILED', 'The MCP browser command failed. External details were withheld.');
        return result.content.map(item => typeof item.text === 'string' ? item.text : '').join('\n');
      },
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

const readBody = async request => {
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

/**
 * Build the bounded HTTP handler separately so offline tests can drive it without a listening socket.
 * @param {PlaywrightService} service @param {Function} address Current listener address.
 * @param {string} host Loopback host.
 * @param {{management?: object, onShutdown?: Function, onStopError?: Function}} [options] Private managed-stop identity and callbacks.
 * @returns {Function} The HTTP request handler; credentials never enter replies.
 */
export function bridgeProtocolHandler(service, address, host = '127.0.0.1', { management, onShutdown, onStopError = () => {} } = {}) {
  return async (request, response) => {
    const reply = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
    const { port } = address();
    if (request.headers.origin !== undefined || request.headers.host !== `${host}:${port}`) return reply(403, {});
    if (request.method === 'GET' && request.url === '/status') return reply(200, { ...service.status(),
      ...(management ? { managed: true, install_id: management.installId, pid: management.pid } : {}) });
    if (request.method === 'POST' && request.url === '/shutdown' && management && request.headers['content-type'] === 'application/json') {
      let body;
      try { body = await readBody(request); } catch { return reply(400, {}); }
      if (!body || body.instance_id !== management.instanceId || typeof body.management_key !== 'string' ||
          !/^[a-f0-9]{64}$/.test(body.management_key) || !timingSafeEqual(Buffer.from(body.management_key), Buffer.from(management.key))) {
        return reply(403, {});
      }
      reply(200, { stopping: true, instance_id: management.instanceId });
      queueMicrotask(() => { void Promise.resolve().then(onShutdown).catch(onStopError); });
      return;
    }
    if (request.method !== 'POST' || request.url !== '/command' || request.headers['content-type'] !== 'application/json') return reply(404, {});
    let body;
    try { body = await readBody(request); } catch { return reply(400, {}); }
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.id !== 'string' || body.id.length > 128 || typeof body.action !== 'string') {
      return reply(400, {});
    }
    const { id, action, ...fields } = body;
    try { reply(200, { id, success: true, data: await service.command(action, fields) }); }
    catch (error) {
      const code = error instanceof ShoppingError ? error.code : 'BROWSER_COMMAND_FAILED';
      // Keep the existing generic page-failure envelope; lifecycle failures carry a fixed, actionable code.
      reply(200, { id, success: false, ...(['SERVICE_NOT_READY', 'SERVICE_STOPPING', 'EXTENSION_DISCONNECTED'].includes(code) ? { error: { code } } : {}) });
    }
  };
}

/**
 * Serve the bridge's `/status` and `/command` on loopback. Web pages are refused: they send an Origin or another Host,
 * and this port can run scripts on logged-in tabs.
 * @param {PlaywrightService} service @param {{port: number, host?: string, management?: object, onShutdown?: Function, onStopError?: Function}} options
 * @returns {Promise<http.Server>} The listening server.
 */
export async function serveBridgeProtocol(service, { port, host = '127.0.0.1', management, onShutdown, onStopError }) {
  if (!['127.0.0.1', '::1'].includes(host) || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ShoppingError('INVALID_ARGUMENTS', 'Use a loopback host and a valid service port.');
  }
  const server = http.createServer(bridgeProtocolHandler(service, () => server.address(), host === '::1' ? '[::1]' : host,
    { management, onShutdown, onStopError }));
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  } catch (error) {
    server.close();
    throw new ShoppingError(error.code === 'EADDRINUSE' ? 'BRIDGE_PORT_IN_USE' : 'BRIDGE_LISTEN_FAILED',
      'The local Playwright service could not bind its selected port. No browser connection was attempted.');
  }
  return server;
}

/**
 * Bind first, initialize one child and connect once; signal handlers release only resources owned by this startup.
 * @param {{port?: number, host?: string, profile?: string, tokenFile?: string, localHeadless?: boolean, management?: object}} options Service options.
 * @param {{listen?: Function, startTools?: Function, readToken?: Function, signals?: object, serviceOptions?: object,
 *   onStopError?: Function, onStopping?: Function, onStopped?: Function}} [dependencies]
 *   Offline hooks must not start a real browser or installer.
 * @returns {Promise<{service: PlaywrightService, server: object, stop: Function}>} A ready service and idempotent shutdown.
 * @throws {ShoppingError} Invalid options, token, listener, MCP or first-connection failure, with fixed messages.
 */
export async function startPlaywrightService({ port = 19825, host = '127.0.0.1', profile, tokenFile, localHeadless = false, management } = {},
  { listen = serveBridgeProtocol, startTools = startMcpTools, readToken = readExtensionToken, signals = process, serviceOptions = {},
    onStopping = async () => {}, onStopped = async () => {},
    onStopError = () => { process.stderr.write('MCP_STOP_FAILED The service could not finish shutdown.\n'); process.exitCode = 1; } } = {}) {
  if (!['127.0.0.1', '::1'].includes(host) || typeof localHeadless !== 'boolean' || !Number.isInteger(port) || port < 0 || port > 65535 ||
      (!localHeadless && (typeof profile !== 'string' || !profile.trim() || ['.', '..'].includes(profile) || /[\\/\u0000-\u001f]/.test(profile)))) {
    throw new ShoppingError('INVALID_ARGUMENTS', 'Supply a valid local port and an explicit Chrome profile directory name.');
  }
  if (management && (management.instanceId !== serviceOptions.instanceId || typeof management.installId !== 'string' ||
      typeof management.key !== 'string' || !/^[a-f0-9]{64}$/.test(management.key) || !Number.isSafeInteger(management.pid) || management.pid < 1)) {
    throw new ShoppingError('INVALID_ARGUMENTS', 'The managed service identity is invalid.');
  }
  const service = new PlaywrightService(serviceOptions), abort = new AbortController();
  let server, tools, shutdown;
  const stop = () => {
    if (shutdown) return shutdown;
    const serviceStop = service.stop();
    // The same error is awaited below; observe it immediately while the optional lifecycle log is being written.
    void serviceStop.catch(() => {});
    if (!tools) abort.abort();
    shutdown = (async () => {
      try {
        const closing = server ? new Promise(resolve => { server.close(resolve); server.closeIdleConnections?.(); }) : Promise.resolve();
        try { await onStopping(); }
        finally {
          try { await serviceStop; }
          finally { if (!await settlesWithin(closing, STOP_TIMEOUT_MS)) server?.closeAllConnections?.(); }
        }
      } finally {
        abort.abort();
        signals.removeListener('SIGTERM', onSignal); signals.removeListener('SIGINT', onSignal);
      }
      await onStopped();
    })();
    return shutdown;
  };
  const onSignal = () => { void stop().catch(onStopError); };
  signals.once('SIGTERM', onSignal); signals.once('SIGINT', onSignal);
  try {
    server = await listen(service, { port, host, management, onShutdown: stop, onStopError });
    if (abort.signal.aborted) { server.close(); server.closeAllConnections?.(); throw stoppingError(); }
    const browser = localHeadless ? { args: ['--browser', 'chrome', '--headless', '--isolated'], env: {} }
      : { args: ['--extension', '--profile-dir-name', profile], env: { PLAYWRIGHT_MCP_EXTENSION_TOKEN: await readToken(tokenFile) } };
    if (abort.signal.aborted) throw stoppingError();
    tools = await startTools(browser.args, { env: browser.env, signal: abort.signal });
    if (abort.signal.aborted) { await tools.stop(); throw stoppingError(); }
    service.attachTools(tools);
    await service.connect();
    return { service, server, stop };
  } catch (error) {
    const safe = error instanceof ShoppingError ? error : new ShoppingError('SERVICE_START_FAILED', 'The Playwright service could not finish startup. External details were withheld.');
    service.fail(safe.code);
    await stop();
    throw safe;
  }
}
