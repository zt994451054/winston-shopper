import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserBridge, PACED_METHODS } from '../lib/bridge.mjs';
import { main } from '../lib/cli.mjs';
import { ShoppingError } from '../lib/errors.mjs';
import { failureCategory } from '../lib/task-policy.mjs';
import { saveBinding } from '../lib/state.mjs';
import { validateJdTask } from '../lib/jd/task-state.mjs';
import { createJdTask } from '../lib/jd/tasks.mjs';
import {
  collectJdReviewOverlay, jdReviewCloseScript, jdReviewOpenScript, jdReviewReadScript, jdReviewSelectScript,
  PAGE_NOT_VISIBLE_NEXT_ACTION, pageNotVisibleError, validateJdReviewClose, validateJdReviewObservation,
  validateJdReviewOpen, validateJdReviewSelect,
} from '../lib/jd/review-categories.mjs';
import {
  jdReviewResult, newJdReviewReadState, partialJdReviewSamples, runJdReviewRead, validateJdReviewReadState, validateJdReviewResult,
} from '../lib/jd/review-read.mjs';
import { parseJdProductUrl } from '../lib/jd/targets.mjs';
import { runTask, taskStatus } from '../lib/tasks.mjs';
import { buildCachedReport, renderCachedReport } from '../lib/cached-report.mjs';
import { defaultReviewCategories, jdReviewPage } from '../test-support/jd-review-fixture.mjs';
import { playwrightStatus, mockBridge } from '../test-support/mock-bridge.mjs';

const PRIVATE = ['Synthetic buyer', 'synthetic-avatar', 'synthetic-review', 'synthetic-star', '会员标记', 'star-user-decoy', '有用'];
const validators = { open: validateJdReviewOpen, select: validateJdReviewSelect, close: validateJdReviewClose };

function read(page) {
  const raw = page.evaluate(jdReviewReadScript(page.target));
  assert.equal(validateJdReviewObservation(raw), raw);
  return raw;
}

function absent(value) {
  const text = JSON.stringify(value);
  for (const secret of PRIVATE) assert.equal(text.includes(secret), false, secret);
}

function accept(page, script, action) {
  const raw = page.evaluate(script);
  assert.deepEqual(raw, { state: 'clicked', action });
  assert.deepEqual(validators[action](raw), { clicked: true });
}

function refuse(page, script, action, reason, code, message, nextAction = undefined) {
  const before = [page.openClicks, page.categoryClicks, page.closeClicks];
  const raw = page.evaluate(script);
  assert.deepEqual(raw, { state: 'not_dispatched', action, reason });
  assert.throws(() => validators[action](raw), error => {
    assert.equal(error.code, code);
    assert.equal(error.message, message);
    assert.equal(error.actionNotDispatched, true);
    assert.equal(error.reviewClickReason, reason);
    if (nextAction !== undefined) assert.equal(error.nextAction, nextAction);
    return true;
  });
  assert.deepEqual([page.openClicks, page.categoryClicks, page.closeClicks], before);
}

function clock() {
  let time = 1_000_000;
  return { now: () => time, wait: async ms => { time += ms; } };
}

function spent(state) {
  return state.open.checks + state.steps.reduce((sum, step) => sum + step.checks, 0) + state.close.reads;
}

/** Bridge stand-in: the real page scripts run against the synthetic page. hooks.openError is thrown after the open script. */
function fakeBridge(page, hooks = {}) {
  const calls = [];
  let reads = 0;
  return {
    calls, endpoint: 'http://127.0.0.1:9', protocol: 'playwright-extension',
    async readJdReviewCategories(tabId, target) {
      calls.push('read'); reads += 1;
      if (hooks.beforeRead) hooks.beforeRead(reads);
      const raw = validateJdReviewObservation(page.evaluate(jdReviewReadScript(target)));
      return { observed_at: new Date(Date.UTC(2026, 9, 15, 3, 0, reads)).toISOString(), raw };
    },
    async openJdReviewPanel(tabId, target) {
      calls.push('open');
      const raw = page.evaluate(jdReviewOpenScript(target));
      if (hooks.openError) throw hooks.openError;
      return validateJdReviewOpen(raw);
    },
    async selectJdReviewCategory(tabId, target, name) {
      calls.push('select');
      if (hooks.beforeSelect) hooks.beforeSelect();
      const raw = validateJdReviewSelect(page.evaluate(jdReviewSelectScript(target, name)));
      if (hooks.afterSelect) hooks.afterSelect();
      return raw;
    },
    async closeJdReviewPanel(tabId, target) {
      calls.push('close');
      return validateJdReviewClose(page.evaluate(jdReviewCloseScript(target)));
    },
    async showTab() {
      calls.push('show');
      return hooks.show ? hooks.show() : false;
    },
  };
}

/** Run one visit. Every commit checks the journal, and a refusal must leave that journal valid. */
async function drive(page, plan, { hooks, prepare, commit, box } = {}) {
  const op = { tab_id: 88, target: page.target, recovery_kind: null, review_categories: plan, review_read: newJdReviewReadState(plan) };
  const bridge = fakeBridge(page, hooks);
  const timer = clock();
  if (box) Object.assign(box, { op, bridge });
  if (prepare) prepare(op, timer);
  const check = commit ?? (async () => { validateJdReviewReadState(op.review_read, op.target, plan); });
  try {
    const result = await runJdReviewRead({ bridge, op, commit: check, now: timer.now, wait: timer.wait });
    validateJdReviewResult(result, op.target, plan, op.review_read);
    assert.deepEqual(partialJdReviewSamples(op.review_read), result.samples);
    return { result, op, bridge };
  } catch (error) {
    if (error?.message !== 'The JD review read journal is invalid.') validateJdReviewReadState(op.review_read, op.target, plan);
    throw error;
  }
}

async function savedTask(t, page, plan, name = 'jd-reviews', hooks) {
  const { endpoint } = await mockBridge(t);
  const bridge = fakeBridge(page, hooks);
  bridge.endpoint = endpoint;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shopping jd reviews '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await saveBinding(directory, 'jd-mouse', { schema_version: 1, platform: 'jd', endpoint, tab_id: 88, target: page.target, created_at: new Date().toISOString() });
  const planFile = path.join(directory, 'plan.json');
  await writeFile(planFile, JSON.stringify(plan));
  await createJdTask({ stateDirectory: directory, task: name, bindings: ['jd-mouse'], reviewCategories: planFile, bridge });
  return { directory, bridge, endpoint, name };
}

async function readJournal(directory, name) {
  const saved = JSON.parse(await readFile(path.join(directory, 'tasks', `${name}.json`), 'utf8'));
  return saved.operations[0].review_read;
}

function bridgeFor(t, page, tabId = 88) {
  return mockBridge(t, { handler: ({ req, res, body }) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/status') return res.end(JSON.stringify(playwrightStatus()));
    if (body?.action === 'tab_list') return res.end(JSON.stringify({ id: body.id, success: true, data: { tabs: [{ id: tabId, url: page.target.url }] } }));
    if (body?.action === 'eval') return res.end(JSON.stringify({ id: body.id, success: true, data: { result: page.evaluate(body.script) } }));
    res.end(JSON.stringify({ id: body?.id, success: false, error: 'unsupported' }));
  } });
}

