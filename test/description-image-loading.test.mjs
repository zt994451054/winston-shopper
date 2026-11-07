import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { descriptionImagePosition, descriptionImageLoadingScript, validateDescriptionImageObservation,
  validateDescriptionImageScroll, validateSavedDescriptionImageObservation, canLoadDescriptionImage } from '../lib/description-image-loading.mjs';
import { detailsScript } from '../lib/details.mjs';
import { parseProductUrl } from '../lib/targets.mjs';
import { rawDescriptionImage } from '../test-support/description-image-fixture.mjs';

const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
function node(tag, attributes = {}, children = []) {
  const value = { tagName: tag, children, clientLeft: 0, clientTop: 0, clientWidth: 900, clientHeight: 800,
    getAttribute: key => attributes[key] ?? null, hasAttribute: key => Object.hasOwn(attributes, key), getClientRects: () => [{}],
    getBoundingClientRect: () => attributes.rect ?? { x: 20, y: 1200, width: 500, height: 500 },
    matches(query) {
      return query.split(',').some(part => {
        part = part.trim();
        const descendant = part.match(/^(\.[\w-]+)\s+([\w-]+)$/);
        if (descendant) return part.endsWith(' ' + tag.toLowerCase()) && Boolean(value.parentElement?.closest(descendant[1]));
        if (part.startsWith('.')) return (attributes.class ?? '').split(' ').includes(part.slice(1));
        if (part.startsWith('[class')) return (attributes.class ?? '').includes(part.match(/"([^"]+)"/)[1].trim());
        return part.toUpperCase() === tag;
      });
    },
    closest(query) { for (let parent = value; parent; parent = parent.parentElement) if (parent.matches(query)) return parent; return null; },
    querySelectorAll(query) { return children.flatMap(child => [child, ...child.querySelectorAll('*')]).filter(child => query === '*' || child.matches(query)); },
  };
  children.forEach(child => { child.parentElement = value; });
  return value;
}
function fixture({ module = 'single' } = {}) {
  let scrolls = 0;
  const image = node('IMG', { class: module === 'rich' ? 'richImg' : 'descV8-singleImage-image' });
  image.scrollIntoView = () => { scrolls++; };
  const container = node('DIV', { class: 'descV8-container' }, [module === 'rich' ? node('DIV', { class: 'descV8-richtext' }, [image]) : image]);
  const root = node('DIV', { class: 'imageTextInfo--synthetic' }, [container]);
  const body = node('BODY', {}, [root]);
  const document = { body, title: 'Product', querySelectorAll: query => body.querySelectorAll(query) };
  const raw = rawDescriptionImage().snapshot;
  const context = { document, innerWidth: 1000, innerHeight: 800, getComputedStyle: element => element.style ?? { display: 'block', visibility: 'visible', opacity: '1' }, URL };
  const run = expected => vm.runInNewContext(descriptionImageLoadingScript(target, 1, expected).replace(detailsScript(target), 'fixtureSnapshot'), { ...context, fixtureSnapshot: raw });
  const read = () => validateDescriptionImageObservation(run(null), target, 1);
  return { image, container, root, body, context, raw, run, read, scrolls: () => scrolls };
}

