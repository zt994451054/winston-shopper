import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { main } from '../lib/cli.mjs';
import { PDD_SEARCH_CARD_LIMIT, collectPddSearch, pddSearchScript, validatePddSearch, validateSavedPddSearch } from '../lib/pdd/search.mjs';
import { validatePddTask } from '../lib/pdd/task-state.mjs';
import { readThrottleObservations } from '../lib/throttle-log.mjs';
import { playwrightStatus, answerAddressProbe, isAddressProbe, mockBridge } from '../test-support/mock-bridge.mjs';
import { defaultPddCards, node, pddSearchPage } from '../test-support/pdd-search-fixture.mjs';

async function run(args) {
  let output = '';
  const code = await main(args, { write: text => { output += text; } });
  return { code, value: JSON.parse(output) };
}

async function stateDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shopping pdd search '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('the PDD search collector returns each loaded card as its rendered lines and main image, without clicking or scrolling', () => {
  const page = pddSearchPage();
  const raw = page.evaluate(pddSearchScript(page.target));
  assert.equal(raw.state, 'observed');
  assert.equal(raw.cards_seen, 3);
  assert.deepEqual(raw.items[1].lines, ['罗技M330静音无线光电', '近54天100%好评', '假一赔十', '券后', '¥', '71', '已抢286件']);
  assert.match(raw.items[0].image, /^https:\/\/img-2\.pddpic\.com\//);
  assert.match(raw.items[2].image, /^https:\/\/img-2\.pddpic\.com\//, 'a card below the screen gives its data-src address');
  assert.doesNotMatch(collectPddSearch.toString(), /\.click\(|scroll|fetch\(|XMLHttpRequest|cookie|Storage/);
});

test('validated PDD cards split title, labels, price and sales by position, and say that ids and full titles are missing', () => {
  const page = pddSearchPage();
  const result = validatePddSearch(page.evaluate(pddSearchScript(page.target)), page.target, { observedAt: '2026-10-27T03:00:00.000Z' });
  assert.deepEqual(result.items.map(item => [item.position, item.title, item.price.amount_text, item.price.label, item.price.kind, item.sales_text]), [
    [1, '罗技(Logitech)M', '76', '', 'single_displayed', '本店已拼1356件'],
    [2, '罗技M330静音无线光电', '71', '券后', 'single_displayed', '已抢286件'],
    [3, 'Logitech 罗技M330 B330', '79.92', '', 'single_displayed', '本店已拼1件'],
  ]);
  assert.deepEqual(result.items[0].pdd.labels, ['立减23元', '假一赔十', '新客']);
  assert.deepEqual(result.items[1].price, { raw: '券后 ¥ 71', amount_text: '71', label: '券后', kind: 'single_displayed', amount: '71', minimum: null, maximum: null,
    currency: 'CNY', eligibility_verified: false, sku_price_binding_verified: false });
  assert.ok(result.items.every(item => item.product_id === null && item.url === null));
  assert.deepEqual([result.platform, result.coverage.product_ids_known, result.coverage.titles_complete, result.cards_scanned], ['pdd', false, false, 3]);
  assert.deepEqual(result.missing, ['product_ids', 'full_titles', 'cards_not_loaded', 'verified_sort_and_filters', 'verified_payable_prices']);
  validateSavedPddSearch(result, page.target);
  const edited = structuredClone(result); edited.items[0].title = 'Edited';
  assert.throws(() => validateSavedPddSearch(edited, page.target), { code: 'INVALID_CHECKPOINT' });
});

test('the PDD search read stops on another query, a gate page, a loading page or an unrecognised card', () => {
  const read = options => { const page = pddSearchPage(options); return () => validatePddSearch(page.evaluate(pddSearchScript(page.target)), page.target); };
  assert.throws(read({ href: 'https://mobile.pinduoduo.com/search_result.html?search_key=other' }), { code: 'TARGET_CHANGED' });
  assert.throws(read({ href: 'https://mobile.pinduoduo.com/login.html?from=x' }), { code: 'LOGIN_REQUIRED' });
  assert.throws(read({ bodyText: '操作过于频繁，请稍后再试' }), { code: 'RATE_LIMITED' });
  assert.throws(read({ readyState: 'loading' }), { code: 'PAGE_LOADING' });
  assert.throws(read({ cards: [] }), { code: 'PAGE_STRUCTURE_CHANGED' });
  assert.throws(read({ cards: [{ title: '', amount: '1' }, { title: 'B', amount: '2' }] }), { code: 'PAGE_STRUCTURE_CHANGED' });
  assert.throws(read({ extra: [node('div', {}, [node('span', { text: '¥' }), node('span', { text: '¥5' })])] }), { code: 'PAGE_STRUCTURE_CHANGED' });
  const many = Array.from({ length: PDD_SEARCH_CARD_LIMIT + 5 }, (_, index) => ({ title: `Card ${index}`, amount: '9' }));
  const page = pddSearchPage({ cards: many });
  const result = validatePddSearch(page.evaluate(pddSearchScript(page.target)), page.target);
  assert.deepEqual([result.cards_seen, result.cards_scanned], [PDD_SEARCH_CARD_LIMIT + 5, PDD_SEARCH_CARD_LIMIT]);
});

test('cards split into two column elements are found one per ¥ and read row by row, left then right', () => {
  const cards = defaultPddCards().concat([{ title: 'Fourth card', amount: '12' }]);
  const page = pddSearchPage({ cards, columns: true });
  const result = validatePddSearch(page.evaluate(pddSearchScript(page.target)), page.target);
  assert.deepEqual(result.items.map(item => item.title), ['罗技(Logitech)M', '罗技M330静音无线光电', 'Logitech 罗技M330 B330', 'Fourth card']);
  assert.equal(result.cards_seen, 4);
});

test('cards the page has not drawn yet end the read: the drawn ones are kept and the rest only counted (format 2)', () => {
  const cards = defaultPddCards().concat([{ title: 'Fourth card', amount: '12' }, { title: 'Fifth card', amount: '13' }]);
  const page = pddSearchPage({ cards });
  // content-visibility: auto leaves far cards without rendered text (2026-10-28); the fixture's hidden node has none either.
  const grid = page.context.document.body.children[1];
  grid.children[2].hidden = true;
  grid.children[4].hidden = true;
  const result = validatePddSearch(page.evaluate(pddSearchScript(page.target)), page.target, { observedAt: '2026-10-28T08:40:00.000Z' });
  assert.deepEqual([result.schema_version, result.cards_seen, result.cards_scanned, result.cards_not_rendered], [2, 5, 2, 3]);
  assert.deepEqual(result.items.map(item => item.title), ['罗技(Logitech)M', '罗技M330静音无线光电'], 'the drawn fourth card is not read after an undrawn one');
  assert.ok(result.missing.includes('cards_not_rendered'));
  validateSavedPddSearch(result, page.target);
  const edited = structuredClone(result); edited.cards_not_rendered = 0;
  assert.throws(() => validateSavedPddSearch(edited, page.target), { code: 'INVALID_CHECKPOINT' });
  grid.children[0].hidden = true;
  assert.throws(() => validatePddSearch(page.evaluate(pddSearchScript(page.target)), page.target), { code: 'PAGE_STRUCTURE_CHANGED' });
});

test('a format 1 search result, saved before undrawn cards were counted, is rebuilt as saved', () => {
  const page = pddSearchPage();
  const { cards_not_rendered: notRendered, ...current } = validatePddSearch(page.evaluate(pddSearchScript(page.target)), page.target, { observedAt: '2026-10-27T03:00:00.000Z' });
  assert.equal(notRendered, 0);
  const saved = { ...current, schema_version: 1 };
  validateSavedPddSearch(saved, page.target);
  assert.throws(() => validateSavedPddSearch({ ...saved, cards_not_rendered: 0 }, page.target), { code: 'INVALID_CHECKPOINT' });
});

function searchBridge(t, page, { tabUrl } = {}) {
  return mockBridge(t, { handler({ req, res, body, state }) {
    const send = value => res.end(JSON.stringify(value));
    state.tabs = [{ id: 88, url: tabUrl ?? page.context.location.href }];
    if (req.url === '/status') return send(playwrightStatus());
    if (isAddressProbe(body)) return answerAddressProbe(body, state, send);
    if (body.action === 'tab_list') return send({ id: body.id, success: true, data: { tabs: state.tabs } });
    if (body.action === 'eval') return send({ id: body.id, success: true, data: { result: page.evaluate(body.script) } });
    return send({ id: body.id, success: false, error: 'unexpected' });
  } });
}

test('task-start --platform pdd --search reads the cards once on the PDD ledger, saves a checked result and exports it', async t => {
  const page = pddSearchPage({ query: 'Synthetic mouse' });
  const server = await searchBridge(t, page);
  const directory = await stateDirectory(t);
  const common = ['--endpoint', server.endpoint, '--state-dir', directory];
  const created = await run(['task-start', '--platform', 'pdd', '--task', 'pdd-mouse', '--search', 'Synthetic mouse', '--tab', '88', ...common]);
  assert.deepEqual([created.code, created.value.task_kind, created.value.platform], [0, 'pdd_search', 'pdd']);
  const ran = await run(['task-run', '--task', 'pdd-mouse', ...common]);
  assert.deepEqual([ran.code, ran.value.status, ran.value.platform], [0, 'complete', 'pdd']);
  assert.equal(server.state.commands.filter(command => command.action === 'eval' && !isAddressProbe(command)).length, 1);
  assert.equal(server.state.commands.some(command => ['tab_new', 'click', 'scroll'].includes(command.action)), false);
  const ledger = JSON.parse(await readFile(path.join(directory, 'pacing-pdd.json'), 'utf8'));
  assert.equal(ledger.loads.length, 0, 'reading loads nothing');
  const saved = JSON.parse(await readFile(path.join(directory, 'tasks', 'pdd-mouse.json'), 'utf8'));
  validatePddTask(saved);
  assert.equal(saved.operations[0].result.items.length, 3);
  const edits = [task => { task.kind = 'pdd_cart'; }, task => { task.platform = 'jd'; },
    task => { task.operations[0].target.query = 'Other'; }, task => { task.operations[0].result.items[0].price.amount_text = '1'; }];
  for (const edit of edits) {
    const broken = structuredClone(saved); edit(broken);
    assert.throws(() => validatePddTask(broken), { code: 'INVALID_CHECKPOINT' });
  }
  const status = await run(['task-status', '--task', 'pdd-mouse', '--state-dir', directory]);
  assert.equal(status.value.operations[0].query, 'Synthetic mouse');

  const output = path.join(directory, '..', `pdd-report-${process.pid}-${Date.now()}.md`);
  t.after(() => rm(output, { force: true }));
  const exported = await run(['report-export', '--task', 'pdd-mouse', '--state-dir', directory, '--format', 'markdown', '--output', output]);
  assert.equal(exported.code, 0, JSON.stringify(exported.value));
  const report = await readFile(output, 'utf8');
  assert.match(report, /罗技M330静音无线光电/);
  assert.match(report, /labels=立减23元、假一赔十、新客/);
  assert.match(report, /product\\_ids\\_known \| false/);
});

test('PDD search tasks refuse other modes and a mismatched tab, and a gate met while reading is recorded on PDD', async t => {
  const directory = await stateDirectory(t);
  const page = pddSearchPage({ query: 'Synthetic mouse', href: 'https://mobile.pinduoduo.com/search_result.html?search_key=Synthetic%20mouse' });
  const server = await searchBridge(t, page, { tabUrl: 'https://mobile.pinduoduo.com/psnl_verification.html?from=x' });
  const common = ['--endpoint', server.endpoint, '--state-dir', directory];
  for (const [args, code] of [[['--search', 'x', '--tab', '88', '--filters', 'free-shipping'], 'UNSUPPORTED_PLATFORM'], [['--search', 'x', '--tab', '88', '--pages', '2'], 'UNSUPPORTED_PLATFORM'],
    [['--cart', '--tab', '88'], 'UNSUPPORTED_PLATFORM'], [['--search', 'x'], 'INVALID_ARGUMENTS'], [['--search', ' ', '--tab', '88'], 'INVALID_SEARCH']]) {
    assert.equal((await run(['task-start', '--platform', 'pdd', '--task', 'pdd-refused', ...args, ...common])).value.error.code, code, args.join(' '));
  }
  await run(['task-start', '--platform', 'pdd', '--task', 'pdd-gated', '--search', 'Synthetic mouse', '--tab', '88', ...common]);
  const ran = await run(['task-run', '--task', 'pdd-gated', ...common]);
  assert.notEqual(ran.value.status, 'complete');
  assert.equal(ran.value.operations[0].error.code, 'VERIFICATION_REQUIRED');
  const log = await readThrottleObservations(directory);
  assert.deepEqual(log.observations.map(item => [item.platform, item.signal, item.page_kind]), [['pdd', 'verification_required', 'search']]);
  assert.equal(server.state.commands.some(command => command.action === 'eval' && !isAddressProbe(command)), false, 'no page script on a gate page');
});