test('an open overlay read returns tags, sort, sku, cards and follow-ups without buyer or media fields', () => {
  const page = jdReviewPage({ initiallyOpen: true });
  const raw = read(page);
  const follow = '合成追评正文';
  assert.deepEqual(raw, {
    state: 'observed', visible: true, entry: 'present', panel: 'open',
    tags: [
      { name: '全部', count_text: '100+', selected: true },
      { name: '好评', count_text: '99%好评', selected: false },
      { name: '差评', count_text: '5', selected: false },
    ],
    tags_seen: 3, sort_text: '最新', sku_select_text: '当前商品',
    cards: [
      {
        position: 1, rating_mark: 'star-good-1', date_text: '09-23', spec_text: '38 深褐色 L',
        body: '合成评价正文一', body_length: '合成评价正文一'.length,
        media: { count: 2, videos: 1 },
        followup: { interval_text: '购后2天追评', body: follow, body_length: follow.length },
      },
      {
        position: 2, rating_mark: 'star-good-1', date_text: '09-24', spec_text: '红色',
        body: '合成评价正文二', body_length: '合成评价正文二'.length,
        media: { count: 0, videos: 0 }, followup: null,
      },
    ],
    cards_seen: 2,
  });
  absent(raw);
  assert.deepEqual([page.openClicks, page.categoryClicks, page.closeClicks], [0, 0, 0]);
  const closed = read(jdReviewPage());
  assert.deepEqual(closed, {
    state: 'observed', visible: true, entry: 'present', panel: 'closed',
    tags: [], tags_seen: 0, sort_text: '', sku_select_text: '', cards: [], cards_seen: 0,
  });
});

test('a hidden document still reports the entry and panel, with no cards', () => {
  const painted = jdReviewPage({ visibility: 'hidden', initiallyOpen: true, paintWhenHidden: true });
  const raw = read(painted);
  assert.equal(raw.visible, false);
  assert.deepEqual([raw.entry, raw.panel, raw.tags_seen, raw.cards, raw.cards_seen], ['present', 'open', 3, [], 0]);
  assert.equal(raw.tags[1].count_text, '99%好评');
  assert.equal(raw.sort_text, '最新');
  absent(raw);
  assert.equal(JSON.stringify(raw).includes('合成评价正文一'), false);
  const unpaintedEntry = read(jdReviewPage({ visibility: 'hidden', entryUnpainted: true }));
  assert.deepEqual([unpaintedEntry.visible, unpaintedEntry.entry, unpaintedEntry.panel], [false, 'present', 'closed']);
  assert.equal(read(jdReviewPage({ entryUnpainted: true })).entry, 'missing');
  const hiddenOpen = read(jdReviewPage({ visibility: 'hidden', initiallyOpen: true, showEntry: false }));
  assert.deepEqual([hiddenOpen.visible, hiddenOpen.entry, hiddenOpen.panel, hiddenOpen.cards], [false, 'missing', 'open', []]);
});

test('tag and card caps keep the painted count, skip blank names, and sort cards by data-index', () => {
  const longBody = '长'.repeat(2005);
  const categories = [
    { name: '分类0', count: '100+', cards: [
      { date: '09-23', spec: '深  褐\n色', body: longBody, images: 0, videos: 0, followup: null, index: 0 },
      { date: '09-23', spec: '黑色', body: '太远', images: 0, videos: 0, followup: null, index: 100001 },
      { date: '09-23', spec: '黑色', body: '第三', images: 0, videos: 0, followup: null, index: 2 },
      { date: '09-23', spec: '黑色', body: '负数', images: 0, videos: 0, followup: null, index: -1 },
      ...Array.from({ length: 10 }, (_, index) => ({ date: '09-23', spec: '黑色', body: `填充${index}`, images: 0, videos: 0, followup: null, index: 10 + index })),
    ] },
    { name: '', count: '1', cards: [] },
    { name: ' ', count: '1', cards: [] },
    { name: '名'.repeat(81), count: '1', cards: [] },
    ...Array.from({ length: 30 }, (_, index) => ({ name: `分类${index + 1}`, count: index === 0 ? '5万+' : String(index + 1), cards: [] })),
  ];
  const raw = read(jdReviewPage({ initiallyOpen: true, categories }));
  assert.equal(raw.tags_seen, 31);
  assert.deepEqual(raw.tags.map(tag => tag.name), Array.from({ length: 30 }, (_, index) => `分类${index}`));
  assert.equal(raw.tags[1].count_text, '5万+');
  assert.equal(raw.cards_seen, 12);
  assert.equal(raw.cards.length, 10);
  assert.deepEqual(raw.cards.slice(0, 2).map(card => [card.position, card.body, card.spec_text]), [
    [1, longBody.slice(0, 2000), '深 褐 色'],
    [3, '第三', '黑色'],
  ]);
  assert.equal(raw.cards[0].body_length, 2005);
  assert.deepEqual(raw.cards.map(card => card.position), [1, 3, 11, 12, 13, 14, 15, 16, 17, 18]);
  const duplicate = defaultReviewCategories();
  duplicate.push({ name: '好评', count: '8', cards: [] });
  const repeated = read(jdReviewPage({ initiallyOpen: true, categories: duplicate }));
  assert.deepEqual(repeated.tags.filter(tag => tag.name === '好评').map(tag => tag.count_text), ['99%好评', '8']);
  const visible = read(jdReviewPage({ initiallyOpen: true }));
  assert.throws(() => validateJdReviewObservation({ ...visible, visible: false }), { code: 'INVALID_RESPONSE' });
  assert.throws(() => validateJdReviewObservation({ ...visible, visible: false, cards: [], cards_seen: 1 }), { code: 'INVALID_RESPONSE' });
  const closed = read(jdReviewPage());
  assert.throws(() => validateJdReviewObservation({ ...closed, sort_text: '最新' }), { code: 'INVALID_RESPONSE' });
});

test('the open click hits one painted entry and refuses a hidden page, a missing entry, and an open panel', () => {
  const page = jdReviewPage();
  accept(page, jdReviewOpenScript(page.target), 'open');
  assert.deepEqual(page.lastClicked, { role: 'entry-label' });
  assert.deepEqual([page.openClicks, page.categoryClicks, page.closeClicks, page.open], [1, 0, 0, true]);
  const flat = jdReviewPage({ flatEntry: true });
  accept(flat, jdReviewOpenScript(flat.target), 'open');
  assert.deepEqual(flat.lastClicked, { role: 'entry' });
  assert.equal(flat.open, true);
  assert.equal(read(page).cards[0].body, '合成评价正文一');
  refuse(page, jdReviewOpenScript(page.target), 'open', 'panel_open', 'REVIEW_PANEL_REQUIRED', 'The review panel is already open.');
  const hidden = jdReviewPage({ visibility: 'hidden' });
  refuse(hidden, jdReviewOpenScript(hidden.target), 'open', 'page_not_visible', 'PAGE_NOT_VISIBLE',
    'The JD page is not visible, so the review list cannot be read.', PAGE_NOT_VISIBLE_NEXT_ACTION);
  for (const options of [{ showEntry: false }, { entryUnpainted: true }]) {
    const missing = jdReviewPage(options);
    refuse(missing, jdReviewOpenScript(missing.target), 'open', 'entry_missing', 'REVIEW_PANEL_REQUIRED', 'The 全部评价 entry is not on the page.');
  }
  const ambiguous = jdReviewPage({ extraEntry: true });
  assert.equal(read(ambiguous).entry, 'ambiguous');
  refuse(ambiguous, jdReviewOpenScript(ambiguous.target), 'open', 'entry_ambiguous', 'PAGE_STRUCTURE_CHANGED', 'The 全部评价 entry is not unique.');
  assert.equal(ambiguous.lastClicked, null);
});

