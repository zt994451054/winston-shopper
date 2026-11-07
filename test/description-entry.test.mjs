import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { collectDescriptionEntry, descriptionExpansionScript, normalizeDescriptionEntry, descriptionEntryStatus, validateDescriptionObservation } from '../lib/description-entry.mjs';
import { detailsScript } from '../lib/details.mjs';
import { parseProductUrl } from '../lib/targets.mjs';
import { validateReadActionAcknowledgement } from '../lib/read-action.mjs';
import { rawDescription } from '../test-support/description-fixture.mjs';

const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
function node(tag, attributes = {}, children = []) {
  const value = { tagName: tag, children, innerText: attributes.text ?? '', open: false,
    getAttribute: key => attributes[key] ?? null, hasAttribute: key => Object.hasOwn(attributes, key),
    getClientRects: () => [{}], getBoundingClientRect: () => attributes.rect ?? { x: 30, y: 30, width: 100, height: 40 },
    matches(query) { return query.split(',').some(part => {
      part = part.trim();
      if (part.startsWith('.')) return (attributes.class ?? '').split(' ').includes(part.slice(1));
      if (part.startsWith('[class')) return (attributes.class ?? '').includes(part.match(/"([^"]+)"/)[1].trim());
      const attribute = part.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
      if (attribute) return attribute[2] === undefined ? value.hasAttribute(attribute[1]) : value.getAttribute(attribute[1]) === attribute[2];
      return part.toUpperCase() === tag;
    }); },
    contains(other) { return other === value || children.some(child => child.contains(other)); },
    closest(query) { for (let ancestor = value; ancestor; ancestor = ancestor.parentElement) if (ancestor.matches(query)) return ancestor; return null; },
    querySelectorAll(query) { return children.flatMap(child => [child, ...child.querySelectorAll('*')]).filter(child => query === '*' || child.matches(query)); },
  };
  children.forEach(child => { child.parentElement = value; });
  return value;
}
function fixture(native = false) {
  let clicks = 0;
  const container = node('DIV', { class: 'descV8-container', id: 'description-body' });
  const control = node(native ? 'SUMMARY' : 'BUTTON', { text: '展开详情', 'aria-controls': 'description-body', 'aria-expanded': 'false' });
  const details = node('DETAILS', {}, [control, container]);
  const root = node('DIV', { class: 'imageTextInfo--synthetic' }, native ? [details] : [control, container]);
  const body = node('BODY', {}, [root]);
  const document = { body, querySelectorAll: query => body.querySelectorAll(query), elementFromPoint: () => control, title: 'Product' };
  control.click = () => { clicks++; details.open = true; };
  const context = { document, innerWidth: 1000, innerHeight: 800, getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }), URL };
  const dom = { selector: () => '[class^="imageTextInfo--"]', all: (root, query) => root.querySelectorAll(query), text: (element, max) => element.innerText.slice(0, max) };
  const read = () => vm.runInNewContext(`(${collectDescriptionEntry.toString()})(dom)`, { ...context, dom }).observation;
  const activate = expected => {
    const script = descriptionExpansionScript(target, expected).replace(detailsScript(target), 'fixtureSnapshot');
    return vm.runInNewContext(script, { ...context, fixtureSnapshot: { state: 'observed' } });
  };
  return { container, control, details, root, body, context, document, read, activate, clicks: () => clicks };
}