test('description image read inspects one owned source without scrolling', () => {
  const f = fixture(), observation = f.read();
  assert.equal(canLoadDescriptionImage(observation), true); assert.equal(f.scrolls(), 0);
  assert.equal(observation.snapshot.details.description.image_readiness.entries[0].width, 1);
});
test('an image inside a rich-text module is inspected at its description position', () => {
  const f = fixture({ module: 'rich' }), initial = f.read();
  assert.equal(initial.scope.owned, true); assert.equal(initial.scope.images_seen, 1);
  assert.equal(validateDescriptionImageScroll(f.run(initial), target, 1, initial).scrolled, true); assert.equal(f.scrolls(), 1);
});
test('an unchanged offscreen tiny resource permits one normal guarded scroll', () => {
  const f = fixture(), initial = f.read();
  const receipt = validateDescriptionImageScroll(f.run(initial), target, 1, initial);
  assert.equal(receipt.scrolled, true); assert.equal(f.scrolls(), 1);
  assert.equal(receipt.observation.snapshot.details.description.image_readiness.entries[0].width, 1);
});
test('not-loaded supported resources can be guarded without being labelled loaded', () => {
  const f = fixture(); Object.assign(f.raw.details.description.items[0], { loaded: false, width: 0, height: 0 });
  const initial = f.read(); assert.equal(canLoadDescriptionImage(initial), true);
  assert.equal(validateDescriptionImageScroll(f.run(initial), target, 1, initial).scrolled, true);
});
test('changed source URL or image count prevents the pending scroll', () => {
  for (const change of [f => { f.raw.details.description.items[0].url = 'https://img.alicdn.com/other.jpg'; }, f => {
    const extra = node('IMG', { class: 'descV8-singleImage-image' }); f.container.children.push(extra); extra.parentElement = f.container;
    f.raw.details.description.items.push({ ...f.raw.details.description.items[0] }); f.raw.details.description.elements_seen++;
  }]) {
    const f = fixture(), before = f.read(); change(f);
    assert.throws(() => validateDescriptionImageScroll(f.run(before), target, 1, before), { code: 'PAGE_STRUCTURE_CHANGED' }); assert.equal(f.scrolls(), 0);
  }
});
test('a resource which already became normal skips scrolling and retains pre-action evidence', () => {
  const f = fixture(), before = f.read(); Object.assign(f.raw.details.description.items[0], { width: 800, height: 800 });
  const receipt = validateDescriptionImageScroll(f.run(before), target, 1, before);
  assert.equal(receipt.scrolled, false); assert.equal(receipt.reason, 'already_ready'); assert.equal(f.scrolls(), 0);
});
test('a newly-normal resource hidden before the action stops instead of claiming readiness', () => {
  const f = fixture(), before = f.read();
  Object.assign(f.raw.details.description.items[0], { width: 800, height: 800 }); f.container.style = { display: 'none' };
  assert.throws(() => validateDescriptionImageScroll(f.run(before), target, 1, before), { code: 'PAGE_STRUCTURE_CHANGED' });
  assert.equal(f.scrolls(), 0);
});
test('a forged already-ready acknowledgement without eligible geometry is rejected', () => {
  const before = validateDescriptionImageObservation(rawDescriptionImage(), target, 1);
  const observation = rawDescriptionImage({ normal: true, url: 'https://img.alicdn.com/tiny.png' }); observation.scope.geometry = null;
  assert.throws(() => validateDescriptionImageScroll({ observation, scrolled: false, reason: 'already_ready' }, target, 1, before), { code: 'INVALID_RESPONSE' });
});
test('a user-visible image is not scrolled again by a previously reserved action', () => {
  const f = fixture(), before = f.read(); f.image.getBoundingClientRect = () => ({ x: 20, y: 20, width: 500, height: 500 });
  assert.equal(validateDescriptionImageScroll(f.run(before), target, 1, before).reason, 'already_in_view'); assert.equal(f.scrolls(), 0);
});
test('clipping ancestors are included even when the image box is inside the viewport', () => {
  const f = fixture(); f.image.getBoundingClientRect = () => ({ x: 20, y: 20, width: 500, height: 500 });
  f.container.style = { overflowY: 'hidden' }; f.container.getBoundingClientRect = () => ({ x: 0, y: 0, width: 900, height: 100 }); f.container.clientHeight = 100;
  const observation = f.read(); assert.equal(observation.scope.geometry.intersection.height, 80);
  assert.equal(observation.scope.geometry.fully_in_view, false); assert.equal(canLoadDescriptionImage(observation), true);
});
test('hidden, inert and video ancestry cannot become a scroll candidate', () => {
  for (const change of [f => { f.container.style = { display: 'none' }; }, f => { f.container.hasAttribute = name => name === 'inert'; },
    f => { f.container.getAttribute = name => name === 'class' ? 'descV8-container descV8-video' : null; }]) {
    const f = fixture(); change(f); const current = f.read();
    assert.equal(canLoadDescriptionImage(current), false); assert.equal(current.scope.geometry, null); assert.equal(f.scrolls(), 0);
  }
});
test('multiple description containers keep source ownership unverified', () => {
  const f = fixture(), extra = node('DIV', { class: 'descV8-container' }); f.root.children.push(extra); extra.parentElement = f.root;
  const current = f.read(); assert.equal(current.scope.owned, false); assert.equal(canLoadDescriptionImage(current), false);
});
test('a verification gate appearing after the read prevents the reserved scroll', () => {
  const f = fixture(), before = f.read(), verification = node('DIV');
  const original = f.context.document.querySelectorAll;
  f.context.document.querySelectorAll = query => query.startsWith('#nc_1_wrapper') ? [verification] : original(query);
  assert.throws(() => validateDescriptionImageScroll(f.run(before), target, 1, before), { code: 'VERIFICATION_REQUIRED' });
  assert.equal(f.scrolls(), 0);
});
test('malformed positions are rejected before generating a script', () => {
  for (const position of [0, 61, 1.1, NaN, '1']) assert.throws(() => descriptionImagePosition(position), { code: 'INVALID_ARGUMENTS' });
});
test('forged geometry, source counts or action claims fail validation', () => {
  for (const change of [v => { v.scope.images_seen++; }, v => { v.scope.geometry.intersection.width = 501; },
    v => { v.scope.geometry.fully_in_view = true; }]) {
    const raw = rawDescriptionImage(); change(raw); assert.throws(() => validateDescriptionImageObservation(raw, target, 1), { code: 'INVALID_RESPONSE' });
  }
  const f = fixture(), before = f.read(), response = f.run(before); response.reason = 'already_ready';
  assert.throws(() => validateDescriptionImageScroll(response, target, 1, before), { code: 'INVALID_RESPONSE' });
});
test('legacy snapshots without readiness cannot be promoted into loading evidence', () => {
  const raw = rawDescriptionImage(); delete raw.snapshot.details.description.image_readiness_observed;
  assert.throws(() => validateDescriptionImageObservation(raw, target, 1), { code: 'INVALID_RESPONSE' });
});
test('saved evidence rejects additional fields and impossible ownership', () => {
  const value = validateDescriptionImageObservation(rawDescriptionImage(), target, 1); value.scope.extra = true;
  assert.throws(() => validateSavedDescriptionImageObservation(value, target, 1), { code: 'INVALID_CHECKPOINT' });
});
test('scroll script embeds only the finite image source rather than unrelated detail text', () => {
  const raw = rawDescriptionImage(); raw.snapshot.details.description.text = 'UNRELATED_BODY_TEXT';
  const value = validateDescriptionImageObservation(raw, target, 1);
  const script = descriptionImageLoadingScript(target, 1, value);
  assert.equal(script.includes('UNRELATED_BODY_TEXT'), false); assert(script.length < 262144);
});