test('the category click switches one painted tag and refuses hidden, closed, duplicate, and unpainted tags', () => {
  const page = jdReviewPage({ initiallyOpen: true });
  refuse(page, jdReviewSelectScript(page.target, '全部'), 'select', 'already_selected', 'REVIEW_CATEGORY_ALREADY_SELECTED', 'The requested category is already selected.');
  accept(page, jdReviewSelectScript(page.target, '好评'), 'select');
  assert.deepEqual(page.lastClicked, { role: 'tag-name', name: '好评' });
  assert.equal(page.categoryClicks, 1);
  const raw = read(page);
  assert.equal(raw.tags.find(tag => tag.selected).name, '好评');
  assert.equal(raw.cards[0].body, '合成好评正文');
  assert.equal(raw.cards_seen, 1);
  absent(raw);
  const hidden = jdReviewPage({ visibility: 'hidden', initiallyOpen: true, paintWhenHidden: true });
  refuse(hidden, jdReviewSelectScript(hidden.target, '好评'), 'select', 'page_not_visible', 'PAGE_NOT_VISIBLE',
    'The JD page is not visible, so the review list cannot be read.', PAGE_NOT_VISIBLE_NEXT_ACTION);
  const closed = jdReviewPage();
  refuse(closed, jdReviewSelectScript(closed.target, '好评'), 'select', 'panel_closed', 'REVIEW_PANEL_REQUIRED', 'The review panel is not open.');
  const missing = jdReviewPage({ initiallyOpen: true });
  refuse(missing, jdReviewSelectScript(missing.target, '中评'), 'select', 'category_unavailable', 'REVIEW_CATEGORY_UNAVAILABLE', 'The requested category is not on the panel.');
  const concealed = jdReviewPage({ initiallyOpen: true, hiddenCategory: '好评' });
  assert.equal(read(concealed).tags.some(tag => tag.name === '好评'), false);
  refuse(concealed, jdReviewSelectScript(concealed.target, '好评'), 'select', 'category_unavailable', 'REVIEW_CATEGORY_UNAVAILABLE', 'The requested category is not on the panel.');
  const faint = jdReviewPage({ initiallyOpen: true, unpainted: '好评' });
  assert.equal(read(faint).tags.some(tag => tag.name === '好评'), true);
  refuse(faint, jdReviewSelectScript(faint.target, '好评'), 'select', 'category_unpainted', 'REVIEW_CATEGORY_UNAVAILABLE', 'The requested category is not visible.');
  const categories = defaultReviewCategories();
  categories.push({ name: '好评', count: '8', cards: [] });
  const ambiguous = jdReviewPage({ initiallyOpen: true, categories });
  refuse(ambiguous, jdReviewSelectScript(ambiguous.target, '好评'), 'select', 'category_ambiguous', 'REVIEW_CATEGORIES_AMBIGUOUS', 'More than one tag has the requested category name.');
});

test('the close click works while hidden or unpainted, and refuses a closed panel or a bad control', () => {
  const page = jdReviewPage({ initiallyOpen: true });
  accept(page, jdReviewCloseScript(page.target), 'close');
  assert.deepEqual(page.lastClicked, { role: 'close-icon' });
  assert.deepEqual([page.closeClicks, page.openClicks, page.categoryClicks, page.open], [1, 0, 0, false]);
  refuse(page, jdReviewCloseScript(page.target), 'close', 'panel_closed', 'REVIEW_PANEL_REQUIRED', 'The review panel is not open.');
  const hidden = jdReviewPage({ visibility: 'hidden', initiallyOpen: true, closeUnpainted: true });
  accept(hidden, jdReviewCloseScript(hidden.target), 'close');
  assert.equal(hidden.closeClicks, 1);
  assert.equal(hidden.open, false);
  const hiddenClosed = jdReviewPage({ visibility: 'hidden' });
  refuse(hiddenClosed, jdReviewCloseScript(hiddenClosed.target), 'close', 'panel_closed', 'REVIEW_PANEL_REQUIRED', 'The review panel is not open.');
  const missing = jdReviewPage({ initiallyOpen: true, closeHidden: true });
  refuse(missing, jdReviewCloseScript(missing.target), 'close', 'close_missing', 'PAGE_STRUCTURE_CHANGED', 'The review panel close button is missing.');
  const ambiguous = jdReviewPage({ initiallyOpen: true, extraClose: true });
  refuse(ambiguous, jdReviewCloseScript(ambiguous.target), 'close', 'close_ambiguous', 'PAGE_STRUCTURE_CHANGED', 'The review panel close button is not unique.');
});

test('gate and target checks stop the read and the clicks before they touch the overlay', () => {
  const limited = jdReviewPage({ limited: true, initiallyOpen: true, visibility: 'hidden' });
  assert.deepEqual(limited.evaluate(jdReviewReadScript(limited.target)), { state: 'rate_limited' });
  assert.deepEqual(limited.evaluate(jdReviewCloseScript(limited.target)), { state: 'rate_limited' });
  assert.equal(limited.closeClicks, 0);
  assert.throws(() => validateJdReviewObservation({ state: 'rate_limited' }), error => {
    assert.equal(error.code, 'RATE_LIMITED');
    assert.equal(error.actionNotDispatched, undefined);
    return true;
  });
  const moved = jdReviewPage({ href: 'https://item.jd.com/1.html', initiallyOpen: true });
  assert.deepEqual(moved.evaluate(jdReviewOpenScript(moved.target)), { state: 'target_changed' });
  assert.equal(moved.openClicks, 0);
  assert.throws(() => validateJdReviewOpen({ state: 'target_changed' }), { code: 'TARGET_CHANGED' });
  const login = jdReviewPage({ href: 'https://passport.jd.com/uc/login', visibility: 'hidden', initiallyOpen: true, paintWhenHidden: true });
  assert.deepEqual(login.evaluate(jdReviewReadScript(login.target)), { state: 'login_required' });
  assert.throws(() => validateJdReviewClose({ state: 'clicked', action: 'open' }), error => {
    assert.equal(error.code, 'INVALID_RESPONSE');
    assert.equal(error.actionNotDispatched, undefined);
    return true;
  });
});

test('PAGE_NOT_VISIBLE is raised only for an open or category click, and the page scripts stay read-only except those clicks', () => {
  const error = pageNotVisibleError();
  assert.equal(error.code, 'PAGE_NOT_VISIBLE');
  assert.equal(error.nextAction, PAGE_NOT_VISIBLE_NEXT_ACTION);
  const page = jdReviewPage();
  const collector = collectJdReviewOverlay.toString();
  for (const banned of ['jdc-pc-rate-card-user', 'jdc-pc-rate-card-nick', '.click(', "getAttribute('src')", '.src', 'cookie', 'localStorage', 'sessionStorage']) {
    assert.equal(collector.includes(banned), false, banned);
  }
  const script = jdReviewReadScript(page.target);
  for (const banned of ['jdc-pc-rate-card-user', 'jdc-pc-rate-card-nick', '.click(', 'cookie', 'localStorage', 'sessionStorage']) {
    assert.equal(script.includes(banned), false, banned);
  }
  assert.equal(script.includes("getAttribute('src')"), true);
  for (const source of [jdReviewOpenScript(page.target), jdReviewSelectScript(page.target, '好评'), jdReviewCloseScript(page.target)]) {
    assert.equal(source.includes('.click('), true);
    for (const banned of ['jdc-pc-rate-card-user', 'jdc-pc-rate-card-nick', 'cookie', 'localStorage', 'sessionStorage']) {
      assert.equal(source.includes(banned), false, banned);
    }
  }
  assert.throws(() => jdReviewReadScript({ ...page.target, product_id: '1' }), { code: 'INVALID_TARGET' });
  assert.throws(() => jdReviewSelectScript(page.target, ' 好评'), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => jdReviewSelectScript(page.target, ''), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => jdReviewSelectScript(page.target, '名'.repeat(81)), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => jdReviewSelectScript(page.target, '好\u0001评'), { code: 'INVALID_ARGUMENTS' });
  assert.deepEqual(PACED_METHODS.readJdReviewCategories, ['read']);
  assert.deepEqual(PACED_METHODS.openJdReviewPanel, ['action']);
  assert.deepEqual(PACED_METHODS.selectJdReviewCategory, ['action']);
  assert.deepEqual(PACED_METHODS.closeJdReviewPanel, ['action']);
});

