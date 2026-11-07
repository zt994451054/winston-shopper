import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { main } from '../lib/cli.mjs';
import { collectPddReviews, pddReviewsLinkClickScript, pddReviewsScript, validatePddReviews, validatePddReviewsLinkClick } from '../lib/pdd/reviews.mjs';
import { validatePddTask } from '../lib/pdd/task-state.mjs';
import { PDD_GOODS_ID, pddPage, pddProductBody, pddProductUrl, pddReviewCard, pddReviewsBody, pddReviewsUrl } from '../test-support/pdd-product-fixture.mjs';
import { defaultPddCards, node, pddSearchPage } from '../test-support/pdd-search-fixture.mjs';
import { playwrightStatus, isAddressProbe, mockBridge } from '../test-support/mock-bridge.mjs';

async function run(args) {
  let output = '';
  const code = await main(args, { write: text => { output += text; } });
  return { code, value: JSON.parse(output) };
}

async function stateDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shopping pdd reviews '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const div = text => node('div', { text });
const LONG = '这款鼠标确实没买错，按键声音很小，握感舒服，续航也不错，办公用正合适。'.repeat(3);
const defaultCards = () => [
  pddReviewCard({ name: 'PRIVATE_REVIEWER_ONE', spec: '型号：M330蓝色【全新】', text: '觉得商品很好，给出了5星好评', images: 1 }),
  pddReviewCard({ name: '拼多多用户', text: LONG, expand: true, images: 2 }),
  pddReviewCard({ name: 'PRIVATE_REVIEWER_TWO', spec: null, text: '手感超舒服', extra: [['2026-10-20'], ['用了一周追评：', '还是很好用'], ['商家回复：感谢支持'], ['其他说明']] }),
];
const readPage = (body, href = pddReviewsUrl()) => pddPage({ href, body }).evaluate(pddReviewsScript(PDD_GOODS_ID));

