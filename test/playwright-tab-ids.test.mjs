import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { REPLACED_PAGE_MS, pageCode } from '../lib/playwright-service.mjs';

// A minimal stand-in for Playwright's Page and BrowserContext: enough to run the service's page code offline.
class FakePage extends EventEmitter {
  constructor(context, url) { super(); this.context_ = context; this.address = url; }
  context() { return this.context_; }
  url() { return this.address; }
  async goto(url) { this.address = url; }
  async close() { this.context_.open = this.context_.open.filter(item => item !== this); this.emit('close'); }
}

// Like Playwright's BrowserContext, it announces every new page with a 'page' event.
class FakeContext extends EventEmitter {
  constructor() { super(); this.open = []; }
  pages() { return [...this.open]; }
  add(url) { const page = new FakePage(this, url); this.open.push(page); this.emit('page', page); return page; }
  async newPage() { return this.add('about:blank'); }
}

// Run one service command body the way the MCP child does: the generated function receives any page of the context.
async function runBody(context, body) {
  const code = pageCode(100, body);
  const fn = (0, eval)(`(${code})`);
  return JSON.parse(await fn(context.open[0] ?? await context.newPage()));
}

const listIds = context => runBody(context, 'return JSON.stringify(listed().map(item => [item.__shopperTabId, item.url()]));');

test('a page that replaces itself on the same site keeps its tab ID', async () => {
  const context = new FakeContext();
  const orders = context.add('https://mobile.pinduoduo.com/orders.html');
  assert.deepEqual(await listIds(context), [[100, 'https://mobile.pinduoduo.com/orders.html']]);
  await orders.close();
  context.add('https://mobile.pinduoduo.com/orders.html');
  assert.deepEqual(await listIds(context), [[100, 'https://mobile.pinduoduo.com/orders.html']]);
});

test('pages the service opens or closes, other sites and late pages get new IDs', async t => {
  const context = new FakeContext();
  const first = await runBody(context, `const opened = label(await context.newPage(), true);
  await opened.goto('https://item.jd.com/1.html'); return JSON.stringify(opened.__shopperTabId);`);
  assert.equal(first, 100);
  await runBody(context, `const closing = tab(100); closing.__shopperClosedByService = true; await closing.close(); return JSON.stringify(true);`);
  context.add('https://item.jd.com/1.html');
  assert.deepEqual((await listIds(context)).map(([id]) => id), [101]);

  const web = () => context.open.find(item => item.url().startsWith('https:'));
  await web().close();
  context.add('https://search.jd.com/Search');
  assert.deepEqual((await listIds(context)).map(([id]) => id), [102]);
  assert.equal(REPLACED_PAGE_MS, 30_000);

  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });
  await web().close();
  const closedAt = realNow();
  Date.now = () => closedAt + REPLACED_PAGE_MS + 1;
  context.add('https://search.jd.com/Search');
  assert.deepEqual((await listIds(context)).map(([id]) => id), [103]);
});

test('a new page opened by the service never inherits a replaced ID', async () => {
  const context = new FakeContext();
  const orders = context.add('https://mobile.pinduoduo.com/orders.html');
  await listIds(context);
  await orders.close();
  const opened = await runBody(context, `const opened = label(await context.newPage(), true);
  await opened.goto('https://mobile.pinduoduo.com/orders.html'); return JSON.stringify(opened.__shopperTabId);`);
  assert.equal(opened, 101);
});

// 2026-11-08: a caller opened the PDD order list, then talked to the user for two minutes. The replacement page had
// appeared seconds after opening, but it was first listed two minutes later and got a new ID, so the task lost its page.
test('a replacement page keeps the ID when it is first listed long after it appeared', async t => {
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });
  let now = realNow();
  Date.now = () => now;
  const context = new FakeContext();
  const opened = await runBody(context, `const opened = label(await context.newPage(), true);
  await opened.goto('https://mobile.pinduoduo.com/orders.html'); return JSON.stringify(opened.__shopperTabId);`);
  assert.equal(opened, 100);
  now += 3_000;
  context.add('https://mobile.pinduoduo.com/orders.html');
  await context.open.find(item => item.__shopperTabId === 100).close();
  now += 2 * 60_000;
  assert.deepEqual((await listIds(context)).filter(([, url]) => url.startsWith('https:')), [[100, 'https://mobile.pinduoduo.com/orders.html']]);
});

test('a page that appears long after the same site closed still gets a new ID', async t => {
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });
  let now = realNow();
  Date.now = () => now;
  const context = new FakeContext();
  const orders = context.add('https://mobile.pinduoduo.com/orders.html');
  await listIds(context);
  await orders.close();
  now += REPLACED_PAGE_MS + 1;
  context.add('https://mobile.pinduoduo.com/orders.html');
  now += 60_000;
  assert.deepEqual((await listIds(context)).map(([id]) => id), [101]);
});