test('bridge reads and clicks run on the saved product tab', async t => {
  const page = jdReviewPage();
  const { endpoint } = await bridgeFor(t, page);
  const bridge = new BrowserBridge(endpoint);
  const closed = await bridge.readJdReviewCategories(88, page.target);
  assert.equal(Number.isNaN(Date.parse(closed.observed_at)), false);
  assert.equal(closed.raw.panel, 'closed');
  assert.deepEqual(await bridge.openJdReviewPanel(88, page.target), { clicked: true });
  const opened = await bridge.readJdReviewCategories(88, page.target);
  assert.equal(opened.raw.cards[0].followup.body, '合成追评正文');
  absent(opened.raw);
  assert.deepEqual(await bridge.selectJdReviewCategory(88, page.target, '差评'), { clicked: true });
  assert.equal((await bridge.readJdReviewCategories(88, page.target)).raw.cards[0].body, '合成差评正文');
  page.visibility = 'hidden';
  const hidden = await bridge.readJdReviewCategories(88, page.target);
  assert.deepEqual([hidden.raw.visible, hidden.raw.cards, hidden.raw.panel], [false, [], 'open']);
  absent(hidden.raw);
  assert.equal(JSON.stringify(hidden.raw).includes('合成差评正文'), false);
  assert.deepEqual(await bridge.closeJdReviewPanel(88, page.target), { clicked: true });
  assert.deepEqual([page.openClicks, page.categoryClicks, page.closeClicks, page.open], [1, 1, 1, false]);
});

test('bridge methods are marked not dispatched when the page script is not sent', async t => {
  const target = parseJdProductUrl('https://item.jd.com/3290995.html');
  const calls = [
    ['readJdReviewCategories', target],
    ['openJdReviewPanel', target],
    ['selectJdReviewCategory', target, '好评'],
    ['closeJdReviewPanel', target],
  ];
  const disconnected = await mockBridge(t);
  disconnected.state.connected = false;
  const offline = new BrowserBridge(disconnected.endpoint);
  for (const [method, ...args] of calls) {
    await assert.rejects(offline[method](88, ...args), { code: 'EXTENSION_DISCONNECTED', actionNotDispatched: true });
  }
  assert.equal(disconnected.state.commands.length, 0);

  const missing = await mockBridge(t);
  const absentTab = new BrowserBridge(missing.endpoint);
  for (const [method, ...args] of calls) {
    await assert.rejects(absentTab[method](88, ...args), { code: 'TARGET_MISSING', actionNotDispatched: true });
  }
  assert.deepEqual(missing.state.commands.map(command => command.action), ['tab_list', 'eval', 'tab_list', 'eval', 'tab_list', 'eval', 'tab_list', 'eval']);
  for (const command of missing.state.commands) {
    if (!command.script) continue;
    assert.equal(command.script.includes('tab_address'), true);
    assert.equal(command.script.includes('collectJdReviewOverlay'), false);
    assert.equal(command.script.includes('jdReviewClick'), false);
  }

  const wrong = await mockBridge(t, { handler: ({ req, res, body }) => {
    if (req.url === '/status') return res.end(JSON.stringify(playwrightStatus()));
    if (body.action === 'tab_list') return res.end(JSON.stringify({ id: body.id, success: true, data: { tabs: [{ id: 88, url: 'https://item.jd.com/1.html' }] } }));
    res.end(JSON.stringify({ id: body.id, success: false, error: 'PRIVATE_ERROR' }));
  } });
  const mismatched = new BrowserBridge(wrong.endpoint);
  for (const [method, ...args] of calls) {
    await assert.rejects(mismatched[method](88, ...args), { code: 'TARGET_CHANGED', actionNotDispatched: true });
  }
  assert.deepEqual(wrong.state.commands.map(command => command.action), ['tab_list', 'tab_list', 'tab_list', 'tab_list']);

  const idle = await mockBridge(t);
  const bridge = new BrowserBridge(idle.endpoint);
  for (const label of ['', ' 好评', '名'.repeat(81), '好\u0001评']) {
    await assert.rejects(bridge.selectJdReviewCategory(88, target, label), { code: 'INVALID_ARGUMENTS', actionNotDispatched: true });
  }
  assert.equal(idle.state.requests.length, 0);

  const dropped = await mockBridge(t, { handler: ({ req, res, body }) => {
    if (req.url === '/status') return res.end(JSON.stringify(playwrightStatus()));
    if (body.action === 'tab_list') return res.end(JSON.stringify({ id: body.id, success: true, data: { tabs: [{ id: 88, url: target.url }] } }));
    res.end(JSON.stringify({ id: body.id, success: false, error: 'PRIVATE_ERROR' }));
  } });
  await assert.rejects(new BrowserBridge(dropped.endpoint).openJdReviewPanel(88, target), error => {
    assert.equal(error.code, 'BROWSER_COMMAND_FAILED');
    assert.equal(error.actionNotDispatched, undefined);
    assert.equal(String(error.message).includes('PRIVATE_ERROR'), false);
    return true;
  });
  assert.equal(dropped.state.commands.some(command => command.action === 'eval' && command.script.includes('jdReviewClick')), true);
});

const LOGIN_NEXT_ACTION = 'After the user completes login or verification, run task-resume --after-user once.';

function cardOf(body) {
  return { date: '09-23', spec: '黑色', body, images: 0, videos: 0, followup: null };
}

test('opening, reading the selected category, and closing records the visit and clicks the inner controls', async () => {
  const page = jdReviewPage();
  const { result, op, bridge } = await drive(page, [null]);
  assert.deepEqual(bridge.calls, ['read', 'open', 'read', 'read', 'close', 'read', 'read']);
  assert.deepEqual(page.clicks, [{ role: 'entry-label' }, { role: 'close-icon' }]);
  assert.deepEqual([page.openClicks, page.categoryClicks, page.closeClicks], [1, 0, 1]);
  assert.equal(op.review_read.observations, 5);
  assert.deepEqual([op.review_read.open.checks, op.review_read.steps[0].checks, op.review_read.close.reads, spent(op.review_read)], [1, 1, 2, 4]);
  assert.deepEqual(Object.keys(result), ['schema_version', 'platform', 'product_id', 'url', 'source', 'observed_at', 'login_verified', 'panel', 'categories_seen', 'samples', 'association', 'coverage', 'excluded', 'actions']);
  assert.deepEqual(result.panel, { initial_state: 'closed', opened_by_task: true, open_acknowledgement: 'clicked', close_status: 'closed_confirmed', sort_text: '最新', sku_select_text: '当前商品' });
  assert.equal(result.samples.length, 1);
  assert.deepEqual(Object.keys(result.samples[0]), ['requested', 'category', 'count_text', 'observed_at', 'list_changed', 'cards_rendered', 'cards_seen', 'cards']);
  assert.equal(result.samples[0].requested, null);
  assert.equal(result.samples[0].category, '全部');
  assert.equal(result.samples[0].count_text, '100+');
  assert.equal(result.samples[0].list_changed, null);
  assert.deepEqual([result.samples[0].cards_rendered, result.samples[0].cards_seen], [2, 2]);
  const card = result.samples[0].cards[0];
  assert.equal(card.rating_mark, 'star-good-1');
  assert.equal(card.date_text, '09-23');
  assert.equal(card.media.videos, 1);
  assert.deepEqual(Object.keys(card.media), ['count', 'videos']);
  assert.equal(card.followup.body, '合成追评正文');
  assert.deepEqual(result.association, { category_ui_verified: true, filter_algorithm_verified: false });
  assert.deepEqual(result.coverage, { status: 'partial', scope: 'rendered_cards_only', scrolled: false, date_has_year: false, media_read: false, unique_review_count: null });
  assert.deepEqual(result.excluded, ['nicknames', 'avatars', 'member_marks', 'review_media_urls', 'card_actions']);
  assert.deepEqual(result.actions, { open_reserved: true, category_clicks_reserved: 0, close_reserved: true, observations_reserved: 5 });
  assert.equal(result.observed_at, result.samples[0].observed_at);
  absent(result);
  assert.equal(JSON.stringify(result).includes('360buyimg'), false);
  assert.deepEqual(Object.keys(op.review_read), ['schema_version', 'observations', 'categories_seen', 'sort_text', 'sku_select_text', 'open', 'close', 'steps', 'not_before']);
  assert.deepEqual(Object.keys(op.review_read.open), ['acknowledgement', 'checks', 'confirmed', 'error', 'initial_state', 'reserved']);
  assert.deepEqual(Object.keys(op.review_read.close), ['acknowledgement', 'closed_streak', 'error', 'reads', 'reserved', 'status']);
  assert.deepEqual(Object.keys(op.review_read.steps[0]), ['requested', 'category', 'count_text', 'acknowledgement', 'acknowledgement_error', 'action_reserved', 'before_cards', 'before_sort', 'candidate', 'after', 'observed_at', 'cards_seen', 'list_changed', 'checks']);
  const flat = jdReviewPage({ flatEntry: true });
  await drive(flat, [null]);
  assert.equal(flat.clicks[0].role, 'entry');
  assert.equal(flat.clicks.at(-1).role, 'close-icon');
});

