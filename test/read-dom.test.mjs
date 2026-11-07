import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { searchScript, searchTarget, validateSearch } from '../lib/search.mjs';
import { reviewsScript, validateReviews } from '../lib/reviews.mjs';
import { parseProductUrl } from '../lib/targets.mjs';
import { detailsScript, validateDetails, validateSavedDetails } from '../lib/details.mjs';
import { productScript, selectionScript, validateProduct, validateSavedProduct, validateSelectionAcknowledgement } from '../lib/product.mjs';
import { searchPagesScript, searchPagesDiagnosticScript, validateSearchPage } from '../lib/search-pages.mjs';
import { validateReadActionAcknowledgement } from '../lib/read-action.mjs';
import { searchSortScript, searchSortTargetScript, searchSortDiagnosticScript, validateSearchSort } from '../lib/search-sort.mjs';
import { searchControlsScript, validateSearchControls } from '../lib/search-controls.mjs';
import { priceEntryScript, validatePriceEntry } from '../lib/price-entry.mjs';
import { priceRegionScript } from '../lib/price-region.mjs';
import { reviewCategoriesScript, validateReviewCategoryObservation } from '../lib/review-categories.mjs';
import { reviewPanelScript, reviewPanelCloseScript, validateReviewPanelState } from '../lib/review-panel.mjs';
import { mainImageScript, validateMainImageObservation } from '../lib/main-images.mjs';
import { galleryScript, validateGallery } from '../lib/gallery.mjs';
import { specificationImagesScript, specificationImageBatchScript, validateSpecificationImages } from '../lib/specification-images.mjs';
import { specificationCollectionScript, validateSpecificationCollectionObservation } from '../lib/specification-images.mjs';