test('the review reader keeps spec, text, date, follow-up, reply and media counts, and drops reviewer names and the product bar', () => {
  const raw = readPage(pddReviewsBody({ cards: defaultCards() }));
  assert.doesNotMatch(JSON.stringify(raw), /PRIVATE|拼多多用户|客服|确定|已选/);
  const page = validatePddReviews(raw, PDD_GOODS_ID, { observedAt: '2026-10-27T09:00:00.000Z' });
  assert.deepEqual([page.url, page.tabs, page.loaded_count, page.reviews_cut, page.reviewer_names_skipped],
    [`https://mobile.pinduoduo.com/goods_comments.html?goods_id=${PDD_GOODS_ID}`, ['全部(572)'], 3, false, 3]);
  assert.deepEqual(page.reviews[0], { position: 1, spec: '型号：M330蓝色【全新】', text: '觉得商品很好，给出了5星好评', date: null, follow_up: null,
    merchant_reply: null, other_lines: [], expand_shown: false, images: 1, videos: 0, blocks_cut: false, other_blocks_skipped: 0 });
  assert.deepEqual([page.reviews[1].text, page.reviews[1].expand_shown, page.reviews[1].images], [LONG, true, 2], 'the whole text is read without 展开');
  assert.deepEqual(page.reviews[2], { position: 3, spec: null, text: '手感超舒服', date: '2026-10-20', follow_up: '用了一周追评： 还是很好用',
    merchant_reply: '商家回复：感谢支持', other_lines: [], expand_shown: false, images: 0, videos: 0, blocks_cut: false, other_blocks_skipped: 1 });
  assert.doesNotMatch(collectPddReviews.toString(), /\.click\(|scroll|fetch\(|XMLHttpRequest|cookie|Storage/);
});

test('a card whose like count replaces 赞 is still a card, and the lines under the list are kept as page notes', () => {
  const cards = [pddReviewCard({ text: '第一条', actions: ['赞', '1'], extra: [['评价总结小助手', '透气还不闷热']] }),
    pddReviewCard({ name: 'PRIVATE_REVIEWER_TWO', text: '第二条', actions: ['1', '评论'] }), pddReviewCard({ text: '第三条' })];
  const raw = readPage(pddReviewsBody({ tabs: ['全部(9)'], cards, notes: ['该商品还有3条默认好评', '联系商家客服'] }));
  assert.doesNotMatch(JSON.stringify(raw), /PRIVATE/);
  const page = validatePddReviews(raw, PDD_GOODS_ID);
  assert.deepEqual(page.reviews.map(review => review.text), ['第一条', '第二条', '第三条']);
  assert.deepEqual([page.reviews[0].other_lines, page.reviews[0].other_blocks_skipped], [[], 1], 'the 评价总结小助手 block is not kept');
  assert.deepEqual([page.loaded_count, page.reviewer_names_skipped, page.page_notes], [3, 3, ['该商品还有3条默认好评', '联系商家客服']]);
  // A 评论 outside every recognised card means a card was missed: nothing is returned.
  const stray = pddReviewsBody({ cards: [pddReviewCard({ text: '好' })] });
  stray.children[1].children.push(div('评论'));
  stray.children[1].children.at(-1).parentElement = stray.children[1];
  assert.throws(() => validatePddReviews(readPage(stray), PDD_GOODS_ID), { code: 'PAGE_STRUCTURE_CHANGED' });
});

test('a reply preview under a review, which starts with the replier\'s nickname, never leaves the page; icon-only actions are dropped', () => {
  const cards = [pddReviewCard({ text: '一直用罗技', images: 3, extra: [['PRIVATE_REPLIER', '一个鼠标能用11年'], ['2', '1']], actions: [] }),
    pddReviewCard({ text: '', images: 1, extra: [['PRIVATE_REPLIER_TWO', '同感']] })];
  const raw = readPage(pddReviewsBody({ cards }));
  assert.doesNotMatch(JSON.stringify(raw), /PRIVATE/);
  const page = validatePddReviews(raw, PDD_GOODS_ID);
  assert.deepEqual(page.reviews.map(review => [review.text, review.other_lines, review.other_blocks_skipped, review.images]),
    [['一直用罗技', [], 1, 3], [null, [], 1, 1]], 'a review without text does not take the reply preview as its text');
});

test('emoji images in the text are not avatars', () => {
  const card = pddReviewCard({ text: '好用' });
  card.children[2].children.push(node('img', { width: 47, attrs: { src: 'https://promotion.pddpic.com/emoji.png' } }));
  card.children[2].children.at(-1).parentElement = card.children[2];
  const page = validatePddReviews(readPage(pddReviewsBody({ cards: [card, pddReviewCard({ text: '第二条' })] })), PDD_GOODS_ID);
  assert.deepEqual(page.reviews.map(review => [review.text, review.images]), [['好用', 0], ['第二条', 0]]);
});

test('a format 1 observation without page notes is still accepted as format 1', () => {
  const { notes, ...current } = readPage(pddReviewsBody({ cards: defaultCards() }));
  assert.deepEqual(notes, []);
  const raw = { ...current, cards: current.cards.map(({ skipped_blocks: skipped, ...card }) => card) };
  const page = validatePddReviews(raw, PDD_GOODS_ID, { version: 1 });
  assert.equal(Object.hasOwn(page, 'page_notes'), false);
  assert.throws(() => validatePddReviews(raw, PDD_GOODS_ID), { code: 'INVALID_RESPONSE' });
});

test('the review reader keeps at most 20 loaded reviews, reads one alone, and refuses a card whose first block has no avatar', () => {
  const many = Array.from({ length: 23 }, (_, index) => pddReviewCard({ text: `评价${index + 1}` }));
  const page = validatePddReviews(readPage(pddReviewsBody({ cards: many })), PDD_GOODS_ID);
  assert.deepEqual([page.loaded_count, page.reviews.length, page.reviews_cut, page.reviews.at(-1).text], [23, 20, true, '评价20']);
  const single = validatePddReviews(readPage(pddReviewsBody({ cards: [pddReviewCard({ text: '只有一条' })] })), PDD_GOODS_ID);
  assert.deepEqual([single.reviews.length, single.reviews[0].text, single.reviewer_names_skipped], [1, '只有一条', 1]);
  const noAvatar = readPage(pddReviewsBody({ cards: [pddReviewCard({ text: '好', avatar: false })] }));
  assert.throws(() => validatePddReviews(noAvatar, PDD_GOODS_ID), { code: 'PAGE_STRUCTURE_CHANGED' });
  assert.doesNotMatch(JSON.stringify(noAvatar), /PRIVATE/);
  assert.throws(() => validatePddReviews(readPage(pddReviewsBody({ cards: defaultCards() }), pddReviewsUrl('1')), PDD_GOODS_ID), { code: 'TARGET_CHANGED' });
  assert.throws(() => validatePddReviews(readPage(pddReviewsBody(), pddProductUrl()), PDD_GOODS_ID), { code: 'TARGET_CHANGED' });
});

test('查看全部 is clicked only while 商品评价 shows the saved count', () => {
  const clicks = [];
  const page = pddPage({ href: pddProductUrl(), body: pddProductBody({ onAllReviews: () => clicks.push('all') }) });
  const click = count => validatePddReviewsLinkClick(page.evaluate(pddReviewsLinkClickScript(PDD_GOODS_ID, count)));
  assert.throws(() => click(571), error => error.code === 'REVIEWS_CHANGED' && error.actionNotDispatched);
  assert.deepEqual(clicks, []);
  assert.deepEqual(click(572), { clicked: true });
  assert.deepEqual(clicks, ['all']);
  const separated = pddPage({ href: pddProductUrl(), body: pddProductBody({ reviewHeading: '商品评价(2,669)', onAllReviews: () => clicks.push('separated') }) });
  assert.deepEqual(validatePddReviewsLinkClick(separated.evaluate(pddReviewsLinkClickScript(PDD_GOODS_ID, 2669))), { clicked: true });
  assert.deepEqual(clicks, ['all', 'separated']);
  const bare = pddPage({ href: pddProductUrl(), body: pddProductBody({ hidden: true }) });
  assert.throws(() => validatePddReviewsLinkClick(bare.evaluate(pddReviewsLinkClickScript(PDD_GOODS_ID, 572))), { code: 'REVIEWS_NOT_SHOWN' });
  assert.throws(() => pddReviewsLinkClickScript(PDD_GOODS_ID, 0), { code: 'INVALID_ARGUMENTS' });
});

/**
 * A bridge whose one tab shows a PDD search page; card 2 opens the product page, whose 查看全部 opens the review page,
 * or `reviewsLanding` instead.
 */
function reviewsBridge(t, { hidden = false, reviewsLanding = null } = {}) {
  const tab = { id: 88, url: '' };
  const cards = defaultPddCards().map((card, index) => ({ ...card, onClick: index === 1 ? () => { tab.url = pddProductUrl(); } : null }));
  const searchPage = pddSearchPage({ query: 'Synthetic mouse', cards });
  tab.url = searchPage.context.location.href;
  const productPage = pddPage({ href: pddProductUrl(), body: pddProductBody({ hidden, title: '罗技M330静音无线光电鼠标办公',
    onAllReviews: () => { tab.url = reviewsLanding ?? pddReviewsUrl(); } }) });
  const reviewsPage = pddPage({ href: pddReviewsUrl(), body: pddReviewsBody({ cards: defaultCards() }) });
  return mockBridge(t, { handler({ req, res, body, state }) {
    const send = value => res.end(JSON.stringify(value));
    state.tabs = [tab];
    if (req.url === '/status') return send(playwrightStatus());
    if (isAddressProbe(body)) return send({ id: body.id, success: true, data: { result: { state: 'tab_address', url: tab.url } } });
    if (body.action === 'tab_list') return send({ id: body.id, success: true, data: { tabs: state.tabs } });
    if (body.action === 'eval') {
      const current = tab.url.includes('/goods_comments.html') ? reviewsPage : tab.url.includes('/goods.html') ? productPage : searchPage;
      return send({ id: body.id, success: true, data: { result: current.evaluate(body.script) } });
    }
    return send({ id: body.id, success: false, error: 'unexpected' });
  } });
}

async function productThenReviews(server, directory) {
  const common = ['--endpoint', server.endpoint, '--state-dir', directory];
  await run(['task-start', '--platform', 'pdd', '--task', 'pdd-search', '--search', 'Synthetic mouse', '--tab', '88', ...common]);
  assert.equal((await run(['task-run', '--task', 'pdd-search', ...common])).value.status, 'complete');
  await run(['task-start', '--platform', 'pdd', '--task', 'pdd-card-2', '--source-task', 'pdd-search', '--position', '2', ...common]);
  assert.equal((await run(['task-run', '--task', 'pdd-card-2', ...common])).value.status, 'complete');
  const created = await run(['task-start', '--platform', 'pdd', '--task', 'pdd-card-2-reviews', '--source-task', 'pdd-card-2', '--reviews', ...common]);
  assert.deepEqual([created.code, created.value.task_kind], [0, 'pdd_reviews'], JSON.stringify(created.value));
  return run(['task-run', '--task', 'pdd-card-2-reviews', ...common]);
}

const reviewClicks = server => server.state.commands.filter(command => command.action === 'eval' && command.script?.includes('clickPddReviewsLink'));

test('task-start --source-task --reviews clicks 查看全部 once, reads the loaded reviews in the same tab and exports them without names', async t => {
  const server = await reviewsBridge(t);
  const directory = await stateDirectory(t);
  const ran = await productThenReviews(server, directory);
  assert.deepEqual([ran.code, ran.value.status], [0, 'complete'], JSON.stringify(ran.value));
  const saved = JSON.parse(await readFile(path.join(directory, 'tasks', 'pdd-card-2-reviews.json'), 'utf8'));
  validatePddTask(saved);
  const { result, reviews_read: journal } = saved.operations[0];
  assert.deepEqual([result.outcome, result.product_id, result.entry.product_title, result.entry.review_count_on_product_page, result.entry.click],
    ['read', PDD_GOODS_ID, '罗技M330静音无线光电鼠标办公', 572, 'clicked']);
  assert.deepEqual([result.reviews.length, result.reviewer_names_skipped, result.coverage.scrolled, result.coverage.category_clicked], [3, 3, false, false]);
  assert.deepEqual([journal.click, journal.reads], ['clicked', 1]);
  assert.equal(reviewClicks(server).length, 1);
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE|拼多多用户/);
  const ledger = JSON.parse(await readFile(path.join(directory, 'pacing-pdd.json'), 'utf8'));
  assert.deepEqual(ledger.loads.map(load => load.category), ['page', 'page'], 'the card click and the 查看全部 click are page loads');
  for (const edit of [task => { task.operations[0].result.reviews[0].text = 'Edited'; }, task => { task.operations[0].reviews_read.click = null; },
    task => { task.operations[0].result.reviewer_names_skipped = 0; }]) {
    const broken = structuredClone(saved); edit(broken);
    assert.throws(() => validatePddTask(broken), { code: 'INVALID_CHECKPOINT' });
  }
  const status = await run(['task-status', '--task', 'pdd-card-2-reviews', '--state-dir', directory]);
  assert.deepEqual([status.value.operations[0].query, status.value.operations[0].product_id], ['Synthetic mouse', PDD_GOODS_ID]);

  const output = path.join(directory, '..', `pdd-reviews-${process.pid}-${Date.now()}.md`);
  t.after(() => rm(output, { force: true }));
  const exported = await run(['report-export', '--task', 'pdd-card-2-reviews', '--state-dir', directory, '--format', 'markdown', '--output', output]);
  assert.equal(exported.code, 0, JSON.stringify(exported.value));
  const report = await readFile(output, 'utf8');
  assert.match(report, /觉得商品很好/);
  assert.match(report, /review\\_follow\\_up/);
  assert.doesNotMatch(report, /PRIVATE|拼多多用户/);

  // The tab now shows the review page, so a second reviews task refuses before clicking.
  const common = ['--endpoint', server.endpoint, '--state-dir', directory];
  await run(['task-start', '--platform', 'pdd', '--task', 'pdd-card-2-reviews-again', '--source-task', 'pdd-card-2', '--reviews', ...common]);
  const again = await run(['task-run', '--task', 'pdd-card-2-reviews-again', ...common]);
  assert.notEqual(again.value.status, 'complete');
  assert.equal(reviewClicks(server).length, 1);
});

test('a product page without reviews is answered without a click; a login page after the click stops without a second click', async t => {
  const quiet = await reviewsBridge(t, { hidden: true });
  const quietDirectory = await stateDirectory(t);
  const none = await productThenReviews(quiet, quietDirectory);
  assert.equal(none.value.status, 'complete', JSON.stringify(none.value));
  const result = none.value.operations[0].result;
  assert.deepEqual([result.outcome, result.reviews, result.url, result.coverage.review_page_opened, result.entry.click], ['no_reviews', [], null, false, null]);
  assert.equal(reviewClicks(quiet).length, 0);

  const server = await reviewsBridge(t, { reviewsLanding: 'https://mobile.pinduoduo.com/login.html?from=PRIVATE' });
  const directory = await stateDirectory(t);
  const ran = await productThenReviews(server, directory);
  assert.notEqual(ran.value.status, 'complete');
  assert.equal(ran.value.operations[0].error.code, 'LOGIN_REQUIRED');
  assert.equal(reviewClicks(server).length, 1);

  const common = ['--endpoint', server.endpoint, '--state-dir', directory];
  for (const [index, [args, code]] of [[['--reviews'], 'INVALID_ARGUMENTS'], [['--source-task', 'pdd-card-2', '--reviews', '--position', '2'], 'INVALID_ARGUMENTS'],
    [['--source-task', 'pdd-card-2', '--reviews', '--tab', '88'], 'INVALID_ARGUMENTS'], [['--source-task', 'pdd-search', '--reviews'], 'SOURCE_TASK_NOT_READY']].entries()) {
    assert.equal((await run(['task-start', '--platform', 'pdd', '--task', `pdd-refused-${index}`, ...args, ...common])).value.error.code, code, args.join(' '));
  }
});