test('two or three named categories click each unselected tag name and keep the samples', async () => {
  const page = jdReviewPage();
  const plan = ['全部', '好评', '差评'];
  const { result, op, bridge } = await drive(page, plan);
  assert.deepEqual(page.clicks, [
    { role: 'entry-label' }, { role: 'tag-name', name: '好评' }, { role: 'tag-name', name: '差评' }, { role: 'close-icon' },
  ]);
  assert.deepEqual([page.openClicks, page.categoryClicks, page.closeClicks], [1, 2, 1]);
  assert.equal(op.review_read.observations, 11);
  assert.equal(spent(op.review_read), 8);
  assert.deepEqual(bridge.calls.filter(call => call === 'select'), ['select', 'select']);
  assert.deepEqual(result.samples.map(sample => [sample.requested, sample.category, sample.list_changed, sample.cards_rendered]), [
    ['全部', '全部', null, 2], ['好评', '好评', true, 1], ['差评', '差评', true, 1],
  ]);
  assert.equal(result.samples[1].cards[0].body, '合成好评正文');
  assert.equal(result.samples[2].cards[0].body, '合成差评正文');
  assert.equal(result.actions.category_clicks_reserved, 2);
  assert.equal(result.panel.close_status, 'closed_confirmed');
  absent(result);
});

test('identical cards after a switch are confirmed with list_changed false', async () => {
  const page = jdReviewPage({ sameCards: true });
  const { result } = await drive(page, ['全部', '好评']);
  assert.deepEqual(result.samples.map(sample => [sample.category, sample.list_changed, sample.cards_rendered]), [
    ['全部', null, 2], ['好评', false, 2],
  ]);
  assert.deepEqual(JSON.stringify(result.samples[0].cards), JSON.stringify(result.samples[1].cards));
  assert.deepEqual(page.clicks.map(click => click.role), ['entry-label', 'tag-name', 'close-icon']);
});

test('a panel that is already open is read without an open or close click', async () => {
  const page = jdReviewPage({ initiallyOpen: true });
  const { result, op, bridge } = await drive(page, [null]);
  assert.deepEqual(bridge.calls, ['read', 'read']);
  assert.equal(page.clicks.length, 0);
  assert.equal(op.review_read.observations, 2);
  assert.equal(spent(op.review_read), 1);
  assert.deepEqual([result.panel.initial_state, result.panel.opened_by_task, result.panel.open_acknowledgement, result.panel.close_status], ['open', false, null, 'not_opened_by_task']);
  assert.equal(result.samples[0].category, '全部');
  assert.equal(result.samples[0].list_changed, null);
});

test('a hidden page pauses before any click, and resume finishes the visit without repeating one', async t => {
  const page = jdReviewPage({ visibility: 'hidden' });
  const saved = await savedTask(t, page, [null]);
  const timer = clock();
  const paused = await runTask({ stateDirectory: saved.directory, task: saved.name, bridge: saved.bridge }, timer);
  assert.equal(paused.status, 'waiting_user');
  assert.deepEqual(paused.operations[0].error, { code: 'PAGE_NOT_VISIBLE', category: 'user' });
  assert.equal(paused.next_action, PAGE_NOT_VISIBLE_NEXT_ACTION);
  assert.equal(paused.operations[0].actions_reserved, 0);
  assert.ok(paused.operations[0].dom_observations_reserved >= 1);
  assert.deepEqual(paused.operations[0].partial_review_samples, []);
  assert.deepEqual(paused.operations[0].requested_categories, [null]);
  assert.equal(page.openClicks, 0);
  page.visibility = 'visible';
  const done = await runTask({ stateDirectory: saved.directory, task: saved.name, bridge: saved.bridge, recovery: 'user' }, timer);
  assert.equal(done.status, 'complete');
  assert.equal(done.operations[0].partial_review_samples, undefined);
  assert.equal(done.operations[0].result.panel.close_status, 'closed_confirmed');
  assert.equal(done.operations[0].dom_observations_reserved, 6);
  assert.equal(spent(await readJournal(saved.directory, saved.name)), 4);
  assert.deepEqual([page.openClicks, page.categoryClicks, page.closeClicks], [1, 0, 1]);
  assert.equal(failureCategory('PAGE_NOT_VISIBLE'), 'user');
});

test('a hidden page is brought forward once by the program, and the visit finishes without the user', async t => {
  const page = jdReviewPage({ visibility: 'hidden' });
  const saved = await savedTask(t, page, [null], 'jd-reviews', { show: () => { page.visibility = 'visible'; return true; } });
  const done = await runTask({ stateDirectory: saved.directory, task: saved.name, bridge: saved.bridge }, clock());
  assert.equal(done.status, 'complete');
  assert.equal(saved.bridge.calls.filter(call => call === 'show').length, 1);
  assert.deepEqual([page.openClicks, page.closeClicks], [1, 1]);
});

test('a page still hidden after one attempt to show it pauses for the user without a second attempt', async t => {
  const page = jdReviewPage({ visibility: 'hidden' });
  const saved = await savedTask(t, page, [null], 'jd-reviews', { show: () => true });
  const paused = await runTask({ stateDirectory: saved.directory, task: saved.name, bridge: saved.bridge }, clock());
  assert.equal(paused.status, 'waiting_user');
  assert.equal(paused.operations[0].error.code, 'PAGE_NOT_VISIBLE');
  assert.equal(saved.bridge.calls.filter(call => call === 'show').length, 1);
  assert.equal(page.openClicks, 0);
});

test('hiding after the open click pauses, and resume still closes the panel it opened', async t => {
  const page = jdReviewPage({ hideOnOpen: true });
  const saved = await savedTask(t, page, [null]);
  const timer = clock();
  const paused = await runTask({ stateDirectory: saved.directory, task: saved.name, bridge: saved.bridge }, timer);
  assert.equal(paused.status, 'waiting_user');
  assert.equal(paused.operations[0].error.code, 'PAGE_NOT_VISIBLE');
  assert.equal(paused.next_action, PAGE_NOT_VISIBLE_NEXT_ACTION);
  assert.equal(paused.operations[0].actions_reserved, 1);
  assert.deepEqual(paused.operations[0].partial_review_samples, []);
  assert.equal(page.openClicks, 1);
  assert.equal(page.clicks[0].role, 'entry-label');
  page.visibility = 'visible';
  const done = await runTask({ stateDirectory: saved.directory, task: saved.name, bridge: saved.bridge, recovery: 'user' }, timer);
  assert.equal(done.status, 'complete');
  assert.equal(done.operations[0].result.panel.opened_by_task, true);
  assert.equal(done.operations[0].result.panel.close_status, 'closed_confirmed');
  assert.deepEqual([page.openClicks, page.closeClicks], [1, 1]);
  assert.equal(saved.bridge.calls.filter(call => call === 'open').length, 1);
});