test('names-only inventory includes all scanned text options without reading any IMG source or dimensions', () => {
  const f = specificationImageFixture(61);
  f.options[60].children.pop();
  for (const image of f.images) for (const field of ['currentSrc', 'naturalWidth', 'naturalHeight', 'complete']) {
    Object.defineProperty(image, field, { get() { throw Error('Image read during name inventory'); } });
  }
  const script = specificationCollectionScript(f.target, { inventory: null, positions: [], inventory_only: true });
  const result = validateSpecificationCollectionObservation(evaluate(script, f.target.url, [f.root]), f.target);
  assert.equal(result.inventory.groups[0].options.length, 61);
  assert.equal(result.inventory.groups[0].options[60].image_regions_seen, 0);
  assert.equal(result.samples.length, 0);
  assert.doesNotMatch(script, /\.click\(|scrollIntoView|fetch\(|XMLHttpRequest/);
  assert.equal(evaluate(script, 'https://detail.tmall.com/item.htm?id=456', [f.root]).state, 'target_changed');
});

test('names-only plans reject image positions, nonempty inventories and loading actions', () => {
  const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
  for (const plan of [
    { inventory: null, positions: [] }, { inventory: null, positions: null, inventory_only: true },
    { inventory: {}, positions: [], inventory_only: true }, { inventory: null, positions: [], inventory_only: false },
    { inventory: null, positions: [], inventory_only: true, scroll: {} },
    { inventory: null, positions: [], inventory_only: true, after_scroll: 1 },
    { inventory: null, positions: [{ group_position: 1, position: 1 }], inventory_only: true }
  ]) assert.throws(() => specificationCollectionScript(target, plan), { code: 'INVALID_ARGUMENTS' });
});

test('collection reads every scanned label including text-only options but only five image resources per call', () => {
  const f = specificationImageFixture(12);
  f.options[2].children.pop();
  for (const image of f.images.slice(6)) Object.defineProperty(image, 'currentSrc', { get() { throw Error('Unsampled URL read'); } });
  const script = specificationCollectionScript(f.target, { inventory: null, positions: null });
  const result = validateSpecificationCollectionObservation(evaluate(script, f.target.url, [f.root]), f.target);
  assert.equal(result.inventory.groups[0].options.length, 12);
  assert.equal(result.inventory.groups[0].options[2].image_regions_seen, 0);
  assert.deepEqual(Array.from(result.samples, option => option.position), [1, 2, 4, 5, 6]);
  assert.doesNotMatch(script, /\.click\(|scrollIntoView|fetch\(|XMLHttpRequest/);
});

test('collection checks the entire scanned inventory before reading new or missing image URLs', () => {
  const f = specificationImageFixture(12);
  const first = validateSpecificationCollectionObservation(evaluate(specificationCollectionScript(f.target,
    { inventory: null, positions: null }), f.target.url, [f.root]), f.target);
  f.options[11].children[0].innerText = '改变的未读选项';
  for (const image of f.images) Object.defineProperty(image, 'currentSrc', { get() { throw Error('URL read after list changed'); } });
  const raw = evaluate(specificationCollectionScript(f.target, { inventory: first.inventory,
    positions: [{ group_position: 1, position: 6 }] }), f.target.url, [f.root]);
  assert.equal(raw.state, 'specification_image_inventory_changed');
});

test('collection can revisit a missing image without reading valid siblings or changing selection', () => {
  const f = specificationImageFixture(7);
  const first = validateSpecificationCollectionObservation(evaluate(specificationCollectionScript(f.target,
    { inventory: null, positions: null }), f.target.url, [f.root]), f.target);
  for (const image of f.images.slice(1)) Object.defineProperty(image, 'currentSrc', { get() { throw Error('Resolved sibling reread'); } });
  f.images[0].naturalWidth = 2; f.images[0].naturalHeight = 2;
  const result = validateSpecificationCollectionObservation(evaluate(specificationCollectionScript(f.target,
    { inventory: first.inventory, positions: [{ group_position: 1, position: 1 }] }), f.target.url, [f.root]), f.target);
  assert.equal(result.samples.length, 1);
  assert.equal(result.samples[0].image.width, 2);
  assert.equal(result.samples[0].association.sku_id, null);
});

test('collection retains target gates, hidden ancestry and structural scan omissions', () => {
  const f = specificationImageFixture(101);
  const script = specificationCollectionScript(f.target, { inventory: null, positions: null });
  const result = validateSpecificationCollectionObservation(evaluate(script, f.target.url, [f.root]), f.target);
  assert.equal(result.inventory.groups[0].options_seen, 101);
  assert.equal(result.inventory.groups[0].options.length, 100);
  assert.equal(evaluate(script, 'https://detail.tmall.com/item.htm?id=456', [f.root]).state, 'target_changed');
  const verification = evaluate(script, f.target.url, [f.root, element('', '请完成验证', [], { id: 'baxia-dialog-content' })]);
  assert.notEqual(verification.state, 'observed');
});

function specificationImageFixture(count = 2) {
  const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
  const images = Array.from({ length: count }, (_, index) => element('', '', [], { tagName: 'IMG',
    currentSrc: `https://img.alicdn.com/spec-${index}.jpg`, complete: true, naturalWidth: 80, naturalHeight: 80 }));
  const options = images.map((image, index) => element('valueItem', '', [
    element('valueItemText', `颜色${index}`), element('valueItemImgWrap', '', [image]) ]));
  const group = element('skuItem', '', [element('ItemLabel', '颜色'), ...options]);
  const root = element('skuWrapper', '', [group]);
  const read = (extra = [], roots = [root]) => evaluate(specificationImagesScript(target), target.url, [...roots, ...extra]);
  return { target, root, group, options, images, read };
}

function specificationLoadingFixture() {
  const f = specificationImageFixture(2), image = f.images[0];
  image.naturalWidth = 2; image.naturalHeight = 2;
  let top = 1200, scrolls = 0;
  image.getBoundingClientRect = () => ({ x: 100, y: top, width: 32, height: 32 });
  image.scrollIntoView = () => { scrolls++; top = 200; };
  const first = validateSpecificationCollectionObservation(evaluate(specificationCollectionScript(f.target,
    { inventory: null, positions: null }), f.target.url, [f.root]), f.target);
  const plan = { inventory: first.inventory, positions: [{ group_position: 1, position: 1 }],
    scroll: { expected_image: { url: image.currentSrc, width: 2, height: 2 } } };
  return { ...f, image, plan, top: value => { top = value; }, scrolls: () => scrolls,
    guard: (extra = [], url = f.target.url) => evaluate(specificationCollectionScript(f.target, plan), url, [f.root, ...extra]) };
}

test('a guarded offscreen tiny IMG scrolls once and retains its pre-action source even if loading is immediate', () => {
  const f = specificationLoadingFixture(), scroll = f.image.scrollIntoView;
  f.image.scrollIntoView = () => { scroll(); f.image.currentSrc = 'https://img.alicdn.com/loaded.jpg'; f.image.naturalWidth = 800; f.image.naturalHeight = 800; };
  const result = validateSpecificationCollectionObservation(f.guard(), f.target);
  assert.equal(f.scrolls(), 1); assert.equal(result.loading.action, 'scrolled');
  assert.equal(result.loading.geometry.fully_in_view, false); assert.equal(result.samples[0].image.width, 2);
  const after = validateSpecificationCollectionObservation(evaluate(specificationCollectionScript(f.target,
    { inventory: f.plan.inventory, positions: f.plan.positions }), f.target.url, [f.root]), f.target);
  assert.equal(after.samples[0].image.width, 800); assert.equal(after.samples[0].association.sku_id, null);
  assert.doesNotMatch(specificationCollectionScript(f.target, f.plan), /\.click\(|fetch\(|XMLHttpRequest/);
});

test('already visible or independently changed image sources skip scrolling', () => {
  const f = specificationLoadingFixture(); f.top(200);
  assert.equal(f.guard().loading.reason, 'already_in_view'); assert.equal(f.scrolls(), 0);
  f.top(1200); f.image.naturalWidth = 800; f.image.naturalHeight = 800;
  assert.equal(f.guard().loading.reason, 'source_changed'); assert.equal(f.scrolls(), 0);
  f.image.naturalWidth = 2; f.image.naturalHeight = 2; f.image.currentSrc = 'https://img.alicdn.com/different-tiny.png';
  assert.equal(f.guard().loading.reason, 'source_changed'); assert.equal(f.scrolls(), 0);
});

test('ancestor clipping can trigger a guarded scroll even inside the document viewport', () => {
  const f = specificationLoadingFixture(); f.top(200);
  const wrapper = f.image.parentElement;
  wrapper.style = { overflowY: 'auto' }; wrapper.getBoundingClientRect = () => ({ x: 90, y: 100, width: 80, height: 40 });
  Object.assign(wrapper, { clientLeft: 0, clientTop: 0, clientWidth: 80, clientHeight: 40 });
  const result = validateSpecificationCollectionObservation(f.guard(), f.target);
  assert.equal(result.loading.geometry.clip_ancestors, 1); assert.equal(result.loading.geometry.intersection.height, 0);
  assert.equal(f.scrolls(), 1);
});

test('wrong identity, login, verification and an unknown action dialog prevent scrolling', () => {
  const f = specificationLoadingFixture();
  assert.equal(f.guard([], 'https://detail.tmall.com/item.htm?id=456').state, 'target_changed');
  for (const [text, attrs, state] of [['请完成验证', { id: 'baxia-dialog' }, 'verification_required'],
    ['扫码登录', { role: 'dialog' }, 'login_required'], ['', { role: 'dialog' }, 'blocked_unknown']]) {
    assert.equal(f.guard([element('', text, [], attrs)]).state, state);
  }
  assert.equal(f.scrolls(), 0);
});

test('inventory drift or conflicting selection markers stops before scrolling', () => {
  const f = specificationLoadingFixture(); f.options[1].children[0].innerText = 'changed';
  assert.equal(f.guard().state, 'specification_image_inventory_changed'); assert.equal(f.scrolls(), 0);
  const g = specificationLoadingFixture(); g.options.forEach(option => option.setAttribute('aria-selected', 'true'));
  assert.equal(g.guard().state, 'structure_changed'); assert.equal(g.scrolls(), 0);
});

test('ambiguous image elements retain their missing status without selecting a scroll target', () => {
  const f = specificationLoadingFixture(), wrapper = f.image.parentElement;
  const duplicate = element('', '', [], { tagName: 'IMG' }); duplicate.parentElement = wrapper; wrapper.children.push(duplicate);
  const result = validateSpecificationCollectionObservation(f.guard(), f.target);
  assert.equal(result.samples[0].image.status, 'ambiguous_image_elements'); assert.equal(result.loading.reason, 'source_unavailable');
  assert.equal(f.scrolls(), 0);
});

test('loading plans reject unbounded positions, normal-sized prior images and truncated inventories', () => {
  const f = specificationLoadingFixture();
  for (const mutate of [p => { p.positions.push({ group_position: 1, position: 2 }); },
    p => { p.scroll.expected_image.width = 800; p.scroll.expected_image.height = 800; },
    p => { p.inventory.groups[0].options_seen++; }, p => { p.scroll.expected_image.url = 'https://untrusted.invalid/image.jpg'; }]) {
    const plan = structuredClone(f.plan); mutate(plan);
    assert.throws(() => specificationCollectionScript(f.target, plan), { code: 'INVALID_ARGUMENTS' });
  }
});

test('invalid geometry, falsely reported scrolls and action timestamps cannot become accepted observations', () => {
  const f = specificationLoadingFixture(), raw = JSON.parse(JSON.stringify(f.guard()));
  for (const mutate of [r => { r.loading.geometry.fully_in_view = true; }, r => { r.loading.geometry.intersection.width = 100; },
    r => { r.samples[0].image.width = 800; r.samples[0].image.height = 800; }, r => { r.loading.action_observed_at = '2020-01-01T00:00:00.000Z'; }]) {
    const value = structuredClone(raw); mutate(value); assert.throws(() => validateSpecificationCollectionObservation(value, f.target), { code: 'INVALID_RESPONSE' });
  }
});

test('specification image continuation starts at the sixth option without rereading previous URLs', () => {
  const f = specificationImageFixture(12);
  const first = validateSpecificationImages(f.read(), f.target);
  for (const image of f.images.slice(0, 5)) Object.defineProperty(image, 'currentSrc', { get() { throw Error('Previous URL reread'); } });
  const readBatch = batches => validateSpecificationImages(evaluate(specificationImageBatchScript(f.target, batches), f.target.url, [f.root]), f.target);
  const second = readBatch([first]);
  assert.equal(second.schema_version, 2);
  assert.deepEqual(Array.from(second.groups[0].options, option => option.position), [6, 7, 8, 9, 10]);
  assert.equal(second.batch.offset, 5); assert.equal(second.batch.remaining, 2);
  const third = readBatch([first, second]);
  assert.deepEqual(Array.from(third.groups[0].options, option => option.position), [11, 12]);
  assert.equal(third.batch.remaining, 0);
});

test('continuation stops before image URLs when previous labels, positions or group counts change', () => {
  for (const mutate of [f => { f.options[0].children[0].innerText = '另一规格'; },
    f => { f.group.children.splice(1, 2, f.options[1], f.options[0]); },
    f => { f.group.children.pop(); }, f => { f.group.children[0].innerText = '另一分组'; },
    f => { f.options[0].children.pop(); }]) {
    const f = specificationImageFixture(8), first = validateSpecificationImages(f.read(), f.target);
    mutate(f);
    for (const image of f.images) Object.defineProperty(image, 'currentSrc', { get() { throw Error('Changed inventory image read'); } });
    const observed = evaluate(specificationImageBatchScript(f.target, [first]), f.target.url, [f.root]);
    assert.equal(observed.state, 'specification_image_inventory_changed');
    assert.throws(() => validateSpecificationImages(observed, f.target), { code: 'SPECIFICATION_IMAGE_INVENTORY_CHANGED' });
  }
});

test('batch continuation crosses groups, preserves repeated URLs and does not need the selected state to stay fixed', () => {
  const f = specificationImageFixture(3), secondGroup = specificationImageFixture(4);
  f.root.children.push(secondGroup.group); secondGroup.group.parentElement = f.root;
  const first = validateSpecificationImages(f.read(), f.target);
  f.options[0].setAttribute('aria-selected', 'true');
  const value = evaluate(specificationImageBatchScript(f.target, [first]), f.target.url, [f.root]);
  const next = validateSpecificationImages(value, f.target);
  assert.equal(next.groups[0].options.length, 0);
  assert.deepEqual(Array.from(next.groups[1].options, option => option.position), [3, 4]);
  assert.equal(next.batch.remaining, 0);
  assert.equal(next.groups[1].options[0].image.url, first.groups[0].options[2].image.url);
});

test('line breaks in unchanged group and option labels do not spuriously reject continuation', () => {
  const f = specificationImageFixture(7);
  f.group.children[0].innerText = '颜色\n分类'; f.options[0].children[0].innerText = '黑色\n套餐';
  const first = validateSpecificationImages(f.read(), f.target);
  assert.equal(first.groups[0].name, '颜色 分类');
  const next = validateSpecificationImages(evaluate(specificationImageBatchScript(f.target, [first]), f.target.url, [f.root]), f.target);
  assert.equal(next.batch.offset, 5); assert.equal(next.batch.remaining, 0);
});

test('option images bind to their own wrapper and option while ignoring title, price, gallery and unknown overlays', () => {
  const f = specificationImageFixture();
  f.options[0].setAttribute('aria-selected', 'true');
  f.options[1].setAttribute('data-disabled', 'true');
  const forbidden = element('picGallery', '', [element('thumbnailPic', '', [], { tagName: 'IMG' })]);
  Object.defineProperty(forbidden.children[0], 'currentSrc', { get() { throw Error('Unrelated image read'); } });
  f.options.forEach(option => { option.click = () => { throw Error('No click'); }; });
  const observed = f.read([forbidden, element('', '活动', [], { role: 'dialog' })]);
  const result = validateSpecificationImages(observed, f.target);
  assert.equal(result.groups[0].options[0].selected, true);
  assert.equal(result.groups[0].options[1].disabled, true);
  assert.equal(result.groups[0].options[0].image.url, f.images[0].currentSrc);
  assert.equal(result.groups[0].options[1].image.url, f.images[1].currentSrc);
  assert.equal(result.groups[0].options[1].association.option_binding_verified, true);
  assert.equal(result.coverage.selected_combination_verified, false);
});

test('first five image-bearing options keep original positions and do not inspect later image URLs', () => {
  const f = specificationImageFixture(7);
  const textOnly = element('valueItem', '', [element('valueItemText', '文字选项')]);
  f.group.children.splice(1, 0, textOnly); textOnly.parentElement = f.group;
  for (const image of f.images.slice(5)) Object.defineProperty(image, 'currentSrc', { get() { throw Error('Beyond image sample'); } });
  const result = validateSpecificationImages(f.read(), f.target);
  assert.deepEqual(Array.from(result.groups[0].options, option => option.position), [2, 3, 4, 5, 6]);
  assert.equal(result.scope.image_options_seen, 7);
  assert.equal(result.scope.image_options_omitted, 2);
  assert.equal(result.scope.options_scanned, 8);
});

test('image option sampling budget is shared across groups', () => {
  const first = specificationImageFixture(3), second = specificationImageFixture(4);
  first.root.children.push(second.group); second.group.parentElement = first.root;
  for (const image of second.images.slice(2)) Object.defineProperty(image, 'currentSrc', { get() { throw Error('Cross-group budget exceeded'); } });
  const result = validateSpecificationImages(first.read(), first.target);
  assert.equal(result.groups[0].options.length, 3);
  assert.equal(result.groups[1].options.length, 2);
  assert.equal(result.scope.image_options_sampled, 5);
  assert.equal(result.scope.image_options_omitted, 2);
});

test('hidden ancestors and known video containers exclude image URLs before they are read', () => {
  const f = specificationImageFixture(3);
  f.options[0].children[1].setAttribute('aria-hidden', 'true');
  const video = element('videoPicWrap', '', [f.images[1]]);
  f.options[1].children[1].children[0] = video; video.parentElement = f.options[1].children[1];
  for (const image of f.images.slice(0, 2)) Object.defineProperty(image, 'currentSrc', { get() { throw Error('Excluded image URL'); } });
  const result = validateSpecificationImages(f.read(), f.target);
  assert.deepEqual(Array.from(result.groups[0].options, option => option.position), [2, 3]);
  assert.equal(result.groups[0].options[0].image.status, 'image_element_not_observed');
  assert.equal(result.availability.returned_images, 1);
  const hiddenRoot = element('', '', [f.root], { 'aria-hidden': 'true' });
  assert.equal(f.read([], [hiddenRoot]).state, 'unsupported');
});

test('ambiguous wrappers or multiple images are recorded without choosing or reading any URL', () => {
  const f = specificationImageFixture();
  const another = element('', '', [], { tagName: 'IMG' });
  f.options[0].children[1].children.push(another); another.parentElement = f.options[0].children[1];
  const wrapper = element('valueItemImgWrap');
  f.options[1].children.push(wrapper); wrapper.parentElement = f.options[1];
  for (const image of [...f.images, another]) Object.defineProperty(image, 'currentSrc', { get() { throw Error('Ambiguous source read'); } });
  const result = validateSpecificationImages(f.read(), f.target);
  assert.equal(result.groups[0].options[0].image.status, 'ambiguous_image_elements');
  assert.equal(result.groups[0].options[1].image.status, 'ambiguous_image_regions');
  assert.equal(result.availability.returned_images, 0);
});

test('unloaded src is preserved and unsupported background-only wrappers are not called empty SKUs', () => {
  const f = specificationImageFixture();
  f.images[0].currentSrc = ''; f.images[0].setAttribute('src', 'https://img.alicdn.com/not-loaded.jpg');
  f.images[0].complete = false; f.images[0].naturalWidth = 0; f.images[0].naturalHeight = 0;
  f.options[1].children[1].children.length = 0;
  const result = validateSpecificationImages(f.read(), f.target);
  assert.equal(result.groups[0].options[0].image.loaded, false);
  assert.equal(result.groups[0].options[0].image.url, 'https://img.alicdn.com/not-loaded.jpg');
  assert.equal(result.groups[0].options[1].image.status, 'image_element_not_observed');
  assert.equal(result.groups[0].options[1].association.sku_id, null);
});

test('multiple specification roots, nested owners and ambiguous or truncated labels stop structural reads', () => {
  const f = specificationImageFixture(), other = specificationImageFixture();
  assert.equal(f.read([], [f.root, other.root]).state, 'structure_changed');
  const nested = specificationImageFixture();
  nested.options[0].children.push(nested.options[1]); nested.options[1].parentElement = nested.options[0];
  assert.equal(nested.read().state, 'structure_changed');
  for (const mutate of [option => { option.children[0].innerText = 'a'.repeat(201); },
    option => { const label = element('valueItemText', '另一个'); option.children.push(label); label.parentElement = option; }]) {
    const ambiguous = specificationImageFixture(); mutate(ambiguous.options[0]);
    assert.equal(ambiguous.read().state, 'structure_changed');
  }
});

test('specification image reads retain explicit login, verification and rate gates before option data', () => {
  for (const [node, state] of [[element('', '', [], { id: 'baxia-dialog' }), 'verification_required'],
    [element('', '扫码登录', [], { role: 'dialog' }), 'login_required'],
    [element('', '访问频繁', [], { role: 'dialog' }), 'rate_limited']]) {
    const f = specificationImageFixture();
    Object.defineProperty(f.images[0], 'currentSrc', { get() { throw Error('Gated image read'); } });
    assert.equal(f.read([node]).state, state);
  }
});

test('only the first eight groups and hundred option structures per group are sampled', () => {
  const f = specificationImageFixture(101);
  const groups = Array.from({ length: 8 }, () => specificationImageFixture(1).group);
  groups.forEach(group => { f.root.children.push(group); group.parentElement = f.root; });
  const result = validateSpecificationImages(f.read(), f.target);
  assert.equal(result.scope.groups_seen, 9);
  assert.equal(result.scope.groups_scanned, 8);
  assert.equal(result.scope.groups_omitted, 1);
  assert.equal(result.scope.options_unscanned_in_scanned_groups, 1);
  assert.equal(result.scope.image_options_seen, 107);
  assert.equal(result.scope.image_options_sampled, 5);
  assert.equal(result.scope.image_options_omitted, 102);
});

function matchesSelector(item, query) {
  const className = typeof item.className === 'string' ? item.className : item.className?.baseVal ?? '';
  if (query.startsWith(':is(')) {
    const index = Number(query.match(/:nth-child\((\d+)\)$/)?.[1]);
    return item.getAttribute('role') === 'tab' && (!query.includes('customTabItemWithArr--') || className.includes('customTabItemWithArr--')) &&
      item.parentElement?.children.indexOf(item) === index - 1 && Boolean(item.closest('[class^="sortBarWrapper--"]'));
  }
  return query.split(',').some(part => {
    const descendant = part.trim().match(/^([.#]?[\w-]+)\s+([.#]?[\w-]+)$/);
    if (descendant) return matchesSelector(item, descendant[2]) && Boolean(item.parentElement?.closest(descendant[1]));
    if (/^(div|li|span|button|a|img|video|input|textarea)$/.test(part.trim())) return item.tagName === part.trim().toUpperCase();
    const prefixMatch = part.match(/\[class(?:\^|\*)=" ?([^" ]+)--"\]/);
    if (prefixMatch) return className.split(/\s+/).some(token => token.startsWith(`${prefixMatch[1]}--`));
    if (part.trim() === 'input[name="q"]') return item.tagName === 'INPUT' && item.getAttribute('name') === 'q';
    if (part.trim().startsWith('#')) return item.getAttribute('id') === part.trim().slice(1);
    if (part.trim().startsWith('.')) return className.split(/\s+/).includes(part.trim().slice(1));
    if (part.trim() === 'a') return item.tagName === 'A';
    if (part.trim() === 'button') return item.tagName === 'BUTTON';
    if (part.trim() === '[aria-current]') return item.getAttribute('aria-current') !== null;
    const buttonClass = part.trim().match(/^button\.([a-z-]+)$/);
    if (buttonClass) return item.tagName === 'BUTTON' && className.split(/\s+/).includes(buttonClass[1]);
    if (part.trim() === '[role="tab"][aria-selected="true"]') return item.getAttribute('role') === 'tab' && item.getAttribute('aria-selected') === 'true';
    const role = part.match(/^\s*\[(role|aria-modal)="([^"]+)"\]/);
    return role ? item.getAttribute(role[1]) === role[2] : part.trim() === 'iframe' && item.tagName === 'IFRAME';
  });
}

function element(prefix = '', text = '', children = [], attributes = {}) {
  const node = { nodeType: 1, tagName: 'DIV', className: prefix ? `${prefix}--synthetic` : '', innerText: text, children, ...attributes,
    get childNodes() { return attributes.childNodes ?? [...(this.innerText ? [{ nodeType: 3, nodeValue: this.innerText }] : []), ...children]; },
    getAttribute(name) { return attributes[name] ?? null; }, setAttribute(name, value) { attributes[name] = value; },
    getClientRects() { return attributes.hidden ? [] : [{}]; },
    getBoundingClientRect() { return attributes.rect ?? { x: 100, y: 100, width: 80, height: 30 }; },
    matches(query) { return matchesSelector(this, query); },
    contains(other) { return this === other || children.some(child => child.contains(other)); },
    closest(query) {
      for (let parent = this; parent; parent = parent.parentElement) if (parent.matches(query)) return parent;
      return null;
    },
    querySelectorAll(query) {
      const descendants = children.flatMap(child => [child, ...child.querySelectorAll('*')]);
      return query === '*' ? descendants : descendants.filter(item => matchesSelector(item, query));
    } };
  children.forEach(child => { child.parentElement = node; });
  return node;
}

function evaluate(script, url, nodes, title = 'Synthetic product', elementsFromPoint = () => []) {
  return vm.runInNewContext(script, { URL, innerWidth: 1000, innerHeight: 800, location: { href: url },
    document: Object.assign(element('', '', nodes), { title, readyState: 'complete', elementsFromPoint }),
    getComputedStyle: node => ({ display: node.hidden ? 'none' : 'block', visibility: 'visible', ...node.style }) });
}

test('product reads report the failed region without returning page text or changing the stop code', () => {
  const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
  const title = () => element('ItemTitle', 'PRIVATE_PRODUCT_TEXT');
  for (const [nodes, reason] of [
    [[], 'title_missing'],
    [[title(), title()], 'title_ambiguous'],
    [[title(), element('skuWrapper'), element('skuWrapper')], 'specification_region_ambiguous'],
    [[title(), element('normalPrice'), element('beltPrice')], 'price_region_ambiguous'],
  ]) {
    const raw = evaluate(productScript(target), target.url, nodes);
    assert.equal(raw.reason, reason);
    assert.deepEqual(Object.keys(raw).sort(), ['reason', 'state']);
    assert.throws(() => validateProduct(raw, target), error => {
      assert.equal(error.code, 'PAGE_STRUCTURE_CHANGED');
      assert.equal(error.productStructureReason, reason);
      assert.ok(!JSON.stringify(error).includes('PRIVATE_PRODUCT_TEXT'));
      return true;
    });
  }
});

test('selection structural failures keep their reason and remain undispatched', () => {
  const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
  const choice = { group: 'Color', option: 'Black' };
  const raw = evaluate(selectionScript(target, choice), target.url, [element('ItemTitle', 'One'), element('ItemTitle', 'Two')]);
  assert.throws(() => validateSelectionAcknowledgement(raw, choice), {
    code: 'PAGE_STRUCTURE_CHANGED', productStructureReason: 'title_ambiguous', actionNotDispatched: true,
  });
});

test('identity and verification gates take precedence over structure diagnostics', () => {
  const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
  const nodes = [element('ItemTitle', 'One'), element('ItemTitle', 'Two'), element('', '', [], { id: 'baxia-dialog-content' })];
  for (const [url, state] of [[target.url, 'verification_required'], ['https://detail.tmall.com/item.htm?id=456', 'target_changed']]) {
    const raw = evaluate(productScript(target), url, nodes);
    assert.equal(raw.state, state);
    assert.equal(raw.reason, undefined);
  }
});

function mainGalleryFixture(options = {}) {
  const target = parseProductUrl('https://item.taobao.com/item.htm?id=123'), source = 'https://img.alicdn.com/thumb.jpg';
  let clicks = 0;
  const thumbnail = element('thumbnailPic', '', [], { tagName: 'IMG', currentSrc: source, click: () => { clicks++; } });
  const item = element('thumbnailItem', '', [thumbnail]);
  const thumb = element('thumbnail', '', [item]);
  const selected = options.selected ? thumb : element('thumbnail');
  selected.className += ' thumbnailActive--synthetic';
  const image = element('mainPic', '', [], { tagName: 'IMG', currentSrc: 'https://img.alicdn.com/actual.jpg',
    complete: true, naturalWidth: 1280, naturalHeight: 1280, rect: { x: 300, y: 200, width: 615, height: 615 } });
  const main = element('mainPicWrap', '', [image]);
  const root = element('picGallery', '', [thumb, ...(selected === thumb ? [] : [selected]), main]);
  const nodes = [root];
  const hit = (x) => options.covered ? [element('Comments')] : x < 300 ? [thumbnail] : [image];
  return { target, source, thumbnail, item, thumb, selected, image, main, root, nodes, clicks: () => clicks,
    run(select = false, url = target.url) { return evaluate(mainImageScript(target, source, select), url, nodes, 'Product', hit); } };
}

function galleryFixture() {
  const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
  const image = (index, extra = {}) => element('thumbnailPic', '', [], { tagName: 'IMG',
    currentSrc: `https://img.alicdn.com/gallery-${index}.jpg`, complete: true, naturalWidth: 800, naturalHeight: 800,
    click() { throw new Error('Gallery reads must not click'); }, ...extra });
  const thumbnails = [image(1), image(2, { complete: false, naturalWidth: 0, naturalHeight: 0 })];
  const root = element('picGallery', '', [...thumbnails]);
  const nodes = [root];
  return { target, image, root, nodes,
    run() { return evaluate(galleryScript(target), target.url, nodes, 'Product', () => { throw new Error('No gallery hit testing'); }); } };
}

test('gallery-only DOM returns thumbnails under overlays while the main area contains excluded video', () => {
  const f = galleryFixture();
  const video = element('mainPicVideo', '', [], { tagName: 'VIDEO' });
  for (const key of ['currentSrc', 'src', 'poster', 'innerText']) Object.defineProperty(video, key, { get() { throw new Error('No video reads'); } });
  f.root.children.push(element('mainPicWrap', '', [video]));
  f.root.inert = true; f.root.setAttribute('aria-disabled', 'true');
  f.nodes.push(element('', '活动提示', [], { role: 'dialog' }));
  const result = validateGallery(f.run(), f.target);
  assert.equal(result.gallery.items.length, 2);
  assert.equal(result.availability.loaded_returned_images, 1);
  assert.equal(result.availability.not_loaded_returned_images, 1);
  assert.equal(result.coverage.current_main_image_read, false);
  assert.equal(result.coverage.video_read, false);
});

test('gallery collection excludes hidden ancestry and known video covers before reading their URLs', () => {
  const f = galleryFixture();
  const forbidden = () => {
    const node = f.image('forbidden');
    Object.defineProperty(node, 'currentSrc', { get() { throw new Error('Excluded URL was read'); } });
    return node;
  };
  f.root.children.push(element('videoPicWrap', '', [forbidden()]));
  f.root.children.push(element('', '', [forbidden()], { hidden: true }));
  f.root.children.push(element('', '', [forbidden()], { 'aria-hidden': 'true' }));
  const cover = forbidden(); cover.className += ' videoPic--synthetic'; f.root.children.push(cover);
  f.nodes.push(element('imageTextInfo', '', [forbidden()]), element('recommendation', '', [forbidden()]));
  assert.equal(validateGallery(f.run(), f.target).gallery.items.length, 2);
});

test('gallery scan limits return twenty rows without reading media beyond the limit', () => {
  const f = galleryFixture(); f.root.children.length = 0;
  for (let i = 0; i < 25; i++) {
    const node = f.image(i);
    if (i >= 20) Object.defineProperty(node, 'currentSrc', { get() { throw new Error('Unscanned image URL read'); } });
    f.root.children.push(node);
  }
  const result = validateGallery(f.run(), f.target);
  assert.equal(result.gallery.elements_seen, 25);
  assert.equal(result.gallery.elements_scanned, 20);
  assert.equal(result.gallery.items.length, 20);
  assert.equal(result.availability.unscanned_elements, 5);
  assert.equal(result.coverage.full_gallery, false);
});

test('gallery absence, ambiguity and an observed empty region remain different outcomes', () => {
  const empty = galleryFixture(); empty.root.children.length = 0;
  assert.equal(validateGallery(empty.run(), empty.target).availability.content_kind, 'no_supported_image_links_observed');
  empty.nodes.length = 0;
  assert.throws(() => validateGallery(empty.run(), empty.target), { code: 'UNSUPPORTED_CAPABILITY' });
  empty.nodes.push(element('picGallery'), element('picGallery'));
  assert.throws(() => validateGallery(empty.run(), empty.target), { code: 'PAGE_STRUCTURE_CHANGED' });
});

test('gallery DOM stops at explicit login, verification or frequency gates before reading image data', () => {
  for (const [text, code] of [['请先登录', 'LOGIN_REQUIRED'], ['安全验证', 'VERIFICATION_REQUIRED'], ['请求频繁', 'RATE_LIMITED']]) {
    const f = galleryFixture();
    Object.defineProperty(f.root.children[0], 'currentSrc', { get() { throw new Error('Read behind access gate'); } });
    f.nodes.push(element('', text, [], { role: 'dialog' }));
    assert.throws(() => validateGallery(f.run(), f.target), { code });
  }
});

test('details and gallery-only reads share the same image extraction and normalized positions', () => {
  const f = galleryFixture(); f.nodes.push(element('ItemTitle', 'Product'));
  f.root.children.push(f.image(1), f.image(4));
  const standalone = validateGallery(f.run(), f.target);
  const details = validateDetails(evaluate(detailsScript(f.target), f.target.url, f.nodes), f.target);
  assert.deepEqual(details.details.gallery, standalone.gallery);
  assert.deepEqual(standalone.gallery.items.map(item => item.position), [1, 2, 4]);
});

test('main-image DOM reads the actual main URL and selects only a plain static thumbnail', () => {
  const f = mainGalleryFixture();
  const raw = f.run(), observation = validateMainImageObservation(raw, f.target, f.source);
  assert.equal(observation.image.url, 'https://img.alicdn.com/actual.jpg');
  assert.equal(observation.image.width, 1280); assert.equal(observation.image.uncovered, true);
  assert.equal(observation.selected, false); assert.equal(f.clicks(), 0);
  assert.equal(validateReadActionAcknowledgement(f.run(true)).clicked, true); assert.equal(f.clicks(), 1);
  const selected = mainGalleryFixture({ selected: true });
  assert.equal(validateReadActionAcknowledgement(selected.run(true)).clicked, false); assert.equal(selected.clicks(), 0);
});

test('main-image DOM rejects wrong identity, verification and covering dialogs before clicks', () => {
  for (const condition of ['target', 'verification', 'dialog', 'covered']) {
    const f = mainGalleryFixture({ covered: condition === 'covered' });
    if (condition === 'verification') f.nodes.push(element('', '', [], { id: 'nc_1_wrapper' }));
    if (condition === 'dialog') f.nodes.push(element('', 'Unrecognized', [], { role: 'dialog' }));
    assert.throws(() => validateReadActionAcknowledgement(f.run(true, condition === 'target' ? 'https://item.taobao.com/item.htm?id=999' : f.target.url)));
    assert.equal(f.clicks(), 0);
  }
});

test('main-image reads retain loaded DOM data beneath masks or unrelated dialogs without clicking', () => {
  for (const dialog of [false, true]) {
    const f = mainGalleryFixture({ covered: true, selected: true });
    if (dialog) f.nodes.push(element('', '活动提示', [], { role: 'dialog' }));
    const observation = validateMainImageObservation(f.run(), f.target, f.source);
    assert.equal(observation.image.url, 'https://img.alicdn.com/actual.jpg');
    assert.equal(observation.image.width, 1280); assert.equal(observation.image.loaded, true);
    assert.equal(observation.image.uncovered, false); assert.equal(observation.selected, true);
    assert.equal(f.clicks(), 0);
    assert.throws(() => validateReadActionAcknowledgement(f.run(true)), { code: 'ACCESS_BLOCKED' });
    assert.equal(f.clicks(), 0);
  }
});

test('offscreen or disabled thumbnails do not prevent reading the current main element but cannot be selected', () => {
  for (const change of [f => { f.thumbnail.getBoundingClientRect = () => ({ x: -100, y: 100, width: 68, height: 68 }); },
    f => f.thumb.setAttribute('aria-disabled', 'true'), f => { f.root.tagName = 'A'; }, f => { f.thumb.inert = true; }]) {
    const f = mainGalleryFixture(); change(f);
    const observation = validateMainImageObservation(f.run(), f.target, f.source);
    assert.equal(observation.image.url, 'https://img.alicdn.com/actual.jpg');
    assert.equal(observation.selected, false);
    assert.throws(() => validateReadActionAcknowledgement(f.run(true)), { code: 'ACCESS_BLOCKED' });
    assert.equal(f.clicks(), 0);
  }
});

test('read-only main-image collection still honors explicit verification, login and rate gates', () => {
  for (const [condition, code] of [['verification', 'VERIFICATION_REQUIRED'], ['login', 'LOGIN_REQUIRED'], ['rate', 'RATE_LIMITED']]) {
    const f = mainGalleryFixture({ covered: true });
    f.nodes.push(condition === 'verification' ? element('', '', [], { id: 'nc_1_wrapper' }) :
      element('', condition === 'login' ? '请先登录' : '访问过于频繁', [], { role: 'dialog' }));
    assert.throws(() => validateMainImageObservation(f.run(), f.target, f.source), { code });
    assert.throws(() => validateReadActionAcknowledgement(f.run(true)), { code });
    assert.equal(f.clicks(), 0);
  }
  const login = mainGalleryFixture();
  login.nodes.push(element('', '', [], { role: 'dialog', class: 'loginDialog--pending' }));
  assert.throws(() => validateMainImageObservation(login.run(), login.target, login.source), { code: 'LOGIN_REQUIRED' });
  assert.equal(login.clicks(), 0);
});

test('main-image DOM rejects duplicate thumbnail URLs, active markers and main images', () => {
  for (const part of ['thumbnail', 'active', 'main']) {
    const f = mainGalleryFixture();
    const duplicate = part === 'thumbnail' ? element('thumbnailPic', '', [], { tagName: 'IMG', currentSrc: f.source }) :
      part === 'active' ? element('thumbnailActive') : element('mainPic', '', [], { tagName: 'IMG' });
    const parent = part === 'main' ? f.main : f.root;
    parent.children.push(duplicate); duplicate.parentElement = parent;
    assert.throws(() => validateMainImageObservation(f.run(), f.target, f.source), { code: 'PAGE_STRUCTURE_CHANGED' });
    if (part !== 'main') assert.throws(() => validateReadActionAcknowledgement(f.run(true)), { code: 'PAGE_STRUCTURE_CHANGED' });
    assert.equal(f.clicks(), 0);
  }
});

test('main-image selection refuses disabled, linked, hidden and non-static thumbnail shapes', () => {
  for (const change of [f => f.thumb.setAttribute('aria-disabled', 'true'), f => { f.root.tagName = 'A'; },
    f => f.thumb.setAttribute('aria-hidden', 'true'), f => { f.item.style = { opacity: '0' }; },
    f => { f.thumb.inert = true; }, f => { f.item.children.push(element('videoIcon')); },
    f => { f.item.tagName = 'BUTTON'; }]) {
    const f = mainGalleryFixture(); change(f);
    assert.throws(() => validateReadActionAcknowledgement(f.run(true))); assert.equal(f.clicks(), 0);
  }
});

test('video regions are skipped without accessing posters, playback or media URLs', () => {
  const f = mainGalleryFixture();
  const poster = element('videoPic', '', [], { tagName: 'IMG' });
  Object.defineProperty(poster, 'currentSrc', { get() { throw new Error('Poster URL must not be read'); } });
  const video = element('mainPicVideo', '', [poster]);
  f.main.children.splice(0, 1, video); video.parentElement = f.main;
  const result = validateMainImageObservation(f.run(), f.target, f.source);
  assert.equal(result.image, null); assert.equal(result.excluded_video_regions, 1); assert.equal(f.clicks(), 0);
});

test('main-image traversal truncation and unsupported images cannot masquerade as a unique static main', () => {
  for (const mode of ['count', 'depth', 'unknown']) {
    const f = mainGalleryFixture();
    if (mode === 'count') for (let index = 0; index < 61; index++) f.main.children.push(element('extra'));
    if (mode === 'depth') {
      let nested = element('extra');
      for (let index = 0; index < 8; index++) nested = element('extra', '', [nested]);
      f.main.children.push(nested); nested.parentElement = f.main;
    }
    if (mode === 'unknown') f.image.className = 'unknown--image';
    assert.throws(() => validateMainImageObservation(f.run(), f.target, f.source), { code: 'PAGE_STRUCTURE_CHANGED' });
    assert.equal(f.clicks(), 0);
  }
});

function fixedSummaryFixture() {
  const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
  const price = (prefix, label, amount) => element(prefix, '', [element('highlightPrice', `${label} ￥${amount}`,
    [element('title', label), element('text', amount)])]);
  let clicks = 0;
  const option = element('valueItem', '', [element('valueItemText', 'Black')],
    { 'aria-selected': 'true', click: () => { clicks++; } });
  const sku = element('skuWrapper', '', [element('skuItem', '', [element('ItemLabel', 'Color'), option])]);
  const title = element('ItemTitle', 'Complete original title', [], { rect: { x: 100, y: -367, width: 632, height: 54 } });
  const bodyPrice = price('beltPrice', 'Conditional promotion', '89');
  const body = element('scrollWrap', '', [title, bodyPrice, sku]);
  const head = element('ItemHeadFixed', '', [element('ItemTitle', 'Compact title'), price('normalPrice', 'Compact price', '99')]);
  const panel = element('GeneralSkuPanel', '', [head, body]);
  return { target, title, bodyPrice, sku, body, head, panel, option, clicks: () => clicks,
    read: (nodes = [panel]) => evaluate(productScript(target), target.url, nodes) };
}

test('known fixed summary layout reads the original offscreen fields and preserves scope and unverified prices', () => {
  for (const reverse of [false, true]) {
    const f = fixedSummaryFixture(); if (reverse) f.panel.children.reverse();
    const result = validateProduct(f.read(), f.target);
    assert.equal(result.title, 'Complete original title');
    assert.equal(result.prices[0].amount, '89');
    assert.equal(result.prices[0].label, 'Conditional promotion');
    assert.equal(result.prices[0].sku_id, null);
    assert.equal(result.prices[0].sku_price_binding_verified, false);
    assert.equal(result.prices[0].eligibility_verified, false);
    assert.deepEqual(result.product_region_scope, { schema_version: 1, source: 'scrolling_purchase_panel', excluded_region: 'ItemHeadFixed',
      title_regions_seen: 2, price_regions_seen: 2, excluded_title_regions: 1, excluded_price_regions: 1 });
    assert.deepEqual(validateSavedProduct(result, f.target), result);
    assert.equal(f.clicks(), 0);
  }
});

test('known summary layout never swallows an unrelated title or price region', () => {
  for (const prefix of ['ItemTitle', 'normalPrice', 'beltPrice']) {
    const f = fixedSummaryFixture();
    assert.throws(() => validateProduct(f.read([f.panel, element(prefix, 'Other')]), f.target), { code: 'PAGE_STRUCTURE_CHANGED' });
  }
});

test('a fixed header from another panel or an unknown header cannot disambiguate a product', () => {
  for (const mutate of [f => { f.panel.children.shift(); }, f => { f.head.className = 'UnknownHeader--test'; },
    f => { f.panel.className = 'UnknownPanel--test'; }]) {
    const f = fixedSummaryFixture(); mutate(f);
    const nodes = f.panel.contains(f.head) ? [f.panel] : [f.panel, f.head];
    assert.throws(() => validateProduct(f.read(nodes), f.target), { code: 'PAGE_STRUCTURE_CHANGED' });
  }
});

test('multiple panels, SKU roots, original titles or original prices remain ambiguous', () => {
  for (const extra of ['GeneralSkuPanel', 'skuWrapper', 'ItemTitle', 'normalPrice']) {
    const f = fixedSummaryFixture(); f.body.children.push(element(extra, 'Extra'));
    assert.throws(() => validateProduct(f.read(), f.target), { code: 'PAGE_STRUCTURE_CHANGED' });
  }
});

test('nested matching scroll regions and headers containing the body are not treated as sibling copies', () => {
  for (const mode of ['nested_scroll', 'head_contains_body', 'body_contains_head']) {
    const f = fixedSummaryFixture();
    if (mode === 'nested_scroll') f.panel.children[1] = element('scrollWrap', '', [f.body]);
    else if (mode === 'head_contains_body') { f.panel.children.pop(); f.head.children.push(f.body); }
    else { f.panel.children.shift(); f.body.children.push(f.head); }
    assert.throws(() => validateProduct(f.read(), f.target), { code: 'PAGE_STRUCTURE_CHANGED' });
  }
});

test('a malformed original title is not replaced with the compact summary title', () => {
  const f = fixedSummaryFixture(); f.title.innerText = '';
  assert.throws(() => validateProduct(f.read(), f.target), { code: 'PAGE_STRUCTURE_CHANGED', productStructureReason: 'title_empty' });
});

test('a summary without prices can be excluded, but missing original prices are not replaced with summary prices', () => {
  const f = fixedSummaryFixture(); f.head.children.pop();
  assert.equal(validateProduct(f.read(), f.target).product_region_scope.excluded_price_regions, 0);
  const missing = fixedSummaryFixture(); missing.body.children.splice(1, 1);
  assert.throws(() => validateProduct(missing.read(), missing.target), { code: 'PAGE_STRUCTURE_CHANGED' });
});

test('fixed summary support preserves selected-state and disabled-option guards', () => {
  const choice = { group: 'Color', option: 'Black' };
  const f = fixedSummaryFixture();
  const result = evaluate(selectionScript(f.target, choice), f.target.url, [f.panel]);
  assert.equal(validateSelectionAcknowledgement(result, choice).clicked, false);
  f.option.setAttribute('aria-disabled', 'true');
  const disabled = evaluate(selectionScript(f.target, choice), f.target.url, [f.panel]);
  assert.throws(() => validateSelectionAcknowledgement(disabled, choice), { code: 'SELECTION_DISABLED', actionNotDispatched: true });
  assert.equal(f.clicks(), 0);
});

test('multiple visible product titles reject reads and option actions before any click', () => {
  const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
  let clicks = 0;
  const sku = element('skuWrapper', '', [element('skuItem', '', [element('ItemLabel', 'Color'),
    element('valueItem', '', [element('valueItemText', 'Black')], { click: () => { clicks++; } })])]);
  for (const duplicateTitle of ['Product', 'Another product']) {
    const nodes = [element('ItemTitle', 'Product'), element('ItemTitle', duplicateTitle), sku];
    for (const script of [productScript(target), detailsScript(target)]) {
      const raw = evaluate(script, target.url, nodes);
      assert.throws(() => validateProduct(raw, target), { code: 'PAGE_STRUCTURE_CHANGED' });
    }
    const action = evaluate(selectionScript(target, { group: 'Color', option: 'Black' }), target.url, nodes);
    assert.throws(() => validateSelectionAcknowledgement(action, { group: 'Color', option: 'Black' }),
      { code: 'PAGE_STRUCTURE_CHANGED', actionNotDispatched: true });
  }
  assert.equal(clicks, 0);
});

test('hidden product title copies do not make a unique visible title ambiguous', () => {
  const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
  const nodes = [element('ItemTitle', 'Hidden title', [], { hidden: true }), element('ItemTitle', 'Product')];
  assert.equal(validateProduct(evaluate(productScript(target), target.url, nodes), target).title, 'Product');
});

test('multiple visible price roots reject reads instead of silently selecting a layout', () => {
  const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
  for (const prefixes of [['normalPrice', 'normalPrice'], ['beltPrice', 'beltPrice'], ['normalPrice', 'beltPrice']]) {
    const nodes = [element('ItemTitle', 'Product'), ...prefixes.map(prefix => element(prefix))];
    for (const script of [productScript(target), detailsScript(target)]) {
      assert.throws(() => validateProduct(evaluate(script, target.url, nodes), target), { code: 'PAGE_STRUCTURE_CHANGED' });
    }
  }
});

test('one visible price root preserves multiple price lines and ignores hidden layouts', () => {
  const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
  for (const prefix of ['normalPrice', 'beltPrice']) {
    const root = element(prefix, '', [
      element('highlightPrice', '券后 ￥89', [element('title', '券后'), element('text', '89')]),
      element('subPrice', '优惠前 ￥99', [element('title', '优惠前'), element('text', '99')]),
    ]);
    const nodes = [element('ItemTitle', 'Product'), element('normalPrice', '', [], { hidden: true }),
      element('beltPrice', '', [], { hidden: true }), root];
    const result = validateProduct(evaluate(productScript(target), target.url, nodes), target);
    assert.deepEqual(Array.from(result.prices, price => [price.label, price.amount]), [['券后', '89'], ['优惠前', '99']]);
    assert.ok(result.prices.every(price => price.sku_id === null && !price.sku_price_binding_verified && !price.eligibility_verified));
  }
});

test('a single element matching both price layouts remains one source and missing prices stay unknown', () => {
  const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
  const title = element('ItemTitle', 'Product');
  const price = element('', '', [element('highlightPrice', '￥89', [element('text', '89')])],
    { className: 'normalPrice--synthetic beltPrice--synthetic' });
  assert.equal(validateProduct(evaluate(productScript(target), target.url, [title, price]), target).prices[0].amount, '89');
  const missing = validateProduct(evaluate(productScript(target), target.url, [title]), target);
  assert.equal(missing.prices.length, 0);
  assert.ok(missing.missing.includes('price_region'));
});

test('product reads report visible specification truncation and refuse selection on partial lists', () => {
  const target=parseProductUrl('https://detail.tmall.com/item.htm?id=123');let clicks=0;
  const makeGroup=(index,options)=>element('skuItem','',[
    element('ItemLabel',`Group ${index}`),...Array.from({length:options},(_,i)=>element('valueItem','',[
      element('valueItemText',`Option ${i}`)],{click:()=>{clicks++;}}))]);
  for(const groupNodes of [[makeGroup(0,101)],Array.from({length:9},(_,i)=>makeGroup(i,1))]) {
    const nodes=[element('ItemTitle','Product'),element('skuWrapper','',groupNodes)];
    const raw=evaluate(productScript(target),target.url,nodes);
    const snapshot=validateProduct(raw,target);
    assert.equal(snapshot.specification_scope.groups_seen,groupNodes.length);
    assert.equal(snapshot.specification_scope.groups[0].options_seen,groupNodes.length===1?101:1);
    assert.equal(snapshot.specification_groups[0].options.length,groupNodes.length===1?100:1);
    const action=evaluate(selectionScript(target,{group:'Group 0',option:'Option 0'}),target.url,nodes);
    assert.equal(action.state,'selection_ambiguous');assert.equal(clicks,0);
  }
});

test('specification observation excludes hidden options and rejects multiple visible roots', () => {
  const target=parseProductUrl('https://detail.tmall.com/item.htm?id=123');
  const option=(label,attrs={})=>element('valueItem','',[element('valueItemText',label)],attrs);
  const root=element('skuWrapper','',[element('skuItem','',[element('ItemLabel','Color'),option('Black',{'aria-selected':'true'}),option('White',{'data-disabled':'true'}),option('Hidden',{hidden:true})])]);
  const nodes=[element('ItemTitle','Product'),root];
  const result=validateProduct(evaluate(productScript(target),target.url,nodes),target);
  assert.equal(result.specification_scope.groups[0].options_seen,2);
  assert.equal(result.specification_groups[0].options[1].disabled,true);
  assert.equal(evaluate(productScript(target),target.url,[...nodes,element('skuWrapper','',[],{hidden:true})]).state,'observed');
  assert.equal(evaluate(productScript(target),target.url,[...nodes,element('skuWrapper')]).state,'structure_changed');
});

test('details collect only quantity-area and dispatch notices, without reading address or quantity inputs', () => {
  const target = parseProductUrl('https://item.taobao.com/item.htm?id=123');
  const address = element('deliveryAddrWrap'), input = element('', '', [], { tagName: 'INPUT' });
  for (const node of [address, input]) Object.defineProperty(node, 'innerText', { get() { throw new Error('Private input read'); } });
  const nodes = [element('ItemTitle', 'Product'), element('skuWrapper', '', [element('quantityTip', '有货'), input]),
    element('DomesticDelivery', '', [element('shipping', '48小时内发货'), element('freight', '免运费'), address])];
  const result = validateDetails(evaluate(detailsScript(target), target.url, nodes), target);
  assert.equal(result.details.purchase.labels[0].text, '有货');
  assert.equal(result.details.shipping.dispatch.labels[0].text, '48小时内发货');
  assert.equal(result.details.shipping.dispatch.address_read, false);
});

test('notice collectors omit hidden labels and preserve finite scan coverage', () => {
  const target = parseProductUrl('https://item.taobao.com/item.htm?id=123');
  const labels = Array.from({ length: 7 }, () => element('quantityTip', 'x'.repeat(205)));
  const nodes = [element('ItemTitle', 'Product'), element('skuWrapper', '', [...labels, element('quantityTip', 'Hidden', [], { hidden: true })])];
  const result = validateDetails(evaluate(detailsScript(target), target.url, nodes), target);
  assert.equal(result.details.purchase.labels_seen, 7); assert.equal(result.details.purchase.labels_omitted, 2);
  assert.equal(result.details.purchase.labels[0].text.length, 200); assert.equal(result.details.purchase.labels[0].text_truncated, true);
  assert.equal(result.details.shipping.dispatch.observed, false);
});

test('dispatch labels containing address or input controls stop before reading their text', () => {
  const target = parseProductUrl('https://item.taobao.com/item.htm?id=123');
  for (const child of [element('deliveryAddrWrap'), element('', '', [], { tagName: 'INPUT' }), element('', '', [], { tagName: 'TEXTAREA' })]) {
    const label = element('shipping', '', [child]);
    let privateReads = 0;
    Object.defineProperty(label, 'innerText', { get() { privateReads++; throw new Error('Must reject before reading'); } });
    const nodes = [element('ItemTitle', 'Product'), element('DomesticDelivery', '', [label])];
    assert.equal(evaluate(detailsScript(target), target.url, nodes).state, 'structure_changed');
    assert.equal(privateReads, 0);
  }
});

function serviceTermsDom() {
  const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
  const label = element('guaranteeText', '7天无理由退换');
  const entry = element('GuaranteeInfo', '', [label, element('isExpend')]);
  const header = element('header', '7天无理由退换\n更多');
  const body = element('subItem', '剪标/使用/洗涤后不支持。');
  const row = element('GuaranteeItem', '', [header, body]);
  const panel = element('moreGuaranteeListWrap', '', [row]);
  const nodes = [element('ItemTitle', 'Product'), entry, panel];
  const read = () => evaluate(detailsScript(target), target.url, nodes);
  return { target, nodes, entry, label, header, body, row, panel, read };
}

test('detail reads associate an expanded service popover with matching product labels and retain exclusions', () => {
  const f = serviceTermsDom();
  const result = validateDetails(f.read(), f.target);
  assert.equal(result.details.services.terms.items[0].body_text, '剪标/使用/洗涤后不支持。');
  assert.deepEqual(result.details.services.terms.items[0].additional_entry_labels, ['更多']);
  assert.equal(result.details.services.conditions_verified, false);
  assert.equal(result.details.coverage.full_description, false);
});

test('service popovers cannot attach through a collapsed entry, duplicate panels, ambiguous rows or mismatching labels', () => {
  for (const mutate of [f => f.entry.children.pop(), f => f.nodes.push(f.panel),
    f => f.row.children.push(element('subItem', 'Unexpected')), f => { f.header.innerText = 'Unrelated service'; }]) {
    const f = serviceTermsDom(); mutate(f); assert.equal(f.read().state, 'structure_changed');
  }
});

test('service summaries omit clipped text and bound long text without claiming complete terms', () => {
  const f = serviceTermsDom();
  f.body.style = { overflowY: 'hidden' }; f.body.scrollHeight = 300; f.body.clientHeight = 30;
  let terms = validateDetails(f.read(), f.target).details.services.terms;
  assert.equal(terms.items[0].body_text, ''); assert.equal(terms.items[0].body_clipped, true);
  f.body.style = {}; f.body.innerText = '字'.repeat(2100);
  terms = validateDetails(f.read(), f.target).details.services.terms;
  assert.equal(terms.items[0].body_text.length, 2000); assert.equal(terms.items[0].body_truncated, true);
  assert.equal(terms.full_terms_verified, false);
});

function paginationDom() {
  const target = searchTarget('mouse');
  let clicks = 0;
  const next = element('', '下一页', [], { tagName: 'BUTTON', className: 'next-next', disabled: false, click: () => { clicks += 1; } });
  const previous = element('', '上一页', [], { tagName: 'BUTTON', className: 'next-prev', disabled: true });
  const display = element('', '1/100', [], { className: 'next-pagination-display' });
  const root = element('', '', [previous, display, next], { className: 'next-pagination' });
  const sort = element('sortBarWrapper', '', [element('', '综合', [], { role: 'tab', 'aria-selected': 'true' })]);
  const cards = Array.from({ length: 30 }, (_, index) => element('doubleCardWrapperAdapt', '', [element('title', `Mouse ${index}`)],
    { tagName: 'A', href: `https://detail.tmall.com/item.htm?id=${index + 1}&spm=PRIVATE` }));
  const input = element('', '', [], { tagName: 'INPUT', name: 'q', value: target.query });
  const nodes = [input, sort, root, ...cards];
  const read = (options, url = target.url) => evaluate(searchPagesScript(target, options), url, nodes, 'mouse_淘宝搜索');
  return { target, nodes, root, sort, cards, next, previous, display, read, clicks: () => clicks };
}

function priceDom() {
  const f = paginationDom(); let clicks = 0;
  const price = element('customTabItemWithArr', '价格', [], { role: 'tab', 'aria-selected': 'false', click: () => { clicks += 1; } });
  f.sort.children.push(price); f.sort.innerText = '综合\n价格';
  price.parentElement = f.sort;
  const read = before => evaluate(priceEntryScript(f.target, before), f.target.url, f.nodes, 'mouse_淘宝搜索');
  return { ...f, price, read, clicks: () => clicks };
}

test('local price inspection finds portaled labels after large unrelated content without pointer actions', () => {
  const f = priceDom();
  const popup = element('', '价格从低到高 价格从高到低', [element('', '价格从低到高'), element('', '价格从高到低')],
    { class: 'synthetic-floating-panel', rect: { x: 100, y: 135, width: 180, height: 90 } });
  f.nodes.push(...Array.from({ length: 3100 }, () => element('', 'unrelated')), popup);
  let points = 0;
  const raw = evaluate(priceRegionScript(f.target), f.target.url, f.nodes, 'mouse_淘宝搜索', () => { points += 1; return [popup]; });
  assert.equal(raw.state, 'observed'); assert.equal(points, 9); assert.equal(f.clicks(), 0);
  assert.ok(raw.price_region.nodes.some(node => node.text === '价格从低到高' && node.source === 'nearby_hit_test'));
  assert.ok(!JSON.stringify(raw.price_region).includes('unrelated'));
  assert.equal(raw.price_region.menu_relation_verified, false); assert.equal(raw.price_region.price_direction, null);
});

test('local price inspection bounds depth and nodes and excludes hidden or oversized hit targets', () => {
  const f = priceDom(), hidden = element('', '', [], { hidden: true });
  Object.defineProperty(hidden, 'innerText', { get() { throw new Error('Hidden text read'); } });
  f.price.children.push(hidden, ...Array.from({ length: 15 }, () => element('', 'visible',
    Array.from({ length: 12 }, () => element('', 'child')))));
  const large = element('', 'PRIVATE', [], { rect: { x: 0, y: 0, width: 1000, height: 800 } });
  const raw = evaluate(priceRegionScript(f.target), f.target.url, f.nodes, 'mouse_淘宝搜索', () => [large, hidden]);
  assert.equal(raw.price_region.truncated, true); assert.ok(raw.price_region.nodes.length <= 80);
  assert.ok(!JSON.stringify(raw.price_region).includes('PRIVATE')); assert.equal(f.clicks(), 0);
});

test('local price inspection skips hit testing for an offscreen anchor and retains uncertainty for empty regions', () => {
  const f = priceDom(); f.price.getBoundingClientRect = () => ({ x: 100, y: -400, width: 80, height: 30 });
  const raw = evaluate(priceRegionScript(f.target), f.target.url, f.nodes, 'mouse_淘宝搜索', () => { throw new Error('Offscreen hit test'); });
  assert.equal(raw.price_region.in_viewport, false); assert.equal(raw.price_region.hit_points.length, 0);
  assert.equal(raw.price_region.price_direction, null); assert.equal(raw.price_region.menu_relation_verified, false);
});

test('local price inspection refuses wrong targets, ambiguous price entries and verification gates', () => {
  const f = priceDom();
  const document = new Proxy({}, { get() { throw new Error('Unexpected DOM'); } });
  assert.equal(vm.runInNewContext(priceRegionScript(f.target), { URL, location: { href: 'https://example.com/' }, document }).state, 'target_changed');
  f.sort.children.push(f.price);
  assert.equal(evaluate(priceRegionScript(f.target), f.target.url, f.nodes, 'mouse_淘宝搜索').state, 'unsupported');
  f.sort.children.pop(); f.nodes.push(element('', '', [], { id: 'baxia-dialog-content' }));
  assert.equal(evaluate(priceRegionScript(f.target), f.target.url, f.nodes).state, 'verification_required');
  assert.equal(f.clicks(), 0);
});

test('hover DOM prepares a scoped selector without clicking and reads labels inside an expanded price tab', () => {
  const f = priceDom();
  const label = element('', '价格', [], { className: 'next-tabs-tab-inner' });
  f.price.children.push(label);
  const read = before => evaluate(priceEntryScript(f.target, before, { hover: true }), f.target.url, f.nodes, 'mouse_淘宝搜索');
  const before = validatePriceEntry(read(), f.target, { hover: true });
  assert.equal(read(before).state, 'hover_prepared'); assert.equal(f.clicks(), 0);
  const ascending = element('', '价格从低到高'), descending = element('', '价格从高到低');
  const popup = element('', '价格从低到高\n价格从高到低', [ascending, descending], { class: 'synthetic-popup' });
  f.price.children.push(popup); f.price.innerText = '价格\n价格从低到高\n价格从高到低';
  const raw = read(), after = validatePriceEntry(raw, f.target, { hover: true });
  assert.equal(after.inspection.controls[1].text, '价格');
  assert.deepEqual(Array.from(after.directions.candidates, item => item.label), ['价格从低到高', '价格从高到低']);
  assert.ok(after.directions.candidates.every(item => item.within_price_tab && item.within_sort_bar));
});

test('hover label scan caps candidates and skips hidden or unrelated text', () => {
  const f = priceDom(), hidden = element('', '', [], { hidden: true });
  Object.defineProperty(hidden, 'innerText', { get() { throw new Error('Hidden text read'); } });
  f.nodes.push(hidden, element('', 'PRIVATE UNRELATED'), ...Array.from({ length: 9 }, () => element('', '价格从低到高')));
  const raw = evaluate(priceEntryScript(f.target, undefined, { hover: true }), f.target.url, f.nodes, 'mouse_淘宝搜索');
  const result = validatePriceEntry(raw, f.target, { hover: true });
  assert.equal(result.directions.candidates.length, 8); assert.equal(result.directions.scan_truncated, true);
  assert.ok(!JSON.stringify(result.directions).includes('PRIVATE'));
  assert.ok(result.directions.candidates.every(item => !item.within_sort_bar && !item.within_price_tab));
});

test('observed split tab groups distinguish the first price entry from the first default entry', () => {
  const f = priceDom(), general = f.sort.children[0];
  const normal = element('', '', [general], { tagName: 'UL', className: 'next-tabs-nav' });
  const priceGroup = element('', '', [f.price, element('customTabItemWithArr', '区间', [], { role: 'tab' })], { tagName: 'UL', className: 'next-tabs-nav' });
  f.sort.children.splice(0, f.sort.children.length, normal, priceGroup); normal.parentElement = f.sort; priceGroup.parentElement = f.sort;
  const read = before => evaluate(priceEntryScript(f.target, before, { hover: true }), f.target.url, f.nodes, 'mouse_淘宝搜索');
  const before = validatePriceEntry(read(), f.target, { hover: true });
  const guarded = read(before);
  assert.equal(guarded.state, 'hover_prepared'); assert.equal(guarded.layout.matching_count, 1);
  assert.equal(guarded.layout.price_sibling_index, 1); assert.equal(f.clicks(), 0);
});

test('price entry clicks only its guarded scoped control and captures bounded visible menu candidates without asserting ownership', () => {
  const f = priceDom();
  f.nodes.unshift(element('', '价格', [], { role: 'tab', click() { throw new Error('Unrelated click'); } }));
  const before = validatePriceEntry(f.read(), f.target);
  assert.equal(before.entry.sort_bar_text, '综合 价格');
  assert.equal(f.read(before).state, 'action_dispatched'); assert.equal(f.clicks(), 1);
  const hidden = element('', '', [], { role: 'menu', hidden: true });
  Object.defineProperty(hidden, 'innerText', { get() { throw new Error('Hidden text read'); } });
  f.nodes.push(hidden, element('', 'Private unrelated menu', [], { role: 'menu' }), ...Array.from({ length: 8 }, () => element('', '价格从低到高\n价格从高到低', [], { role: 'menu' })));
  const after = validatePriceEntry(f.read(), f.target);
  assert.equal(after.entry.menu_candidates.length, 6);
  assert.ok(after.entry.menu_candidates.every(text => text === '价格从低到高 价格从高到低'));
});

test('price entry fails closed on duplicate, selected, disabled, changed or blocked controls before clicking', () => {
  for (const mutate of [
    f => { f.sort.children.push(f.price); }, f => { f.price.setAttribute('data-disabled', 'true'); },
    f => { f.price.setAttribute('aria-selected', 'true'); }, f => { f.cards[0].href = 'https://detail.tmall.com/item.htm?id=999'; },
    f => { f.sort.innerText = 'changed'; }, f => { f.nodes.push(element('', '', [], { id: 'baxia-dialog-content' })); },
  ]) {
    const f = priceDom(), before = validatePriceEntry(f.read(), f.target); mutate(f);
    assert.notEqual(f.read(before).state, 'action_dispatched'); assert.equal(f.clicks(), 0);
  }
});

test('two-page DOM reads 25 cards and clicks only the observed enabled pagination control', () => {
  const f = paginationDom();
  f.nodes.unshift(element('', '下一页', [], { tagName: 'BUTTON', className: 'next-next', click() { throw new Error('Unrelated click'); } }));
  const raw = f.read();
  assert.equal(raw.items.length, 25);
  assert.equal(raw.cards_seen, 30);
  assert.ok(!JSON.stringify(raw).includes('PRIVATE'));
  const before = validateSearchPage(raw, f.target, false).page;
  assert.equal(f.read({ before }).state, 'action_dispatched');
  assert.equal(f.clicks(), 1);
  f.display.innerText = '2/100'; f.previous.disabled = false;
  const second = f.read({ allowSecond: true }, f.target.url.replace('page=1', 'page=2'));
  assert.equal(validateSearchPage(second, f.target, true).page.search.page, 2);
});

test('next-page guard rejects changed lists, duplicate controls, changed sort, disabled buttons and gates', () => {
  for (const mutate of [
    f => { f.cards[0].href = 'https://detail.tmall.com/item.htm?id=999'; },
    f => { f.root.children.push(f.next); },
    f => { f.next.disabled = true; },
    f => { f.sort.children[0].innerText = '销量'; },
    f => { f.nodes.push(element('', '', [], { id: 'baxia-dialog-content' })); },
    f => { f.nodes.push(element('', '访问过于频繁', [], { role: 'dialog' })); },
    f => { f.display.innerText = '2/100'; },
  ]) {
    const f = paginationDom();
    const before = validateSearchPage(f.read(), f.target, false).page;
    mutate(f);
    assert.notEqual(f.read({ before }).state, 'action_dispatched');
    assert.equal(f.clicks(), 0);
  }
});

test('two-page identity guard runs before DOM, and URL/display transition is not a result', () => {
  const f = paginationDom();
  for (const url of ['https://www.taobao.com/', f.target.url.replace('page=1', 'page=3'), `${f.target.url}&sort=unknown`, f.target.url.replace('q=mouse', 'q=other')]) {
    const document = new Proxy({}, { get() { throw new Error('Unexpected DOM access'); } });
    assert.equal(vm.runInNewContext(searchPagesScript(f.target, { allowSecond: true }), { URL, location: { href: url }, document }).state, 'target_changed');
  }
  assert.equal(f.read({ allowSecond: true }, f.target.url.replace('page=1', 'page=2')).state, 'page_transition');
});

test('pagination layout diagnostics distinguish missing visible display, controls and selected sort without leaking page text', () => {
  for (const [mutate, code] of [
    [f => { f.nodes.splice(f.nodes.indexOf(f.root), 1); }, 'SEARCH_PAGINATION_MISSING'],
    [f => { f.display.hidden = true; }, 'SEARCH_PAGE_DISPLAY_MISSING'],
    [f => { f.sort.children[0].innerText = 'PRIVATE_UNSUPPORTED_SORT'; }, 'SEARCH_SORT_STATE_MISMATCH'],
    [f => { f.root.children.push(f.next); }, 'SEARCH_PAGE_CONTROLS_MISMATCH'],
  ]) {
    const f = paginationDom();
    const before = validateSearchPage(f.read(), f.target, false).page;
    mutate(f);
    const raw = f.read();
    assert.ok(!JSON.stringify(raw).includes('PRIVATE'));
    assert.throws(() => validateSearchPage(raw, f.target, false), { code });
    assert.throws(() => validateReadActionAcknowledgement(f.read({ before })), error => error.code === code && error.actionNotDispatched);
    assert.equal(f.clicks(), 0);
  }
});

test('budgeted pagination inspection keeps hidden text private, bounds control metadata and never clicks', () => {
  const f = paginationDom();
  f.display.hidden = true;
  Object.defineProperty(f.display, 'innerText', { get() { throw new Error('Hidden text must not be read'); } });
  f.root.children.push(...Array.from({ length: 60 }, (_, i) => element('', String(i + 1), [], { tagName: 'BUTTON', className: 'next-pagination-item' })));
  f.sort.children.push(element('', 'PRIVATE_UNSUPPORTED_LABEL', [], { role: 'tab' }));
  const raw = evaluate(searchPagesDiagnosticScript(f.target), f.target.url, f.nodes, 'mouse_淘宝搜索');
  assert.equal(raw.state, 'layout_observed');
  assert.equal(raw.pagination[0].controls.length, 40);
  assert.equal(raw.pagination[0].controls[1].visible, false);
  assert.equal(raw.pagination[0].controls[1].label, null);
  assert.equal(raw.raw_search.items.length, 25);
  assert.ok(!JSON.stringify(raw).includes('PRIVATE'));
  assert.equal(f.clicks(), 0);
  f.nodes.push(element('', '', [], { id: 'baxia-dialog-content' }));
  assert.equal(evaluate(searchPagesDiagnosticScript(f.target), f.target.url, f.nodes, 'mouse_淘宝搜索').state, 'verification_required');
  const document = new Proxy({}, { get() { throw new Error('Wrong target must not read DOM'); } });
  assert.equal(vm.runInNewContext(searchPagesDiagnosticScript(f.target), { URL, location: { href: 'https://example.com/' }, document }).state, 'target_changed');
});

function sortingDom() {
  const f = paginationDom(); let clicks = 0;
  const sales = element('', '销量', [], { tagName: 'LI', role: 'tab', 'aria-selected': 'false', click() { clicks += 1; } });
  f.sort.children.push(sales);
  const read = (options = {}, url = f.target.url) => evaluate(searchSortScript(f.target, options), url, f.nodes, 'mouse_淘宝搜索');
  return { ...f, sales, readSort: read, sortClicks: () => clicks };
}

test('sales sort reads 25 cards, clicks only the scoped tab, and preserves observed URL token without claiming its meaning', () => {
  const f = sortingDom();
  f.nodes.push(element('', '销量', [], { role: 'tab', click() { throw new Error('Unrelated tab'); } }));
  const raw = f.readSort();
  assert.equal(raw.items.length, 25);
  const before = validateSearchSort(raw, f.target, false).snapshot;
  assert.equal(f.readSort({ before }).state, 'action_dispatched'); assert.equal(f.sortClicks(), 1); assert.equal(f.clicks(), 0);
  f.sort.children[0].setAttribute('aria-selected', 'false'); f.sales.setAttribute('aria-selected', 'true');
  const observed = f.readSort({ dispatched: true }, `${f.target.url}&sort=observed-token&spm=PRIVATE`);
  const after = validateSearchSort(observed, f.target, true).snapshot;
  assert.equal(after.search.url, `${f.target.url}&sort=observed-token`);
  assert.equal(after.pagination.selected_sort_label, '销量');
  assert.equal(after.search.coverage.sort_verified, false);
  assert.ok(!JSON.stringify(after).includes('PRIVATE'));
});

test('sales sort rejects changed baseline, duplicate or disabled controls, selected-state conflicts and verification gates before clicking', () => {
  for (const mutate of [
    f => { f.cards[0].href = 'https://detail.tmall.com/item.htm?id=999'; },
    f => { f.sort.children.push(f.sales); },
    f => { f.sales.disabled = true; },
    f => { f.sales.setAttribute('data-disabled', 'true'); },
    f => { f.sales.setAttribute('aria-disabled', 'true'); },
    f => { f.sales.setAttribute('aria-selected', 'true'); },
    f => { f.nodes.push(element('', '', [], { id: 'baxia-dialog-content' })); },
    f => { f.nodes.push(element('', '访问过于频繁', [], { role: 'dialog' })); },
  ]) {
    const f = sortingDom(), before = validateSearchSort(f.readSort(), f.target, false).snapshot;
    mutate(f);
    assert.throws(() => validateReadActionAcknowledgement(f.readSort({ before })), error => error.actionNotDispatched === true);
    assert.equal(f.sortClicks(), 0);
  }
});

test('sort identity rejects unreserved sort tokens, filter parameters and unrelated queries before DOM access', () => {
  const f = sortingDom();
  for (const [url, dispatched] of [[`${f.target.url}&sort=x`, false], [`${f.target.url}&minPrice=1`, true],
    [f.target.url.replace('q=mouse', 'q=other'), true], [f.target.url.replace('page=1', 'page=3'), true]]) {
    const document = new Proxy({}, { get() { throw new Error('Unexpected DOM access'); } });
    assert.equal(vm.runInNewContext(searchSortScript(f.target, { dispatched }), { URL, location: { href: url }, document }).state, 'target_changed');
  }
});

test('saved-tab address probes read no DOM or private state and emit only matching canonical URLs', () => {
  const root = searchTarget('mouse');
  for (const [url, state] of [[root.url + '&spm=PRIVATE', 'observed'], [root.url.replace('mouse', 'PRIVATE'), 'target_changed'],
    ['https://mail.example.test/?token=PRIVATE', 'target_changed'], ['https://login.taobao.com/?token=PRIVATE', 'login_required']]) {
    const trap = new Proxy({}, { get() { throw new Error('Address probe accessed private state or DOM'); } });
    const result = vm.runInNewContext(searchSortTargetScript(root, false), { URL, location: { href: url }, document: trap, localStorage: trap });
    assert.equal(result.state, state); assert.ok(!JSON.stringify(result).includes('PRIVATE'));
    if (state === 'observed') assert.equal(result.url, root.url);
  }
});

test('sort diagnostics preserve the original failure and inspect bounded layout only after a structural read', () => {
  const f = sortingDom();
  f.display.hidden = true;
  const read = () => evaluate(searchSortDiagnosticScript(f.target, true), f.target.url, f.nodes, 'mouse_淘宝搜索');
  const result = read();
  assert.equal(result.observation.state, 'search_page_display_missing');
  assert.equal(result.layout.pagination[0].controls[1].visible, false);
  assert.equal(result.layout.pagination[0].controls[1].label, null);
  assert.equal(result.layout.raw_search.items.length, 25);
  assert.equal(f.sortClicks(), 0);
  f.nodes.push(element('', '', [], { id: 'baxia-dialog-content' }));
  const gate = read(); assert.equal(gate.observation.state, 'verification_required'); assert.equal(gate.layout, null);
});

test('visible control inspection handles SVG icons, bounds descendants and never reads hidden text or clicks', () => {
  const f = sortingDom();
  const hidden = element('', 'PRIVATE', [], { hidden: true });
  Object.defineProperty(hidden, 'innerText', { get() { throw new Error('Hidden control text'); } });
  const svg = element('', '', [], { tagName: 'svg', className: { baseVal: 'arrow-svg' }, class: 'arrow-svg' });
  f.sort.children.push(element('', '价格', [svg, hidden, ...Array.from({ length: 20 }, () => element('', 'arrow'))],
    { tagName: 'LI', role: 'tab', 'aria-selected': 'false' }));
  const raw = evaluate(searchControlsScript(f.target), f.target.url, f.nodes, 'mouse_淘宝搜索');
  const result = validateSearchControls(raw, f.target);
  assert.equal(result.controls[2].children.length, 12);
  assert.equal(result.controls[2].children[0].tag, 'SVG'); assert.equal(result.controls[2].children[0].class_name, 'arrow-svg');
  assert.ok(!JSON.stringify(result).includes('PRIVATE')); assert.equal(f.sortClicks(), 0); assert.equal(f.clicks(), 0);
  f.nodes.push(element('', '', [], { id: 'baxia-dialog-content' }));
  assert.equal(evaluate(searchControlsScript(f.target), f.target.url, f.nodes, 'mouse_淘宝搜索').state, 'verification_required');
});

function compactPagination() {
  const previous = element('', '', [], { tagName: 'BUTTON', className: 'next-prev', disabled: true });
  const next = element('', '', [], { tagName: 'BUTTON', className: 'next-next', disabled: false, click() { throw new Error('Compact control must not be clicked'); } });
  const display = element('', '1\n/100', [], { className: 'next-pagination-display' });
  return { previous, next, display, root: element('', '', [previous, display, next], { className: 'next-pagination' }) };
}

test('real compact and labelled pagination layout selects only the labelled controls when both states agree', () => {
  const f = paginationDom(), compact = compactPagination();
  f.nodes.unshift(compact.root);
  f.root.children.push(element('', '1', [], { tagName: 'BUTTON', className: 'next-pagination-item next-current' }));
  const raw = f.read();
  assert.equal(raw.state, 'observed');
  const before = validateSearchPage(raw, f.target, false).page;
  assert.equal(before.pagination.total_pages_displayed, 100);
  assert.equal(f.read({ before }).state, 'action_dispatched');
  assert.equal(f.clicks(), 1);
});

test('two pagination regions with conflicting page, total, disabled state or duplicate labelled controls never click', () => {
  for (const mutate of [
    ({ compact }) => { compact.display.innerText = '2/100'; },
    ({ compact }) => { compact.display.innerText = '1/99'; },
    ({ compact }) => { compact.next.disabled = true; },
    ({ compact }) => { compact.previous.innerText = '上一页'; compact.next.innerText = '下一页'; },
    ({ f }) => { f.root.children.push(element('', '2', [], { tagName: 'BUTTON', className: 'next-current' })); },
  ]) {
    const f = paginationDom(), compact = compactPagination();
    f.nodes.unshift(compact.root);
    const before = validateSearchPage(f.read(), f.target, false).page;
    mutate({ f, compact });
    assert.equal(f.read({ before }).state, 'search_page_controls_mismatch');
    assert.equal(f.clicks(), 0);
  }
});

function shortPaginationDom() {
  const f = sortingDom(), compact = compactPagination();
  compact.display.innerText = '1/11'; f.nodes.unshift(compact.root);
  f.root.children.splice(f.root.children.indexOf(f.display), 1);
  const numbers = Array.from({ length: 11 }, (_, index) => element('', String(index + 1), [], {
    tagName: 'BUTTON', className: `next-pagination-item${index === 0 ? ' next-current' : ''}`,
  }));
  f.root.children.push(...numbers);
  return { f, compact, numbers };
}

test('observed short pagination corroborates compact 1/11 with a complete visible 1–11 strip and selected current page', () => {
  const { f } = shortPaginationDom();
  const before = validateSearchSort(f.readSort(), f.target, false).snapshot;
  assert.equal(before.pagination.total_pages_displayed, 11);
  assert.equal(f.readSort({ before }).state, 'action_dispatched'); assert.equal(f.sortClicks(), 1);
  f.sort.children[0].setAttribute('aria-selected', 'false'); f.sales.setAttribute('aria-selected', 'true');
  assert.equal(validateSearchSort(f.readSort({ dispatched: true }), f.target, true).snapshot.pagination.selected_sort_label, '销量');
});

test('short number strips cannot invent totals or ignore missing, duplicate, hidden and inconsistent numeric pages', () => {
  for (const mutate of [
    ({ compact }) => { compact.display.hidden = true; },
    ({ compact }) => { compact.display.innerText = '1/12'; },
    ({ compact }) => { compact.display.innerText = '1/100'; },
    ({ numbers }) => { numbers[5].innerText = '7'; },
    ({ numbers }) => { numbers[5].hidden = true; },
    ({ numbers }) => { numbers[0].innerText = '2'; },
    ({ f }) => { f.nodes.splice(0, 1); },
  ]) {
    const data = shortPaginationDom(); mutate(data);
    assert.notEqual(data.f.readSort().state, 'observed'); assert.equal(data.f.sortClicks(), 0);
  }
});

test('product DOM records only the exact SKU URL parameter and excludes property values and tracking', () => {
  const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
  const option = element('valueItem', '', [element('valueItemText', '黑色')], { 'data-vid': '789', 'aria-selected': 'true' });
  const nodes = [element('ItemTitle', 'Synthetic product'), element('skuWrapper', '', [
    element('skuItem', '', [element('ItemLabel', '颜色'), option]),
  ])];
  for (const [query, status, candidate, properties] of [
    ['&skuId=456&tracking=PRIVATE', 'candidate_only', '456', false],
    ['&sku_properties=1627207:789', 'parameter_absent', null, true],
    ['&sku_id=456&SKUId=456', 'parameter_absent', null, false],
    ['&skuId=123', 'invalid_parameter', null, false],
    ['&skuId=456&skuId=456', 'ambiguous_parameter', null, false],
    ['&skuId=456&skuId=789', 'ambiguous_parameter', null, false],
    ['&skuId=1627207:789', 'invalid_parameter', null, false],
    ['&skuId=', 'invalid_parameter', null, false],
    ['&skuId=PRIVATE', 'invalid_parameter', null, false],
    [`&skuId=${'4'.repeat(65)}`, 'invalid_parameter', null, false],
    ['&skuId=456&sku_properties=1627207:789', 'candidate_only', '456', true],
  ]) {
    const raw = evaluate(productScript(target), target.url + query, nodes);
    assert.equal(raw.sku_url.status, status);
    assert.equal(raw.sku_url.candidate_sku_id, candidate);
    assert.equal(raw.sku_url.sku_properties_present, properties);
    assert.ok(!JSON.stringify(raw).includes('PRIVATE'));
    assert.ok(!JSON.stringify(raw).includes('1627207'));
    assert.equal(validateProduct(raw, target).specification_groups[0].options[0].sku_id, null);
  }
});

test('SKU URL evidence is collected only after identity and page gate checks', () => {
  const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
  const title = element('ItemTitle', 'Synthetic product');
  for (const [nodes, state] of [
    [[title, element('', '', [], { id: 'baxia-dialog-content' })], 'verification_required'],
    [[title, element('', '扫码登录', [], { role: 'dialog' })], 'login_required'],
    [[title, element('', '访问过于频繁', [], { role: 'dialog' })], 'rate_limited'],
  ]) {
    const raw = evaluate(productScript(target), `${target.url}&skuId=456`, nodes);
    assert.equal(raw.state, state);
    assert.equal(Object.hasOwn(raw, 'sku_url'), false);
  }
});

test('data-disabled is reported consistently for selected and unselected specification options', () => {
  const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
  for (const selected of [null, 'true']) {
    let clicks = 0;
    const option = element('valueItem', '', [element('valueItemText', '黑色')], {
      'data-disabled': 'true', 'aria-selected': selected, click: () => { clicks += 1; },
    });
    const nodes = [element('ItemTitle', 'Product'), element('skuWrapper', '', [
      element('skuItem', '', [element('ItemLabel', '颜色'), option]),
    ])];
    const snapshot = validateProduct(evaluate(productScript(target), target.url, nodes), target);
    assert.equal(snapshot.specification_groups[0].options[0].disabled, true);
    assert.equal(evaluate(selectionScript(target, { group: '颜色', option: '黑色' }), target.url, nodes).state, 'selection_disabled');
    assert.equal(clicks, 0);
  }
});

test('a contradictory selected state appearing immediately before dispatch prevents the click', () => {
  const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
  let clicks = 0;
  const options = ['黑色', '白色', '灰色'].map(label => element('valueItem', '', [element('valueItemText', label)], {
    'aria-selected': label === '灰色' ? null : 'true', click: () => { clicks += 1; },
  }));
  const nodes = [element('ItemTitle', 'Product'), element('skuWrapper', '', [
    element('skuItem', '', [element('ItemLabel', '颜色'), ...options]),
  ])];
  const choice = { group: '颜色', option: '灰色' };
  const acknowledgement = evaluate(selectionScript(target, choice), target.url, nodes);
  assert.throws(() => validateSelectionAcknowledgement(acknowledgement, choice),
    error => error.code === 'SELECTION_STATE_CONFLICT' && error.actionNotDispatched);
  assert.equal(clicks, 0);
});

test('search DOM collector skips redirect cards in-page and only reads scoped product-card fields', () => {
  const target = searchTarget('mouse');
  const price = element('priceWrapper', '补贴后 ¥89起', [element('priceInt', '89'), element('priceDesc', '补贴后')]);
  const good = element('doubleCardWrapperAdapt', '', [element('title', 'Synthetic mouse'), price, element('shopNameText', 'Synthetic shop')],
    { tagName: 'A', href: 'https://detail.tmall.com/item.htm?id=123&tracking=DO_NOT_KEEP' });
  const advertisement = element('doubleCardWrapperAdapt', '', [], { tagName: 'A', href: 'https://click.simba.taobao.com/cc_im?secret=DO_NOT_KEEP' });
  const input = element('', '', [], { tagName: 'INPUT', name: 'q', value: 'mouse' });
  const raw = evaluate(searchScript(target), target.url, [input, advertisement, good], 'mouse_淘宝搜索');
  assert.ok(!JSON.stringify(raw).includes('DO_NOT_KEEP'));
  const result = validateSearch(raw, target).result;
  assert.equal(result.unsupported_cards_omitted, 1);
  assert.equal(result.items[0].position, 2);
  assert.equal(result.items[0].shop, 'Synthetic shop');
  assert.equal(result.items[0].price.kind, 'starting_from');
});

test('detail extraction rejects ambiguous visible labels or values instead of selecting the first match', () => {
  const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
  for (const prefix of ['generalParamsInfoItemTitle', 'generalParamsInfoItemSubTitle', 'emphasisParamsInfoItemTitle', 'emphasisParamsInfoItemSubTitle']) {
    const emphasis = prefix.startsWith('emphasis'), rowPrefix = emphasis ? 'emphasisParamsInfoItem' : 'generalParamsInfoItem';
    const row = element(rowPrefix, '', [element(`${rowPrefix}Title`, 'First'), element(`${rowPrefix}SubTitle`, 'Second'), element(prefix, 'Ambiguous')]);
    const nodes = [element('ItemTitle', 'Product'), element('paramsWrap', '', [row])];
    assert.equal(evaluate(detailsScript(target), target.url, nodes).state, 'structure_changed');
  }
});

function readDescription(children, attributes = {}) {
  const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
  const container = element('', '', children, { className: 'descV8-container', ...attributes });
  const region = element('imageTextInfo', '', [container]);
  return evaluate(detailsScript(target), target.url, [element('ItemTitle', 'Product'), region]);
}

test('description traversal includes direct and nested text without copying nested charity, video or script modules', () => {
  const body = element('', '', [element('', 'Product terms'), element('', 'EXCLUDE_CHARITY', [], { className: 'descV8-charity' }),
    element('', 'EXCLUDE_VIDEO', [], { className: 'descV8-video' }), element('', 'EXCLUDE_SCRIPT', [], { tagName: 'SCRIPT' })]);
  const raw = readDescription([body], { childNodes: [{ nodeType: 3, nodeValue: 'Intro ' }, body, { nodeType: 3, nodeValue: ' End' }] });
  assert.equal(raw.state, 'observed');
  assert.match(raw.details.description.text, /Intro.*Product terms.*End/);
  assert.ok(!raw.details.description.text.includes('EXCLUDE'));
  assert.equal(raw.details.description.observation.text_container_observed, true);
});

test('description traversal omits clipped and hidden text and records visible controls without clicking', () => {
  const hidden = element('', '', [], { hidden: true });
  Object.defineProperty(hidden, 'innerText', { get() { throw new Error('Hidden text read'); } });
  const clipped = element('', 'EXCLUDE_CLIPPED', [], { style: { overflowY: 'hidden' }, scrollHeight: 200, clientHeight: 40 });
  const button = element('', '展开全部详情', [], { tagName: 'BUTTON', 'aria-expanded': 'false', click() { throw new Error('Unexpected click'); } });
  const raw = readDescription([hidden, clipped, element('', 'Visible terms'), button]);
  const observation = raw.details.description.observation;
  assert.equal(raw.details.description.text, 'Visible terms');
  assert.equal(observation.clipped_subtrees_omitted, 1);
  assert.equal(observation.control_candidates.length, 1);
  assert.equal(observation.control_candidates[0].aria_expanded, 'false');
  assert.equal(observation.expansion_behavior_verified, false);
});

test('description controls outside its region cannot become expansion candidates', () => {
  const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
  const unrelated = element('', '查看全部评价', [], { role: 'button' });
  const region = element('imageTextInfo', '', [element('', '', [element('', 'Visible terms')], { className: 'descV8-container' })]);
  const raw = evaluate(detailsScript(target), target.url, [element('ItemTitle', 'Product'), unrelated, region]);
  assert.equal(raw.details.description.observation.control_candidates.length, 0);
  assert.equal(raw.details.description.text, 'Visible terms');
});

test('description traversal bounds nodes, depth and output while preserving explicit truncation', () => {
  const many = readDescription(Array.from({ length: 1000 }, () => element('', 'Word')));
  assert.equal(many.details.description.observation.nodes_scanned, 800);
  assert.equal(many.details.description.observation.traversal_truncated, true);
  let deep = element('', 'Too deep');
  for (let index = 0; index < 14; index += 1) deep = element('', '', [deep]);
  const nested = readDescription([deep]);
  assert.equal(nested.details.description.observation.traversal_truncated, true);
  assert.ok(!nested.details.description.text.includes('Too deep'));
  const long = readDescription([element('', '字'.repeat(6500))]);
  assert.ok(long.details.description.text.length <= 6000);
  assert.equal(long.details.description.observation.text_truncated, true);
});

test('description traversal bounds controls and never treats their labels as product prose', () => {
  const raw = readDescription(Array.from({ length: 10 }, () => element('', '展开详情', [], { role: 'button' })));
  assert.equal(raw.details.description.observation.control_candidates.length, 8);
  assert.equal(raw.details.description.observation.controls_truncated, true);
  assert.equal(raw.details.description.text, '');
});

test('description observations preserve absence and fail on ambiguous text containers', () => {
  const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
  const absent = evaluate(detailsScript(target), target.url, [element('ItemTitle', 'Product')]);
  assert.equal(absent.details.description.observation.text_container_observed, false);
  assert.equal(absent.details.description.observation.nodes_scanned, 0);
  const containers = Array.from({ length: 2 }, () => element('', 'Text', [], { className: 'descV8-container' }));
  assert.equal(evaluate(detailsScript(target), target.url, [element('ItemTitle', 'Product'), element('imageTextInfo', '', containers)]).state, 'structure_changed');
});

test('detail extraction ignores hidden duplicate fields but rejects multiple visible shop names', () => {
  const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
  const hidden = element('shopName', '', [], {hidden:true});
  Object.defineProperty(hidden, 'innerText', {get(){throw new Error('Hidden shop read');}});
  const shop = element('shopHeader', '', [element('shopName', 'Shop'), hidden]);
  const nodes = [element('ItemTitle', 'Product'), shop];
  assert.equal(evaluate(detailsScript(target),target.url,nodes).state,'observed');
  shop.children.push(element('shopName', 'Other shop'));
  assert.equal(evaluate(detailsScript(target),target.url,nodes).state,'structure_changed');
});

test('detail DOM pairs both parameter layouts and excludes charity images, video covers and delivery addresses', () => {
  const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
  const img = (className, url) => element('', '', [], { className, tagName: 'IMG', currentSrc: url, complete: true, naturalWidth: 800, naturalHeight: 600 });
  const shop = element('shopHeader', '', [element('', '', [element('shopName', 'Synthetic shop')],
    { tagName: 'A', href: 'https://shop123.taobao.com/category.htm?tracking=DO_NOT_KEEP' })]);
  const params = element('paramsWrap', '', [
    element('emphasisParamsInfoItem', '', [element('emphasisParamsInfoItemTitle', '无线'), element('emphasisParamsInfoItemSubTitle', '连接方式')]),
    element('generalParamsInfoItem', '', [element('generalParamsInfoItemTitle', '品牌'), element('generalParamsInfoItemSubTitle', 'Synthetic brand')]),
  ]);
  const gallery = element('picGallery', '', [img('thumbnailPic--synthetic', 'https://gw.alicdn.com/product.jpg'),
    img('videoPic--synthetic', 'https://gw.alicdn.com/DO_NOT_KEEP_VIDEO.jpg')]);
  const description = element('imageTextInfo', '', [element('', '', [
    element('', 'DO_NOT_KEEP_CHARITY', [img('charity-icon', 'https://img.alicdn.com/DO_NOT_KEEP_ICON.jpg')], { className: 'descV8-charity' }),
    element('', '', [img('descV8-singleImage-image', 'https://img.alicdn.com/description.jpg')], { className: 'descV8-singleImage' }),
    element('', 'Description text', [], { className: 'descV8-text' }),
    element('', 'DO_NOT_KEEP_VIDEO_TEXT', [], { className: 'descV8-video' }),
  ], { className: 'descV8-container' })]);
  const privateAddress = element('deliveryAddrWrap');
  Object.defineProperty(privateAddress, 'innerText', { get() { throw new Error('Private address must not be read'); } });
  const delivery = element('DomesticDelivery', '', [element('freight', '快递: 免运费'), privateAddress]);
  const nodes = [element('ItemTitle', 'Synthetic product'), shop, params, gallery, description,
    element('GuaranteeInfo', '', [element('guaranteeText', '7天无理由退换')]), delivery];
  const raw = evaluate(detailsScript(target), target.url, nodes);
  const { details } = validateDetails(raw, target);
  assert.deepEqual(Array.from(details.attributes.items, ({ name, value }) => [name, value]), [['连接方式', '无线'], ['品牌', 'Synthetic brand']]);
  assert.equal(details.gallery.items.length, 1);
  assert.equal(details.description.items.length, 1);
  assert.equal(details.description.text, 'Description text');
  assert.equal(details.description.videos_seen, 1);
  assert.deepEqual(details.shipping.freight_labels, ['快递: 免运费']);
  assert.ok(!JSON.stringify(details).includes('DO_NOT_KEEP'));
  assert.equal(evaluate(detailsScript(target), target.url, [...nodes, params]).state, 'structure_changed');
});

test('detail DOM reads description images from single, rich-text and jumper modules in page order', () => {
  const target = parseProductUrl('https://item.taobao.com/item.htm?id=123');
  const img = (className, name) => element('', '', [], { className, tagName: 'IMG', currentSrc: `https://img.alicdn.com/${name}.jpg`,
    complete: true, naturalWidth: 790, naturalHeight: 1200 });
  const module = (className, children) => element('', '', children, { className });
  const description = element('imageTextInfo', '', [element('', '', [
    module('descV8-singleImage', [img('descV8-singleImage-image', 'one')]),
    module('descV8-richtext', [element('', '', [img('richImg', 'two')], { tagName: 'P' }), img('richImg', 'three')]),
    module('descV8-picJumper', [img('descV8-picJumper-image', 'four')]),
    module('descV8-charity', [img('descV8-charity-icon', 'DO_NOT_KEEP_ICON')]),
    module('descV8-singleImage', [img('descV8-singleImage-image', 'five')]),
  ], { className: 'descV8-container' })]);
  const saved = validateDetails(evaluate(detailsScript(target), target.url, [element('ItemTitle', 'Synthetic product'), description]), target);
  const images = saved.details.description;
  assert.deepEqual(images.items.map(item => [item.position, item.url.split('/').pop(), item.module]), [[1, 'one.jpg', 'single_image'],
    [2, 'two.jpg', 'rich_text'], [3, 'three.jpg', 'rich_text'], [4, 'four.jpg', 'pic_jumper'], [5, 'five.jpg', 'single_image']]);
  assert.deepEqual(images.image_modules, ['single_image', 'rich_text', 'pic_jumper']);
  assert.equal(images.image_readiness.elements_seen, 5);
  assert.ok(!JSON.stringify(saved).includes('DO_NOT_KEEP'));
  validateSavedDetails(saved, target);
  // A saved module name is self-consistent evidence only; the page is not re-read, so contradictions are what can be caught.
  for (const change of [value => { value.details.description.items[1].module = 'video'; },
    value => { delete value.details.description.items[1].module; },
    value => { delete value.details.description.image_modules; },
    value => { value.details.description.image_modules = ['single_image']; },
    value => { value.details.gallery.image_modules = ['single_image', 'rich_text', 'pic_jumper']; }]) {
    const copy = structuredClone(saved); change(copy);
    assert.throws(() => validateSavedDetails(copy, target), { code: 'INVALID_CHECKPOINT' });
  }
});

test('review expansion only clicks the unique enabled control in the product review region', () => {
  const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
  let intended = 0, other = 0;
  const button = element('ShowButton', '查看全部评价', [], { click: () => { intended += 1; } });
  const unrelated = element('ShowButton', '查看全部评价', [], { click: () => { other += 1; } });
  const root = element('Comments', '', [button]);
  const title = element('ItemTitle', 'Synthetic product');
  assert.equal(evaluate(reviewsScript(target, true), target.url, [title, unrelated, root]).state, 'action_dispatched');
  assert.equal(intended, 1); assert.equal(other, 0);
  root.children.push(button);
  assert.equal(evaluate(reviewsScript(target, true), target.url, [title, root]).state, 'structure_changed');
  assert.equal(intended, 1);
  root.children.pop(); button.disabled = true;
  assert.equal(evaluate(reviewsScript(target, true), target.url, [title, root]).state, 'unsupported');
});

test('expanded review drawer is read without mixing preview comments or reviewer names', () => {
  const target = parseProductUrl('https://item.taobao.com/item.htm?id=123');
  const comment = element('Comment', '', [element('content', 'Expanded body'), element('meta', '2026年9月22日已购：黑色'), element('userName', 'DO_NOT_KEEP')]);
  const drawer = element('Drawer', '', [element('Comments', '', [element('tabDetailItemTitle', '用户评价·25'), comment])], { role: 'dialog' });
  const preview = element('Comments', '', [element('Comment', '', [element('content', 'Preview only')])]);
  const nodes = [element('ItemTitle', 'Synthetic product'), preview, drawer];
  const raw = evaluate(reviewsScript(target), target.url, nodes);
  assert.ok(!JSON.stringify(raw).includes('DO_NOT_KEEP'));
  const result = validateReviews(raw, target).result;
  assert.equal(result.returned_count, 1);
  assert.equal(result.reviews[0].body, 'Expanded body');
  assert.equal(evaluate(reviewsScript(target, true), target.url, nodes).clicked, false);
  const captcha = element('', '', [], { id: 'baxia-dialog-content' });
  assert.equal(evaluate(reviewsScript(target), target.url, [...nodes, captcha]).state, 'verification_required');
});

test('related content stays attached to its main review or follow-up without collecting other comment threads', () => {
  const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
  const reply = text => element('reply', '', [element('HideableText', '', [element('text', `商家回复：${text}`)])]);
  const followup = element('append', '', [element('content', '7天后追评：Follow-up body', [element('appendInternal', '7天后追评：')]), reply('Follow-up reply')]);
  const first = element('Comment', '', [element('content', 'Main body'), element('meta', '2026年9月22日已购：黑色'), reply('Main reply'), followup]);
  const second = element('Comment', '', [element('content', 'Other main body'), element('meta', ''), reply('Other reply')]);
  const root = element('Comments', '', [element('tabDetailItemTitle', '用户评价·25'), first, second, element('foldInfoWrap', '已折叠20条评价')]);
  const raw = evaluate(reviewsScript(target), target.url, [element('ItemTitle', 'Product'), element('Drawer', '', [root])]);
  const result = validateReviews(raw, target).result;
  assert.equal(result.schema_version, 3);
  assert.equal(result.reviews[0].seller_replies.length, 1);
  assert.equal(result.reviews[0].seller_replies[0].body, 'Main reply');
  assert.equal(result.reviews[0].followups[0].seller_replies[0].body, 'Follow-up reply');
  assert.equal(result.reviews[1].seller_replies[0].body, 'Other reply');
  assert.equal(result.reviews[1].followups.length, 0);
  assert.equal(result.fold_notice_text, '已折叠20条评价');
  assert.equal(result.coverage.full_list, false);
});

test('review fields retain their owner even when follow-ups precede the main body', () => {
  const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
  const followup = element('append', '', [element('content', '7天后追评：Follow-up', [element('appendInternal', '7天后追评：')]),
    element('meta', 'Wrong purchase metadata')]);
  const comment = element('Comment', '', [followup, element('content', 'Main'), element('meta', '2026年9月22日已购：黑色')]);
  const nodes = [element('ItemTitle', 'Product'), element('Drawer', '', [element('Comments', '', [comment])])];
  const result = validateReviews(evaluate(reviewsScript(target), target.url, nodes), target).result;
  assert.equal(result.reviews[0].body, 'Main');
  assert.equal(result.reviews[0].variant_text, '黑色');
  assert.equal(result.reviews[0].followups[0].body, 'Follow-up');
  comment.children.splice(1, 1);
  assert.throws(() => validateReviews(evaluate(reviewsScript(target), target.url, nodes), target), { code: 'PAGE_STRUCTURE_CHANGED' });
});

test('ambiguous review body, metadata, reply text and nested main reviews fail closed', () => {
  const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
  for (const extra of [element('content', 'Duplicate'), element('meta', 'Duplicate'),
    element('reply', '', [element('text', '商家回复：One'), element('text', '商家回复：Two')]),
    element('Comment', '', [element('content', 'Nested review')])]) {
    const comment = element('Comment', '', [element('content', 'Main'), element('meta', ''), extra]);
    const nodes = [element('ItemTitle', 'Product'), element('Drawer', '', [element('Comments', '', [comment])])];
    assert.equal(evaluate(reviewsScript(target), target.url, nodes).state, 'structure_changed');
  }
});

test('ambiguous product titles prevent review expansion without dispatch', () => {
  const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
  let clicks = 0;
  const nodes = [element('ItemTitle', 'Product'), element('ItemTitle', 'Other'),
    element('Comments', '', [element('ShowButton', '查看全部评价', [], { click: () => { clicks++; } })])];
  assert.equal(evaluate(reviewsScript(target, true), target.url, nodes).state, 'structure_changed');
  assert.equal(clicks, 0);
});

function reviewImageDom() {
  const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
  const image = (url = 'https://img.alicdn.com/photo.jpg', attrs = {}) => element('', '', [],
    { tagName: 'IMG', currentSrc: url, complete: true, naturalWidth: 800, naturalHeight: 600, ...attrs });
  const photo = (url, attrs = {}) => element('photo', '', [image(url)], attrs);
  const followup = element('append', '', [element('content', '7天后追评：Later', [element('appendInternal', '7天后追评：')]),
    element('album', '', [photo('https://img.alicdn.com/later.jpg')])]);
  const album = element('album', '', [photo('https://img.alicdn.com/main.jpg'),
    photo('https://img.alicdn.com/DO_NOT_KEEP-cover.png', { className: 'photo--synthetic cover--synthetic' })]);
  const comment = element('Comment', '', [element('content', 'Main'),
    element('avatar', '', [image('https://img.alicdn.com/DO_NOT_KEEP-avatar.jpg')]),
    element('creditImg', '', [image('https://img.alicdn.com/DO_NOT_KEEP-credit.png')]), followup, album]);
  const root = element('Comments', '', [comment]);
  const nodes = [element('ItemTitle', 'Product'), element('Drawer', '', [root])];
  return { target, image, photo, followup, album, comment, root, nodes,
    read: () => evaluate(reviewsScript(target), target.url, nodes) };
}

function reviewCategoryDom() {
  const f = reviewImageDom(); let clicks = 0;
  const entries = ['全部', '追评', '静音效果好'].map((label, index) => element('imprItem', label + (index ? '20' : ''),
    index ? [element('imprItemCount', '20')] : [], {
      tagName: 'SPAN', className: `imprItem--synthetic${index ? '' : ' isSelected--synthetic'}`,
      click: () => { clicks++; },
    }));
  const wrap = element('expressionWrap', '', entries), sort = element('sortByText', '默认排序');
  f.root.children.push(wrap, sort); wrap.parentElement = f.root; sort.parentElement = f.root;
  return { ...f, entries, clicks: () => clicks,
    readCategories: options => evaluate(reviewCategoriesScript(f.target, options), f.target.url, f.nodes) };
}

function reviewEntryDom() {
  const f = reviewImageDom(); let clicks = 0, scrolls = 0;
  f.root.getBoundingClientRect = () => ({ x: -1536, y: 16, width: 1391, height: 1250 });
  const entry = element('ShowButton', '查看全部评价', [], {
    getBoundingClientRect: () => ({ x: 100, y: scrolls ? 100 : -7500, width: 150, height: 48 }),
    scrollIntoView: () => { scrolls++; }, click: () => { clicks++; },
  });
  f.nodes.push(element('Comments', '', [entry]));
  return { ...f, entry, clicks: () => clicks, scrolls: () => scrolls,
    inspect: (open = false, surface = entry) => evaluate(reviewPanelScript(f.target, open), f.target.url, f.nodes,
      'Synthetic product', () => [surface]) };
}

test('normal review entry opens once after a guarded scroll despite a mounted offscreen drawer', () => {
  const f = reviewEntryDom();
  assert.equal(f.inspect().state, 'panel_action_required'); assert.equal(f.scrolls(), 0);
  assert.equal(f.inspect(true).state, 'action_dispatched'); assert.equal(f.scrolls(), 1); assert.equal(f.clicks(), 1);
  assert.equal(f.read().state, 'review_drawer_not_visible');
});

test('a manually opened review panel is observed without scrolling or toggling it closed', () => {
  const f = reviewEntryDom(); f.root.getBoundingClientRect = () => ({ x: 10, y: 10, width: 500, height: 600 });
  assert.equal(f.inspect().state, 'panel_visible'); assert.equal(f.inspect(true).clicked, false);
  assert.equal(f.clicks(), 0); assert.equal(f.scrolls(), 0);
});

test('review panel opener refuses covered, hidden, disabled or ambiguous normal entries', () => {
  const covered = reviewEntryDom(); assert.equal(covered.inspect(true, element()).state, 'blocked_unknown');
  assert.equal(covered.clicks(), 0); assert.equal(covered.scrolls(), 1);
  for (const mutate of [f => f.entry.setAttribute('aria-disabled', 'true'), f => f.entry.setAttribute('inert', ''),
    f => { f.entry.parentElement.children.push(element('ShowButton', '查看全部评价')); },
    f => { f.entry.tagName = 'A'; }, f => { f.entry.style = { opacity: '0' }; }]) {
    const f = reviewEntryDom(); mutate(f); assert.equal(f.inspect(true).state, 'review_panel_required');
    assert.equal(f.scrolls(), 0); assert.equal(f.clicks(), 0);
  }
});

test('review panel opening checks product identity and verification before scrolling', () => {
  const f = reviewEntryDom();
  assert.equal(evaluate(reviewPanelScript(f.target, true), 'https://detail.tmall.com/item.htm?id=999', f.nodes).state, 'target_changed');
  f.nodes.push(element('', '', [], { id: 'nc_1_wrapper' }));
  assert.equal(f.inspect(true).state, 'verification_required'); assert.equal(f.scrolls(), 0); assert.equal(f.clicks(), 0);
});

function reviewCloseDom() {
  const f = reviewEntryDom(); let closes = 0;
  f.root.getBoundingClientRect = () => ({ x: 10, y: 10, width: 500, height: 600 });
  const close = element('closeWrap', '', [], { click: () => { closes++; } });
  const drawer = f.root.closest('[class^="Drawer--"]');
  drawer.children.push(close); close.parentElement = drawer;
  return { ...f, close, drawer, closes: () => closes,
    closePanel: (surface = close, url = f.target.url) => evaluate(reviewPanelCloseScript(f.target), url, f.nodes, 'Synthetic product', () => [surface]) };
}

test('normal review close acts on the outer close control without scrolling or reading media', () => {
  const f = reviewCloseDom();
  for (const node of [f.root, ...f.root.querySelectorAll('*')]) {
    Object.defineProperty(node, 'innerText', { get() { throw new Error('Unexpected review text'); } });
    if (node.tagName === 'IMG') Object.defineProperty(node, 'currentSrc', { get() { throw new Error('Unexpected image source'); } });
  }
  assert.equal(validateReviewPanelState(f.inspect()).state, 'open');
  assert.equal(f.closePanel().clicked, true); assert.equal(f.closes(), 1); assert.equal(f.scrolls(), 0);
});

test('closed collections return a no-click acknowledgement even if their drawer shell is mounted', () => {
  const f = reviewCloseDom(); f.root.getBoundingClientRect = () => ({ x: -1536, y: 0, width: 1391, height: 600 });
  assert.equal(validateReviewPanelState(f.inspect()).state, 'closed');
  assert.equal(f.closePanel().clicked, false); assert.equal(f.closes(), 0);
});

test('close guards reject wrong product, captcha, unknown dialogs and covered controls without clicks', () => {
  const wrong = reviewCloseDom(); assert.equal(wrong.closePanel(wrong.close, 'https://detail.tmall.com/item.htm?id=999').state, 'target_changed');
  const covered = reviewCloseDom(); assert.equal(covered.closePanel(element()).state, 'blocked_unknown');
  for (const [extra, expected] of [[element('', '', [], { id: 'nc_1_wrapper' }), 'verification_required'],
    [element('', 'Unknown prompt', [], { role: 'dialog' }), 'blocked_unknown']]) {
    const f = reviewCloseDom(); f.nodes.push(extra); assert.equal(f.closePanel().state, expected); assert.equal(f.closes(), 0);
  }
  assert.equal(wrong.closes(), 0); assert.equal(covered.closes(), 0);
});

test('ambiguous, disabled, hidden, linked and review-internal close candidates cannot be used', () => {
  for (const mutate of [f => { f.drawer.children.push(element('closeWrap')); f.drawer.children.at(-1).parentElement = f.drawer; },
    f => { f.close.setAttribute('aria-disabled', 'true'); }, f => { f.close.setAttribute('inert', ''); },
    f => { f.close.tagName = 'A'; }, f => { f.close.style = { opacity: '0' }; },
    f => { f.drawer.children.pop(); f.root.children.push(f.close); f.close.parentElement = f.root; }]) {
    const f = reviewCloseDom(); mutate(f); assert.equal(f.closePanel().state, 'structure_changed'); assert.equal(f.closes(), 0);
  }
  assert.throws(() => validateReviewPanelState({ state: 'verification_required' }), { code: 'VERIFICATION_REQUIRED' });
  assert.throws(() => validateReviewPanelState({ state: 'made_up' }), { code: 'INVALID_RESPONSE' });
});

test('text category DOM reads preserve exact labels and ten positions without touching image sources', () => {
  const f = reviewCategoryDom();
  for (const image of f.root.querySelectorAll('img')) {
    Object.defineProperty(image, 'currentSrc', { get() { throw new Error('Media read forbidden'); } });
  }
  for (let index = 1; index < 12; index++) {
    const comment = element('Comment', '', [element('content', index === 1 ? '' : `Row ${index}`)]);
    f.root.children.push(comment); comment.parentElement = f.root;
  }
  const raw = f.readCategories();
  assert.equal(raw.state, 'observed');
  const snapshot = validateReviewCategoryObservation(raw, f.target).snapshot;
  assert.deepEqual(Array.from(snapshot.categories, category => category.label), ['全部', '追评', '静音效果好']);
  assert.equal(snapshot.reviews.schema_version, 4); assert.equal(snapshot.reviews.returned_count, 10);
  assert.equal(snapshot.reviews.omitted_count, 2); assert.equal(snapshot.reviews.reviews[1].text_observed, false);
  assert.equal(snapshot.reviews.reviews[0].images, undefined);
  assert.equal(snapshot.reviews.reviews[0].followups[0].images, undefined);
});

test('category click guards compare exact prior labels, selection and text before dispatch', () => {
  const f = reviewCategoryDom(), before = validateReviewCategoryObservation(f.readCategories(), f.target).snapshot;
  assert.equal(f.readCategories({ before, label: '追评' }).state, 'action_dispatched');
  assert.equal(f.clicks(), 1);
  f.comment.children[0].innerText = 'Changed text';
  assert.equal(f.readCategories({ before, label: '追评' }).state, 'target_changed');
  assert.equal(f.clicks(), 1);
});

test('category DOM rejects duplicate labels, contradictory selection and ambiguous counts', () => {
  for (const mutate of [f => { f.entries[1].innerText = '全部20'; },
    f => { f.entries[1].className += ' isSelected--synthetic'; },
    f => { f.entries[0].setAttribute('aria-selected', 'false'); },
    f => { const count = element('imprItemCount', '30'); f.entries[1].children.push(count); count.parentElement = f.entries[1]; }]) {
    const f = reviewCategoryDom(); mutate(f);
    assert.equal(f.readCategories().state, 'review_categories_ambiguous'); assert.equal(f.clicks(), 0);
  }
});

test('offscreen category lists and unavailable click targets cannot dispatch or expose text', () => {
  const f = reviewCategoryDom();
  f.root.getBoundingClientRect = () => ({ x: -1536, y: 16, width: 1391, height: 1250 });
  assert.equal(f.readCategories().state, 'review_drawer_not_visible'); assert.equal(f.clicks(), 0);
  const disabled = reviewCategoryDom(); disabled.entries[1].setAttribute('aria-disabled', 'true');
  const before = validateReviewCategoryObservation(disabled.readCategories(), disabled.target).snapshot;
  assert.equal(disabled.readCategories({ before, label: '追评' }).state, 'review_category_unavailable');
  assert.equal(disabled.clicks(), 0);
  const hidden = reviewCategoryDom(); hidden.entries[0].style = { opacity: '0' };
  assert.throws(() => validateReviewCategoryObservation(hidden.readCategories(), hidden.target), { code: 'REVIEW_CATEGORY_UNAVAILABLE' });
});

test('an onscreen drawer shell cannot make offscreen review content readable or actionable', () => {
  const f = reviewImageDom();
  const root = f.comment.parentElement;
  root.getBoundingClientRect = () => ({ x: -1536, y: 16, width: 1391, height: 1250 });
  for (const expand of [false, true]) {
    const raw = evaluate(reviewsScript(f.target, expand), f.target.url,
      [element('ItemTitle', 'Product'), element('Drawer', '', [root])]);
    assert.equal(raw.state, 'review_drawer_not_visible');
    if (expand) assert.throws(() => validateReadActionAcknowledgement(raw),
      { code: 'REVIEW_DRAWER_NOT_VISIBLE', actionNotDispatched: true });
    else assert.throws(() => validateReviews(raw, f.target), { code: 'REVIEW_DRAWER_NOT_VISIBLE' });
  }
});

test('review content rejects invisible or inert ancestors before claiming an open panel', () => {
  for (const attributes of [{ style: { opacity: '0' } }, { 'aria-hidden': 'true' }, { inert: '' }, { hidden: '' }]) {
    const f = reviewImageDom(), root = f.comment.parentElement;
    const ancestor = element('', '', [root], attributes);
    const nodes = [element('ItemTitle', 'Product'), element('Drawer', '', [ancestor])];
    assert.equal(evaluate(reviewsScript(f.target), f.target.url, nodes).state, 'review_drawer_not_visible');
    assert.equal(evaluate(reviewsScript(f.target, true), f.target.url, nodes).state, 'review_drawer_not_visible');
  }
});

test('open review containers retain loaded rows below their scrolling viewport', () => {
  const f = reviewImageDom(), root = f.comment.parentElement;
  root.getBoundingClientRect = () => ({ x: 100, y: 16, width: 600, height: 1250 });
  f.comment.getBoundingClientRect = () => ({ x: 100, y: 1600, width: 500, height: 300 });
  assert.equal(f.read().state, 'observed');
});

test('review content outside each viewport edge stops while malformed geometry is structural', () => {
  for (const [rect, state] of [
    [{ x: 1000, y: 0, width: 50, height: 100 }, 'review_drawer_not_visible'],
    [{ x: -100, y: 0, width: 100, height: 100 }, 'review_drawer_not_visible'],
    [{ x: 0, y: 800, width: 100, height: 100 }, 'review_drawer_not_visible'],
    [{ x: 0, y: -100, width: 100, height: 100 }, 'review_drawer_not_visible'],
    [{ x: 0, y: 0, width: 0, height: 100 }, 'review_drawer_not_visible'],
    [{ x: NaN, y: 0, width: 100, height: 100 }, 'structure_changed'],
  ]) {
    const f = reviewImageDom();
    f.comment.parentElement.getBoundingClientRect = () => rect;
    assert.equal(f.read().state, state);
  }
});

test('review albums keep main and follow-up images separate while withholding cover assets and avatars', () => {
  const f = reviewImageDom(), raw = f.read();
  assert.ok(!JSON.stringify(raw).includes('DO_NOT_KEEP'));
  const result = validateReviews(raw, f.target).result, review = result.reviews[0];
  assert.equal(review.images.slots_seen, 2);
  assert.equal(review.images.image_links_returned, 1);
  assert.equal(review.images.covered_slots, 1);
  assert.equal(review.images.slots[0].image.url, 'https://img.alicdn.com/main.jpg');
  assert.equal(review.images.slots[1].image, null);
  assert.equal(review.followups[0].images.slots[0].image.url, 'https://img.alicdn.com/later.jpg');
});

test('review image positions are bounded without merging repeated URLs or unrelated video content', () => {
  const f = reviewImageDom();
  const album = element('album', '', [element('photo', '', [element('', '', [], { tagName: 'VIDEO' }), f.image()]),
    ...Array.from({ length: 6 }, () => f.photo('https://img.alicdn.com/same.jpg'))]);
  f.comment.children.splice(f.comment.children.indexOf(f.album), 1, album); album.parentElement = f.comment;
  const images = validateReviews(f.read(), f.target).result.reviews[0].images;
  assert.equal(images.slots_seen, 7); assert.equal(images.slots_scanned, 6); assert.equal(images.slots_omitted, 1);
  assert.equal(images.slots[0].state, 'video_excluded'); assert.equal(images.slots[0].image, null);
  assert.equal(images.image_links_returned, 5);
  assert.equal(images.slots[5].position, 6);
});

test('ambiguous review albums or thumbnails stop instead of selecting arbitrary images', () => {
  for (const mutate of [f => { const album = element('album'); album.parentElement = f.comment; f.comment.children.push(album); },
    f => { const image = f.image(); image.parentElement = f.album.children[0]; f.album.children[0].children.push(image); }]) {
    const f = reviewImageDom(); mutate(f); assert.equal(f.read().state, 'structure_changed');
  }
});

test('review relation counts disclose capped follow-ups and replies, including follow-up replies', () => {
  const f = reviewImageDom();
  const reply = () => element('reply', '', [element('text', '商家回复：Reply')]);
  const followup = () => element('append', '', [element('content', '7天后追评：Later', [element('appendInternal', '7天后追评：')]),
    reply(), reply(), reply()]);
  const comment = element('Comment', '', [element('content', 'Main'), reply(), reply(), reply(), followup(), followup(), followup()]);
  const root = element('Comments', '', [comment, ...Array.from({length:20},()=>element('Comment','',[element('content','Another')]))]);
  const result = validateReviews(evaluate(reviewsScript(f.target), f.target.url,
    [element('ItemTitle','Product'),element('Drawer','',[root])]), f.target).result;
  assert.equal(result.loaded_count, 21); assert.equal(result.returned_count, 20); assert.equal(result.omitted_count, 1);
  const first = result.reviews[0];
  assert.equal(first.relation_scope.followups.omitted, 1);
  assert.equal(first.relation_scope.seller_replies.omitted, 1);
  assert.equal(first.followups[0].relation_scope.seller_replies.omitted, 1);
});

test('v3 keeps image-only review rows without inventing text or accepting an empty unsupported row', () => {
  const f=reviewImageDom();f.comment.children[0].innerText='';
  const result=validateReviews(f.read(),f.target).result;
  assert.equal(result.reviews[0].body,'');assert.equal(result.reviews[0].images.slots_seen,2);
  f.comment.children.splice(f.comment.children.indexOf(f.album),1);
  assert.throws(()=>validateReviews(f.read(),f.target),{code:'PAGE_STRUCTURE_CHANGED'});
});

test('a body field containing another entry stops rather than concatenating main and follow-up text', () => {
  const target=parseProductUrl('https://detail.tmall.com/item.htm?id=123');
  const append=element('append','',[element('content','7天后追评：Later',[element('appendInternal','7天后追评：')])]);
  const comment=element('Comment','',[element('content','Main and later text',[append])]);
  const nodes=[element('ItemTitle','Product'),element('Drawer','',[element('Comments','',[comment])])];
  assert.equal(evaluate(reviewsScript(target),target.url,nodes).state,'structure_changed');
});