test('an exact aria-controls relationship permits one guarded inline expansion', () => {
  const f = fixture(), entry = normalizeDescriptionEntry(f.read());
  assert.equal(descriptionEntryStatus(entry), 'collapsed');
  assert.equal(validateReadActionAcknowledgement(f.activate(entry)).clicked, true); assert.equal(f.clicks(), 1);
});
test('native details source can be inspected without reading its hidden body', () => {
  const f = fixture(true); Object.defineProperty(f.container, 'innerText', { get() { throw Error('Hidden body read'); } });
  const entry = normalizeDescriptionEntry(f.read()); assert.equal(entry.entries[0].kind, 'native_details');
  assert.equal(validateReadActionAcknowledgement(f.activate(entry)).clicked, true); assert.equal(f.details.open, true);
});
test('a user-opened native container is not toggled closed by the pending action', () => {
  const f = fixture(true), before = normalizeDescriptionEntry(f.read()); f.details.open = true;
  assert.equal(validateReadActionAcknowledgement(f.activate(before)).clicked, false); assert.equal(f.clicks(), 0);
});
test('an expansion label without a container relationship remains unverified', () => {
  const f = fixture(); f.container.getAttribute = () => null;
  assert.equal(descriptionEntryStatus(normalizeDescriptionEntry(f.read())), 'entry_unverified'); assert.equal(f.clicks(), 0);
});
test('a collapse label cannot turn a false expanded marker into an expansion action', () => {
  const f = fixture(); f.control.innerText = '收起详情';
  assert.equal(descriptionEntryStatus(normalizeDescriptionEntry(f.read())), 'entry_unverified'); assert.equal(f.clicks(), 0);
});
test('duplicate target IDs or multiple description containers cannot create a supported entry', () => {
  for (const extra of [node('DIV', { id: 'description-body' }), node('DIV', { class: 'descV8-container' })]) {
    const f = fixture(); f.root.children.push(extra); extra.parentElement = f.root;
    assert.equal(descriptionEntryStatus(normalizeDescriptionEntry(f.read())), 'entry_unverified');
  }
});
test('the action rejects a replaced source and a control obscured by another element', () => {
  const f = fixture(), before = normalizeDescriptionEntry(f.read());
  f.container.getAttribute = () => 'changed';
  assert.throws(() => validateReadActionAcknowledgement(f.activate(before)), { code: 'PAGE_STRUCTURE_CHANGED', actionNotDispatched: true });
  const covered = fixture(), saved = normalizeDescriptionEntry(covered.read()); covered.document.elementFromPoint = () => covered.body;
  assert.throws(() => validateReadActionAcknowledgement(covered.activate(saved)), { code: 'DESCRIPTION_ENTRY_UNAVAILABLE', actionNotDispatched: true });
  assert.equal(f.clicks() + covered.clicks(), 0);
});
test('offscreen or inert ancestry rejects the action without scrolling', () => {
  for (const [mutation, code] of [[f => { f.control.getBoundingClientRect = () => ({ x: 0, y: 2000, width: 100, height: 40 }); }, 'DESCRIPTION_ENTRY_UNAVAILABLE'],
    [f => { f.root.hasAttribute = key => key === 'inert'; }, 'PAGE_STRUCTURE_CHANGED']]) {
    const f = fixture(), before = normalizeDescriptionEntry(f.read()); mutation(f);
    assert.throws(() => validateReadActionAcknowledgement(f.activate(before)), { code, actionNotDispatched: true }); assert.equal(f.clicks(), 0);
  }
});
test('container targets, counts, extra fields and truncated scopes cannot be promoted', () => {
  const original = rawDescription().entry;
  for (const change of [v => { v.entries[0].target_id = 'x"], body'; }, v => { v.controls_scanned = 9; },
    v => { v.entries[0].position = 0; }, v => { v.private_state = 'PRIVATE'; }]) {
    const value = structuredClone(original); change(value); assert.throws(() => normalizeDescriptionEntry(value), { code: 'INVALID_RESPONSE' });
  }
  const truncated = { ...original, controls_seen: 9, controls_scanned: 8, controls_truncated: true };
  assert.equal(descriptionEntryStatus(normalizeDescriptionEntry(truncated)), 'entry_unverified');
  assert.throws(() => descriptionExpansionScript(target, truncated), { code: 'INVALID_RESPONSE' });
});
test('description reads check the original product before inspecting any entry', () => {
  const script = descriptionExpansionScript(target);
  const raw = vm.runInNewContext(script, { URL, location: { href: 'https://detail.tmall.com/item.htm?id=456' }, document: { querySelectorAll() { throw Error('DOM access on wrong product'); } } });
  assert.equal(raw.state, 'target_changed');
  assert.doesNotMatch(script, /scrollIntoView|fetch\(|XMLHttpRequest|localStorage|cookie/);
});
test('entry evidence and returned details must refer to the same observed description region', () => {
  const raw = rawDescription(); raw.entry.region_observed = false; raw.entry.container_count = 0; raw.entry.controls_seen = 0;
  raw.entry.controls_scanned = 0; raw.entry.potential_entries_seen = 0; raw.entry.entries = [];
  assert.throws(() => validateDescriptionObservation(raw, target), { code: 'INVALID_RESPONSE' });
});