test('a hidden confirmation after a category click does not click that tag again', async t => {
  const page = jdReviewPage({ initiallyOpen: true });
  const saved = await savedTask(t, page, ['好评'], 'jd-reviews', { afterSelect: () => { page.visibility = 'hidden'; } });
  const timer = clock();
  const paused = await runTask({ stateDirectory: saved.directory, task: saved.name, bridge: saved.bridge }, timer);
  assert.equal(paused.operations[0].error.code, 'PAGE_NOT_VISIBLE');
  assert.equal(page.categoryClicks, 1);
  assert.deepEqual(page.lastClicked, { role: 'tag-name', name: '好评' });
  assert.equal(paused.operations[0].partial_review_samples.length, 0);
  page.visibility = 'visible';
  const done = await runTask({ stateDirectory: saved.directory, task: saved.name, bridge: saved.bridge, recovery: 'user' }, timer);
  assert.equal(done.status, 'complete');
  assert.equal(page.categoryClicks, 1);
  assert.equal(saved.bridge.calls.filter(call => call === 'select').length, 1);
  assert.equal(done.operations[0].result.samples[0].list_changed, true);
  assert.equal(done.operations[0].result.panel.close_status, 'not_opened_by_task');
  assert.equal(page.closeClicks, 0);
});

test('a missing category stops after the open click and does not close', async t => {
  const page = jdReviewPage();
  const saved = await savedTask(t, page, ['中评']);
  const report = await runTask({ stateDirectory: saved.directory, task: saved.name, bridge: saved.bridge }, clock());
  assert.equal(report.status, 'stopped');
  assert.deepEqual(report.operations[0].error, { code: 'REVIEW_CATEGORY_UNAVAILABLE', category: 'diagnostic' });
  assert.deepEqual([page.openClicks, page.categoryClicks, page.closeClicks], [1, 0, 0]);
  assert.deepEqual(report.operations[0].partial_review_samples, []);
  const kept = defaultReviewCategories();
  kept.push({ name: '好评', count: '8', cards: [] });
  const box = {};
  await assert.rejects(drive(jdReviewPage({ initiallyOpen: true, categories: kept }), ['好评'], { box }), error => {
    assert.equal(error.code, 'REVIEW_CATEGORIES_AMBIGUOUS');
    assert.equal(error.message, 'More than one tag has the requested category name.');
    return true;
  });
  assert.equal(box.bridge.calls.length, 1);
  assert.equal(box.op.review_read.steps[0].category, null);
});

test('a null plan still reads the one selected tag when other tags share a name', async () => {
  const categories = defaultReviewCategories();
  categories.push({ name: '好评', count: '8', cards: [cardOf('合成重复')] });
  const page = jdReviewPage({ categories });
  const { result } = await drive(page, [null]);
  assert.equal(result.samples[0].category, '全部');
  assert.deepEqual([page.openClicks, page.categoryClicks, page.closeClicks], [1, 0, 1]);
  assert.equal(result.categories_seen.filter(tag => tag.name === '好评').length, 2);
});

test('two selected tags make a null plan spend checks and never click', async () => {
  const categories = [cardOf('合成甲'), cardOf('合成乙')].map((card, index) => ({ name: '好评', count: String(index + 1), cards: [card] }));
  const page = jdReviewPage({ initiallyOpen: true, categories });
  const box = {};
  await assert.rejects(drive(page, [null], { box }), error => {
    assert.equal(error.code, 'REVIEW_CATEGORY_OUTCOME_UNKNOWN');
    assert.equal(error.message, 'Category content could not be confirmed; its action will not be repeated.');
    return true;
  });
  assert.equal(page.categoryClicks, 0);
  assert.equal(box.op.review_read.steps[0].checks, 4);
  assert.equal(box.op.review_read.steps[0].category, null);
  assert.deepEqual(box.bridge.calls, ['read', 'read', 'read', 'read']);
});

test('an unknown open receipt is not repeated, and the panel is not closed by this task', async t => {
  const page = jdReviewPage();
  const saved = await savedTask(t, page, [null], 'jd-reviews', { openError: new ShoppingError('BRIDGE_TIMEOUT', 'The bridge timed out.') });
  const report = await runTask({ stateDirectory: saved.directory, task: saved.name, bridge: saved.bridge }, clock());
  assert.equal(report.status, 'complete');
  assert.equal(page.openClicks, 1);
  assert.equal(saved.bridge.calls.filter(call => call === 'open').length, 1);
  assert.equal(page.closeClicks, 0);
  assert.deepEqual([report.operations[0].result.panel.open_acknowledgement, report.operations[0].result.panel.opened_by_task, report.operations[0].result.panel.close_status], ['uncertain', false, 'not_opened_by_task']);
  assert.equal(report.operations[0].result.samples[0].category, '全部');
  assert.equal((await readJournal(saved.directory, saved.name)).open.error, 'BRIDGE_TIMEOUT');
});

test('an open reserved without an acknowledgement is not sent again', async () => {
  const page = jdReviewPage();
  const plan = [null];
  const op = { tab_id: 88, target: page.target, recovery_kind: null, review_categories: plan, review_read: newJdReviewReadState(plan) };
  const bridge = fakeBridge(page);
  const timer = clock();
  let tripped = false;
  const commit = async () => {
    validateJdReviewReadState(op.review_read, op.target, plan);
    if (!tripped && op.review_read.open.reserved && op.review_read.open.acknowledgement === null) {
      tripped = true;
      throw new ShoppingError('READ_INTERRUPTED', 'A previous read has no committed result.');
    }
  };
  await assert.rejects(runJdReviewRead({ bridge, op, commit, now: timer.now, wait: timer.wait }), { code: 'READ_INTERRUPTED' });
  validateJdReviewReadState(op.review_read, op.target, plan);
  assert.equal(op.review_read.open.acknowledgement, null);
  assert.equal(page.openClicks, 0);
  await assert.rejects(runJdReviewRead({ bridge, op, commit, now: timer.now, wait: timer.wait }), error => {
    assert.equal(error.code, 'REVIEW_DRAWER_NOT_VISIBLE');
    assert.equal(error.message, 'The mounted review content is outside the viewport or hidden.');
    return true;
  });
  validateJdReviewReadState(op.review_read, op.target, plan);
  assert.deepEqual(bridge.calls, ['read', 'read', 'read', 'read']);
  assert.equal(op.review_read.open.error, 'READ_INTERRUPTED');
  assert.equal(op.review_read.open.checks, 3);
  assert.equal(op.review_read.open.confirmed, false);
  assert.equal(op.review_read.open.acknowledgement, 'uncertain');
  assert.equal(page.openClicks, 0);
});

test('the read budget stops the visit before a twenty-first observation', async t => {
  const page = jdReviewPage({ initiallyOpen: true });
  const raw = validateJdReviewObservation(page.evaluate(jdReviewReadScript(page.target)));
  const saved = await savedTask(t, page, [null]);
  const file = path.join(saved.directory, 'tasks', `${saved.name}.json`);
  const task = JSON.parse(await readFile(file, 'utf8'));
  const state = task.operations[0].review_read;
  const candidate = structuredClone(raw.cards);
  candidate[0] = { ...candidate[0], body: '另一段正文', body_length: '另一段正文'.length };
  state.observations = 19;
  state.categories_seen = raw.tags;
  state.sort_text = '最新';
  state.sku_select_text = '当前商品';
  Object.assign(state.open, { acknowledgement: 'clicked', checks: 1, confirmed: true, initial_state: 'closed', reserved: true });
  Object.assign(state.steps[0], { category: '全部', count_text: '100+', before_sort: '最新', candidate, checks: 2 });
  validateJdReviewReadState(state, page.target, [null]);
  validateJdTask(task);
  await writeFile(file, JSON.stringify(task));
  const report = await runTask({ stateDirectory: saved.directory, task: saved.name, bridge: saved.bridge }, clock());
  assert.equal(report.status, 'stopped');
  assert.equal(report.operations[0].error.code, 'ACTION_OBSERVATION_LIMIT');
  assert.equal(report.operations[0].error.category, 'diagnostic');
  const journal = await readJournal(saved.directory, saved.name);
  assert.equal(journal.observations, 20);
  assert.equal(journal.steps[0].checks, 3);
  assert.equal(journal.steps[0].after, null);
  assert.deepEqual(saved.bridge.calls, ['read']);
  assert.equal(page.openClicks, 0);
});

