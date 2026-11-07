import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { main } from '../lib/cli.mjs';
import { collectPddProduct, pddProductScript, validatePddProduct } from '../lib/pdd/product.mjs';
import { pddSearchCardClickScript, validatePddSearchCardClick } from '../lib/pdd/product-entry.mjs';
import { validatePddTask } from '../lib/pdd/task-state.mjs';
import { pddSearchTarget } from '../lib/pdd/targets.mjs';
import { PDD_GOODS_ID, PDD_PRODUCT_TITLE, pddPage, pddProductBody, pddProductUrl } from '../test-support/pdd-product-fixture.mjs';
import { defaultPddCards, pddSearchPage } from '../test-support/pdd-search-fixture.mjs';
import { playwrightStatus, isAddressProbe, mockBridge } from '../test-support/mock-bridge.mjs';

async function run(args) {
  let output = '';
  const code = await main(args, { write: text => { output += text; } });
  return { code, value: JSON.parse(output) };
}

async function stateDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shopping pdd product '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const read = (body, { prefix = '秋冬', href = pddProductUrl() } = {}) => {
  const page = pddPage({ href, body });
  return page.evaluate(pddProductScript(PDD_GOODS_ID, prefix));
};

test('the PDD product reader keeps the page regions and drops other buyers, reviewer names and similar products', () => {
  const raw = read(pddProductBody());
  assert.doesNotMatch(JSON.stringify(raw), /PRIVATE_BUYER|PRIVATE_REVIEWER|OTHER_PRODUCT|PRIVATE_AVATAR|拼多多用户/);
  const product = validatePddProduct(raw, PDD_GOODS_ID, '秋冬', { observedAt: '2026-10-27T05:00:00.000Z' });
  assert.equal(product.title, PDD_PRODUCT_TITLE);
  assert.deepEqual([product.price.raw, product.price.amount, product.price.label, product.price.hidden_by_page], ['补贴价 ¥ 89.9', '89.9', '补贴价', false]);
  assert.deepEqual(product.price_notes, ['官方补贴10元', '优惠前 ¥99.9', '退货包运费', '不满意包退货运费，退换货运费无忧']);
  assert.deepEqual(product.gallery, { counter: '1/3', total_shown: 3, images_cut: false,
    images: ['g1', 'g2', 'g3'].map(name => `https://img-2.pddpic.com/mms-material-img/2026-10-27/${name}.jpeg`) });
  assert.deepEqual(product.highlights, ['近90天12万人看过', '156人在拼', '预计6小时内发货', '承诺48小时内发货，超时必赔', '退货包运费', '7天无理由退货']);
  assert.equal(product.other_buyer_lines_skipped, 8);
  assert.deepEqual(product.reviews, { count: 572, previews: ['料子舒服，上身效果很显身材', '颜色很正'], previews_cut: false, reviewer_names_skipped: 2 });
  assert.deepEqual(product.shop, { name: '思蜜妲旗舰店', review_tags: [{ label: '回头客', count: 687 }, { label: '好看', count: 610 }],
    lines: ['官方运营', '进店逛逛'], lines_cut: false });
  assert.deepEqual(product.params, [{ name: '品牌', value: '思蜜妲' }, { name: '发货地', value: '湖北省' }]);
  assert.deepEqual(product.notices, ['消费提醒', '服饰类商品如出现已洗涤，不支持七天无理由退换。']);
  assert.deepEqual(product.detail_images, ['d1', 'd2'].map(name => `https://img-2.pddpic.com/mms-material-img/2026-10-27/${name}.jpeg`));
  assert.deepEqual(product.bottom_bar, ['更多', '收藏', '客服', '补贴价', '¥', '89', '品牌正品 免拼购买']);
  assert.deepEqual(product.spec, { chosen: '黑色常规款 S 80-100斤', groups_cut: false, groups: [
    { name: '颜色分类', options_cut: false, options: [{ label: '黑色常规款', marks: [] }, { label: '咖色常规款', marks: ['最后9件'] }] },
    { name: '尺码', options_cut: false, options: [{ label: 'S 80-100斤', marks: [] }, { label: 'M 100-115斤', marks: [] }] }] });
  assert.doesNotMatch(collectPddProduct.toString(), /\.click\(|scroll|fetch\(|XMLHttpRequest|cookie|Storage/);
});

test('a card title that draws the brackets as icon glyphs, or drops them, still matches the full title', () => {
  for (const prefix of ['\ue641罗技\ue642M330静音无线光电', '罗技M330静音无线光电']) {
    const product = validatePddProduct(read(pddProductBody({ title: '【罗技】M330静音无线光电鼠标' }), { prefix }), PDD_GOODS_ID, prefix);
    assert.equal(product.title, '【罗技】M330静音无线光电鼠标');
  }
});

test('a shop without store review tags is found by its 进店逛逛 card, and a 请选择 panel still lists its groups', () => {
  const product = validatePddProduct(read(pddProductBody({ shopReviews: false, selection: '请选择 尺码' })), PDD_GOODS_ID, '秋冬');
  assert.deepEqual(product.shop, { name: '思蜜妲旗舰店', review_tags: [], lines: ['官方运营', '进店逛逛'], lines_cut: false });
  assert.deepEqual(product.highlights, ['近90天12万人看过', '156人在拼', '预计6小时内发货', '承诺48小时内发货，超时必赔', '退货包运费', '7天无理由退货']);
  assert.equal(product.reviews.previews.length, 2);
  assert.deepEqual([product.spec.chosen, product.spec.groups.map(group => group.name)], ['请选择 尺码', ['颜色分类', '尺码']]);
});

test('a review count with a thousands separator is read, and an unsupported count stops instead of losing the reviews', () => {
  const product = validatePddProduct(read(pddProductBody({ reviewHeading: '商品评价(2,669)' })), PDD_GOODS_ID, '秋冬');
  assert.deepEqual([product.reviews.count, product.reviews.previews.length], [2669, 2]);
  assert.ok(!product.highlights.includes('颜色很正'), 'review previews never fall into the highlights');
  assert.throws(() => validatePddProduct(read(pddProductBody({ reviewHeading: '商品评价(1.2万)' })), PDD_GOODS_ID, '秋冬'), { code: 'PAGE_STRUCTURE_CHANGED' });
});

test('a page that hides its price keeps no amount and says so; its missing regions are null', () => {
  const product = validatePddProduct(read(pddProductBody({ hidden: true })), PDD_GOODS_ID, '秋冬');
  assert.deepEqual([product.price.raw, product.price.kind, product.price.amount, product.price.hidden_by_page], ['券后 ¥ 7?.??', 'hidden_by_page', null, true]);
  assert.deepEqual([product.reviews, product.shop, product.spec, product.bottom_bar, product.price_notes], [null, null, null, null, []]);
  assert.equal(product.params.length, 2);
});

test('the product reader stops on another product, a title that does not start with the card title, gates and loading', () => {
  assert.throws(() => validatePddProduct(read(pddProductBody(), { href: pddProductUrl('1') }), PDD_GOODS_ID, '秋冬'), { code: 'TARGET_CHANGED' });
  assert.throws(() => validatePddProduct(read(pddProductBody(), { prefix: '春夏' }), PDD_GOODS_ID, '春夏'), { code: 'TITLE_MISMATCH' });
  assert.throws(() => validatePddProduct(read(pddProductBody(), { href: 'https://mobile.pinduoduo.com/login.html?from=x' }), PDD_GOODS_ID, '秋冬'), { code: 'LOGIN_REQUIRED' });
  const loading = pddPage({ href: pddProductUrl(), body: pddProductBody(), readyState: 'loading' });
  assert.throws(() => validatePddProduct(loading.evaluate(pddProductScript(PDD_GOODS_ID, '秋冬')), PDD_GOODS_ID, '秋冬'), { code: 'PAGE_LOADING' });
  assert.throws(() => pddProductScript('x', '秋冬'), { code: 'INVALID_ARGUMENTS' });
});

test('the card click checks the card title and price first and clicks only that card', () => {
  const clicks = [];
  const cards = defaultPddCards().map((card, index) => ({ ...card, onClick: () => clicks.push(index + 1) }));
  const page = pddSearchPage({ cards });
  const click = (position, card) => validatePddSearchCardClick(page.evaluate(pddSearchCardClickScript(page.target, position, card)));
  assert.throws(() => click(2, { title: '罗技M330静音无线光电', amount_text: '72' }), error => error.code === 'SEARCH_CARD_CHANGED' && error.actionNotDispatched);
  assert.throws(() => click(9, { title: 'x', amount_text: '1' }), { code: 'SEARCH_CARD_NOT_LOADED' });
  assert.deepEqual(clicks, []);
  assert.deepEqual(click(3, { title: 'Logitech 罗技M330 B330', amount_text: '79.92' }), { clicked: true });
  assert.deepEqual(clicks, [3]);
  assert.throws(() => pddSearchCardClickScript(page.target, 41, { title: 'x', amount_text: '1' }), { code: 'INVALID_ARGUMENTS' });
});

/** A bridge whose one tab shows a PDD search page; clicking card 2 turns it into the product page, or into `landing`. */
function productBridge(t, { landing = null, productBody = pddProductBody({ title: '罗技M330静音无线光电鼠标办公' }), unfinishedReads = 0 } = {}) {
  const page = pddSearchPage({ query: 'Synthetic mouse' });
  const tab = { id: 88, url: page.context.location.href };
  const cards = defaultPddCards().map((card, index) => ({ ...card, onClick: index === 1 ? () => { tab.url = landing ?? pddProductUrl(); } : null }));
  const searchPage = pddSearchPage({ query: 'Synthetic mouse', cards });
  const productPage = pddPage({ href: pddProductUrl(), body: productBody });
  return mockBridge(t, { handler({ req, res, body, state }) {
    const send = value => res.end(JSON.stringify(value));
    state.tabs = [tab];
    if (req.url === '/status') return send(playwrightStatus());
    if (isAddressProbe(body)) return send({ id: body.id, success: true, data: { result: { state: 'tab_address', url: tab.url } } });
    if (body.action === 'tab_list') return send({ id: body.id, success: true, data: { tabs: state.tabs } });
    if (body.action === 'eval') {
      const current = tab.url.includes('/goods.html') ? productPage : searchPage;
      // Until the page finishes rendering it has the 商品详情 heading but no title yet.
      if (current === productPage && unfinishedReads > 0) {
        unfinishedReads -= 1;
        const unfinished = pddPage({ href: tab.url, body: pddProductBody({ title: 'Loading' }) });
        return send({ id: body.id, success: true, data: { result: unfinished.evaluate(body.script) } });
      }
      return send({ id: body.id, success: true, data: { result: current.evaluate(body.script) } });
    }
    return send({ id: body.id, success: false, error: 'unexpected' });
  } });
}

async function searchThenProduct(t, server, directory, options = {}) {
  const common = ['--endpoint', server.endpoint, '--state-dir', directory];
  await run(['task-start', '--platform', 'pdd', '--task', 'pdd-search', '--search', 'Synthetic mouse', '--tab', '88', ...common]);
  assert.equal((await run(['task-run', '--task', 'pdd-search', ...common])).value.status, 'complete');
  const created = await run(['task-start', '--platform', 'pdd', '--task', 'pdd-card-2', '--source-task', 'pdd-search', '--position', '2', ...common]);
  assert.deepEqual([created.code, created.value.task_kind], [0, 'pdd_product'], JSON.stringify(created.value));
  return run(['task-run', '--task', 'pdd-card-2', ...common, ...(options.args ?? [])]);
}

test('task-start --source-task --position clicks the saved card once, reads its product page in the same tab and exports it', async t => {
  const server = await productBridge(t);
  const directory = await stateDirectory(t);
  const ran = await searchThenProduct(t, server, directory);
  assert.deepEqual([ran.code, ran.value.status], [0, 'complete'], JSON.stringify(ran.value));
  const saved = JSON.parse(await readFile(path.join(directory, 'tasks', 'pdd-card-2.json'), 'utf8'));
  validatePddTask(saved);
  const { result, product_read: journal } = saved.operations[0];
  assert.deepEqual([result.product_id, result.title, result.entry.card_position, result.entry.card_title, result.entry.click],
    [PDD_GOODS_ID, '罗技M330静音无线光电鼠标办公', 2, '罗技M330静音无线光电', 'clicked']);
  assert.equal(result.url, `https://mobile.pinduoduo.com/goods.html?goods_id=${PDD_GOODS_ID}`, 'tracking parameters are not kept');
  assert.deepEqual([journal.click, journal.reads], ['clicked', 1]);
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE/);
  const ledger = JSON.parse(await readFile(path.join(directory, 'pacing-pdd.json'), 'utf8'));
  assert.deepEqual(ledger.loads.map(load => load.category), ['page'], 'the click counts as one page load');
  for (const edit of [task => { task.operations[0].result.title = 'Edited'; }, task => { task.operations[0].product_read.click = null; },
    task => { task.operations[0].result.price.amount = '1'; }]) {
    const broken = structuredClone(saved); edit(broken);
    assert.throws(() => validatePddTask(broken), { code: 'INVALID_CHECKPOINT' });
  }
  const status = await run(['task-status', '--task', 'pdd-card-2', '--state-dir', directory]);
  assert.deepEqual([status.value.operations[0].query, status.value.operations[0].card_position], ['Synthetic mouse', 2]);

  const output = path.join(directory, '..', `pdd-product-${process.pid}-${Date.now()}.md`);
  t.after(() => rm(output, { force: true }));
  const exported = await run(['report-export', '--task', 'pdd-card-2', '--state-dir', directory, '--format', 'markdown', '--output', output]);
  assert.equal(exported.code, 0, JSON.stringify(exported.value));
  const report = await readFile(output, 'utf8');
  assert.match(report, /罗技M330静音无线光电鼠标办公/);
  assert.match(report, /spec\\_option/);
  assert.doesNotMatch(report, /PRIVATE/);
});

test('a product page still rendering when first read is read again without another click', async t => {
  const server = await productBridge(t, { unfinishedReads: 1 });
  const directory = await stateDirectory(t);
  const ran = await searchThenProduct(t, server, directory);
  assert.equal(ran.value.status, 'complete', JSON.stringify(ran.value));
  const saved = JSON.parse(await readFile(path.join(directory, 'tasks', 'pdd-card-2.json'), 'utf8'));
  assert.deepEqual([saved.operations[0].product_read.reads, saved.operations[0].result.entry.reads_reserved], [2, 2]);
  assert.equal(server.state.commands.filter(command => command.action === 'eval' && command.script?.includes('clickPddSearchCard')).length, 1);
});

test('a login page after the click stops the task without a second click; refused options create nothing', async t => {
  const server = await productBridge(t, { landing: 'https://mobile.pinduoduo.com/login.html?from=PRIVATE' });
  const directory = await stateDirectory(t);
  const ran = await searchThenProduct(t, server, directory);
  assert.notEqual(ran.value.status, 'complete');
  assert.equal(ran.value.operations[0].error.code, 'LOGIN_REQUIRED');
  const clicks = server.state.commands.filter(command => command.action === 'eval' && command.script?.includes('clickPddSearchCard'));
  assert.equal(clicks.length, 1);
  const common = ['--endpoint', server.endpoint, '--state-dir', directory];
  for (const [index, [args, code]] of [[['--source-task', 'pdd-search'], 'INVALID_ARGUMENTS'], [['--source-task', 'pdd-search', '--position', '2', '--tab', '88'], 'INVALID_ARGUMENTS'],
    [['--source-task', 'pdd-search', '--position', '9'], 'INVALID_ARGUMENTS'], [['--source-task', 'pdd-card-2', '--position', '1'], 'SOURCE_TASK_NOT_READY']].entries()) {
    assert.equal((await run(['task-start', '--platform', 'pdd', '--task', `pdd-refused-${index}`, ...args, ...common])).value.error.code, code, args.join(' '));
  }
  assert.equal((await run(['task-start', '--task', 'tb-position', '--search', 'x', '--tab', '88', '--position', '2', ...common])).value.error.code, 'UNSUPPORTED_PLATFORM');
  assert.equal((await run(['page-open', '--platform', 'pdd', '--url', pddProductUrl(), ...common])).value.error.code, 'UNSUPPORTED_PLATFORM');
  assert.equal(pddSearchTarget('Synthetic mouse').query, 'Synthetic mouse');
});