test('a close that never removes the panel still keeps the confirmed sample', async t => {
  const page = jdReviewPage({ closeWorks: false });
  const saved = await savedTask(t, page, [null]);
  const report = await runTask({ stateDirectory: saved.directory, task: saved.name, bridge: saved.bridge }, clock());
  assert.equal(report.status, 'complete');
  assert.equal(report.operations[0].result.panel.close_status, 'unconfirmed');
  assert.equal(report.operations[0].result.samples.length, 1);
  assert.equal(page.closeClicks, 1);
  assert.equal((await readJournal(saved.directory, saved.name)).close.reads, 3);
  assert.equal(page.open, true);
});

test('closing still confirms while the document is hidden', async () => {
  const page = jdReviewPage({ hideOnClose: true });
  const { result } = await drive(page, [null]);
  assert.equal(result.panel.close_status, 'closed_confirmed');
  assert.equal(page.visibility, 'hidden');
  assert.equal(page.lastClicked.role, 'close-icon');
  assert.equal(page.closeClicks, 1);
  assert.equal(result.samples.length, 1);
});

test('empty cards or a list that changes every read stop after four category checks', async () => {
  const empty = defaultReviewCategories();
  empty[0].cards = [];
  const emptyBox = {};
  await assert.rejects(drive(jdReviewPage({ initiallyOpen: true, categories: empty }), [null], { box: emptyBox }), { code: 'REVIEW_CATEGORY_OUTCOME_UNKNOWN' });
  assert.equal(emptyBox.op.review_read.observations, 4);
  assert.equal(emptyBox.op.review_read.steps[0].checks, 4);
  assert.equal(emptyBox.op.review_read.steps[0].category, null);
  assert.equal(emptyBox.bridge.calls.length, 4);
  const shifting = jdReviewPage({ initiallyOpen: true });
  let version = 0;
  const box = {};
  await assert.rejects(drive(shifting, [null], { box, hooks: { beforeRead: () => {
    shifting.categories[0].cards[0].body = `合成变体${version}`;
    version += 1;
    shifting.body = shifting.rebuild();
  } } }), { code: 'REVIEW_CATEGORY_OUTCOME_UNKNOWN' });
  assert.equal(box.op.review_read.observations, 5);
  assert.equal(box.op.review_read.steps[0].checks, 4);
  assert.equal(box.op.review_read.steps[0].category, '全部');
  assert.ok(box.op.review_read.steps[0].candidate);
  assert.equal(box.op.review_read.steps[0].after, null);
});

test('a missing or ambiguous entry, a click that does not open, and a shifted clock stop without a second try', async () => {
  const missing = jdReviewPage({ showEntry: false });
  await assert.rejects(drive(missing, [null]), error => {
    assert.equal(error.code, 'REVIEW_PANEL_REQUIRED');
    assert.equal(error.message, 'The 全部评价 entry is not on the page.');
    return true;
  });
  assert.equal(missing.openClicks, 0);
  assert.equal(missing.lastClicked, null);
  const ambiguous = jdReviewPage({ extraEntry: true });
  await assert.rejects(drive(ambiguous, [null]), { code: 'PAGE_STRUCTURE_CHANGED', message: 'The 全部评价 entry is not unique.' });
  assert.equal(ambiguous.lastClicked, null);
  assert.equal(ambiguous.openClicks, 0);
  const stuck = jdReviewPage({ openWorks: false });
  const box = {};
  await assert.rejects(drive(stuck, [null], { box }), { code: 'REVIEW_DRAWER_NOT_VISIBLE', message: 'The mounted review content is outside the viewport or hidden.' });
  assert.equal(stuck.openClicks, 1);
  assert.equal(box.op.review_read.observations, 4);
  assert.equal(box.op.review_read.open.checks, 3);
  const clockBox = {};
  await assert.rejects(drive(jdReviewPage(), [null], { box: clockBox, prepare: (op, timer) => { op.review_read.not_before = timer.now() + 20_000; } }), {
    code: 'CLOCK_CHANGED', message: 'The JD review wait is inconsistent with the clock.',
  });
  assert.deepEqual(clockBox.bridge.calls, []);
});

test('a category that becomes selected before the click is released and then read', async () => {
  const page = jdReviewPage({ initiallyOpen: true });
  const { result, bridge } = await drive(page, ['好评'], { hooks: { beforeSelect: () => { page.selected = '好评'; page.body = page.rebuild(); } } });
  assert.equal(page.categoryClicks, 0);
  assert.deepEqual(bridge.calls, ['read', 'select', 'read', 'read']);
  assert.equal(result.samples[0].category, '好评');
  assert.equal(result.samples[0].list_changed, null);
  assert.equal(result.panel.close_status, 'not_opened_by_task');
});

test('one confirmed sample remains when a later category is missing', async t => {
  const page = jdReviewPage();
  const saved = await savedTask(t, page, ['全部', '中评']);
  const report = await runTask({ stateDirectory: saved.directory, task: saved.name, bridge: saved.bridge }, clock());
  assert.equal(report.status, 'stopped');
  assert.equal(report.operations[0].error.code, 'REVIEW_CATEGORY_UNAVAILABLE');
  assert.equal(report.operations[0].partial_review_samples.length, 1);
  assert.equal(report.operations[0].partial_review_samples[0].category, '全部');
  assert.equal(report.operations[0].partial_review_samples[0].list_changed, null);
  assert.equal(page.categoryClicks, 0);
  assert.equal(page.closeClicks, 0);
  assert.equal(page.openClicks, 1);
});

test('login pauses with the login instruction, and a tampered checkpoint is refused', async t => {
  const loginPage = jdReviewPage({ href: 'https://passport.jd.com/uc/login' });
  const login = await savedTask(t, loginPage, [null], 'jd-login');
  const paused = await runTask({ stateDirectory: login.directory, task: login.name, bridge: login.bridge }, clock());
  assert.equal(paused.status, 'waiting_user');
  assert.equal(paused.operations[0].error.code, 'LOGIN_REQUIRED');
  assert.equal(paused.next_action, LOGIN_NEXT_ACTION);
  assert.equal(loginPage.openClicks, 0);
  const page = jdReviewPage();
  const saved = await savedTask(t, page, [null], 'jd-saved');
  const done = await runTask({ stateDirectory: saved.directory, task: saved.name, bridge: saved.bridge }, clock());
  const result = done.operations[0].result;
  const journal = await readJournal(saved.directory, saved.name);
  const tampered = structuredClone(result);
  tampered.panel.opened_by_task = false;
  assert.throws(() => validateJdReviewResult(tampered, page.target, [null], journal), error => {
    assert.equal(error.message, 'The JD review result does not match its journal.');
    return true;
  });
  const badJournal = structuredClone(journal);
  badJournal.observations = 21;
  assert.throws(() => validateJdReviewReadState(badJournal, page.target, [null]), error => {
    assert.equal(error.message, 'The JD review read journal is invalid.');
    return true;
  });
  assert.throws(() => validateJdReviewResult(result, page.target, [null], badJournal), error => {
    assert.equal(error.message, 'The JD review read journal is invalid.');
    return true;
  });
  assert.deepEqual(jdReviewResult(journal, page.target), result);
  const file = path.join(saved.directory, 'tasks', `${saved.name}.json`);
  const stored = JSON.parse(await readFile(file, 'utf8'));
  stored.operations[0].result.panel.opened_by_task = false;
  await writeFile(file, JSON.stringify(stored));
  await assert.rejects(taskStatus({ stateDirectory: saved.directory, task: saved.name }), error => {
    assert.equal(error.code, 'INVALID_CHECKPOINT');
    // The task store wraps every checkpoint failure, JD ones included, in its own message.
    assert.equal(error.message, 'The task checkpoint is invalid or incompatible. No browser operation was sent.');
    return true;
  });
});

async function runCli(args) {
  let output = '';
  const code = await main(args, { write: text => { output += text; } });
  return { code, value: JSON.parse(output) };
}

test('the JD review command starts, pauses while hidden, and resumes on the JD pacing ledger', async t => {
  const page = jdReviewPage({ visibility: 'hidden' });
  const { endpoint } = await bridgeFor(t, page);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shopping jd review cli '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await saveBinding(directory, 'jd-mouse', { schema_version: 1, platform: 'jd', endpoint, tab_id: 88, target: page.target, created_at: new Date().toISOString() });
  const plan = fileURLToPath(new URL('../examples/review-categories-current.json', import.meta.url));
  const common = ['--endpoint', endpoint, '--state-dir', directory];
  for (const [extra, code] of [
    [['--bindings', 'jd-mouse', '--details', '--review-categories', plan], 'INVALID_ARGUMENTS'],
    [['--search', '鼠标', '--tab', '88', '--review-categories', plan], 'INVALID_ARGUMENTS'],
    [['--bindings', 'jd-mouse,jd-other', '--review-categories', plan], 'INVALID_ARGUMENTS'],
    [['--bindings', 'jd-mouse', '--services'], 'UNSUPPORTED_PLATFORM'],
  ]) {
    assert.equal((await runCli(['task-start', '--platform', 'jd', ...common, '--task', 'jd-refused', ...extra])).value.error.code, code);
  }
  const created = await runCli(['task-start', '--platform', 'jd', ...common, '--task', 'jd-reviews', '--bindings', 'jd-mouse', '--review-categories', plan]);
  assert.deepEqual([created.code, created.value.task_kind, created.value.products], [0, 'jd_review_categories', 1]);
  const paused = await runCli(['task-run', ...common, '--task', 'jd-reviews']);
  assert.equal(paused.code, 2);
  assert.equal(paused.value.status, 'waiting_user');
  assert.equal(paused.value.operations[0].error.code, 'PAGE_NOT_VISIBLE');
  assert.equal(paused.value.next_action, PAGE_NOT_VISIBLE_NEXT_ACTION);
  assert.deepEqual(paused.value.operations[0].requested_categories, [null]);
  assert.equal(paused.value.operations[0].actions_reserved, 0);
  assert.ok(paused.value.operations[0].dom_observations_reserved >= 1);
  assert.deepEqual(paused.value.operations[0].partial_review_samples, []);
  assert.equal(page.openClicks, 0);
  const waiting = await runCli(['task-status', '--state-dir', directory, '--task', 'jd-reviews']);
  assert.equal(waiting.code, 2);
  assert.deepEqual(waiting.value.operations[0].requested_categories, [null]);
  assert.deepEqual(waiting.value.operations[0].partial_review_samples, []);
  page.visibility = 'visible';
  const resumed = await runCli(['task-resume', ...common, '--task', 'jd-reviews', '--after-user']);
  assert.equal(resumed.code, 0);
  assert.equal(resumed.value.status, 'complete');
  assert.equal(resumed.value.operations[0].partial_review_samples, undefined);
  assert.equal(resumed.value.operations[0].result.panel.close_status, 'closed_confirmed');
  assert.equal(resumed.value.operations[0].dom_observations_reserved, 6);
  assert.deepEqual([page.openClicks, page.closeClicks], [1, 1]);
  assert.equal(page.clicks[0].role, 'entry-label');
  const status = await runCli(['task-status', '--state-dir', directory, '--task', 'jd-reviews']);
  assert.equal(status.code, 0);
  assert.equal(status.value.operations[0].partial_review_samples, undefined);
  assert.equal(existsSync(path.join(directory, 'pacing.json')), false);
  assert.equal(existsSync(path.join(directory, 'pacing-jd.json')), true);
  const csv = path.join(directory, '..', `jd-reviews-${path.basename(directory)}.csv`);
  t.after(() => rm(csv, { force: true }));
  assert.equal((await runCli(['report-export', '--state-dir', directory, '--task', 'jd-reviews', '--format', 'csv', '--output', csv])).code, 0);
  const rows = await readFile(csv, 'utf8');
  for (const pattern of [/"review_category",[^\n]*"全部","100\+"[^\n]*requested=current; sort=最新; sku=当前商品; list_changed=null; cards_rendered=2; cards_seen=2/,
    /"review",[^\n]*"09-23","合成评价正文一"[^\n]*spec=38 深褐色 L; rating=star-good-1; media_items=2; videos=1/,
    /"review_followup",[^\n]*"购后2天追评","合成追评正文"[^\n]*followup=1/,
    /"review_panel",[^\n]*"closed"[^\n]*opened_by_task=true; open_acknowledgement=clicked; close_status=closed_confirmed/,
    /"review_category_option",[^\n]*"差评","5"[^\n]*last_open_panel_read/,
    /"collection_coverage",[^\n]*"scope","rendered_cards_only"/, /"collection_coverage",[^\n]*"date_has_year","false"/]) assert.match(rows, pattern);
  absent(rows);
  assert.equal(rows.includes('360buyimg'), false);
});

test('the export lists each sample with its own time, and the tag list and panel once with the last sample', async () => {
  const { result } = await drive(jdReviewPage(), ['全部', '好评', '差评']);
  const task = { id: 'jd-reviews', kind: 'jd_review_categories', status: 'complete', created_at: '2026-10-15T00:00:00.000Z',
    updated_at: '2026-10-15T00:00:00.000Z', operations: [{ status: 'succeeded', result }] };
  const report = buildCachedReport(task);
  assert.deepEqual(report.observations.map(item => [item.batch_position, item.observed_at, item.source, item.url]),
    result.samples.map((sample, index) => [index + 1, sample.observed_at, 'jd_review_overlay', result.url]));
  assert.deepEqual(report.observations[0].coverage, {});
  assert.deepEqual(report.observations[0].collection_coverage, { status: 'partial', scope: 'rendered_cards_only', scrolled: false,
    date_has_year: false, media_read: false, unique_review_count: null });
  const types = position => report.records.filter(row => row.observation_position === position).map(row => row.record_type);
  assert.deepEqual(types(1), ['review_category', 'review', 'review_followup', 'review']);
  assert.deepEqual(types(2), ['review_category', 'review']);
  assert.deepEqual(types(3), ['review_category', 'review', 'review_panel', 'review_category_option', 'review_category_option', 'review_category_option']);
  const options = report.records.filter(row => row.record_type === 'review_category_option');
  assert.deepEqual(options.map(row => [row.label, row.text, row.selected]), [['全部', '100+', false], ['好评', '99%好评', false], ['差评', '5', true]]);
  assert.deepEqual(report.records.filter(row => row.record_type === 'review_category').map(row => [row.group_position, row.group_name, row.text]),
    [[1, '全部', '100+'], [2, '好评', '99%好评'], [3, '差评', '5']]);
  for (const format of ['csv', 'markdown']) {
    const rendered = renderCachedReport(report, format);
    absent(rendered);
    assert.equal(rendered.includes('360buyimg'), false);
  }
  assert.deepEqual(buildCachedReport({ ...task, status: 'failed', operations: [{ status: 'failed', result: null }] }).records, []);
});
