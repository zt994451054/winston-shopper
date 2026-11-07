import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { detailsScript, detailUrl, validateDetails, validateSavedDetails } from '../lib/details.mjs';
import { parseProductUrl } from '../lib/targets.mjs';
import { rawDetails } from '../test-support/detail-fixture.mjs';
import { normalizeDescriptionObservation } from '../lib/description-dom.mjs';

const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');

function descriptionObservation() {
  return { schema_version: 1, text_container_observed: true, nodes_scanned: 4, traversal_truncated: false,
    text_truncated: false, clipped_subtrees_omitted: 0, control_candidates: [], controls_truncated: false,
    expansion_behavior_verified: false, limits: { nodes: 800, depth: 12, text_characters: 6000, controls: 8 } };
}

test('optional description observations survive response key reordering and cached validation', () => {
  const raw = rawDetails(), observation = descriptionObservation();
  raw.details.description.observation = Object.fromEntries(Object.entries(observation).reverse());
  raw.details.description.observation.limits = Object.fromEntries(Object.entries(observation.limits).reverse());
  const result = validateDetails(raw, target);
  assert.deepEqual(result.details.description.observation, observation);
  validateSavedDetails(result, target);
  const legacy = validateDetails(rawDetails(), target), before = JSON.stringify(legacy);
  validateSavedDetails(legacy, target);
  assert.equal(JSON.stringify(legacy), before);
  assert.equal(legacy.details.description.observation, undefined);
});

test('description observation limits, numeric counts and behavior guarantees cannot be forged', () => {
  for (const mutate of [v => { v.nodes_scanned = 801; }, v => { v.clipped_subtrees_omitted = 5; },
    v => { v.limits.depth = 99; }, v => { v.expansion_behavior_verified = true; }, v => { v.unknown = true; },
    v => { v.control_candidates = [{label:'Buy now',tag:'BUTTON',class_name:'',aria_expanded:'',disabled:false}]; }]) {
    const value = descriptionObservation(); mutate(value);
    assert.throws(() => normalizeDescriptionObservation(value), {code:'INVALID_RESPONSE'});
  }
  const raw = rawDetails(); raw.details.description.observation = descriptionObservation();
  const saved = validateDetails(raw, target); saved.details.description.observation.expansion_behavior_verified = true;
  assert.throws(() => validateSavedDetails(saved, target), {code:'INVALID_CHECKPOINT'});
});

test('description evidence cannot claim text from a missing container or traversal of an absent region', () => {
  const raw = rawDetails(); raw.details.description.observation = descriptionObservation();
  raw.details.description.text = 'Visible text'; raw.details.description.observation.text_container_observed = false;
  assert.throws(() => validateDetails(raw, target), {code:'INVALID_RESPONSE'});
  Object.assign(raw.details.description, {observed:false, text:'', elements_seen:0, items:[]});
  assert.throws(() => validateDetails(raw, target), {code:'INVALID_RESPONSE'});
  raw.details.description.observation.nodes_scanned = 0;
  validateSavedDetails(validateDetails(raw, target), target);
});

test('detail availability separates image links, loaded images and unscanned content without claiming lazy-load coverage', () => {
  const raw = rawDetails(); raw.details.attributes.rows_seen = 103;
  raw.details.gallery.elements_seen = 24;
  raw.details.description.elements_seen = 3;
  raw.details.description.items.push({ url:'https://img.alicdn.com/pending.jpg', loaded:false, width:0, height:0 });
  const result = validateDetails(raw,target), available=result.details.availability;
  assert.equal(result.details.schema_version,2);
  assert.equal(available.parameters.unscanned_rows,101);
  assert.equal(available.gallery.unscanned_elements,20);
  assert.equal(available.description.content_kind,'image_links_only');
  assert.equal(available.description.returned_images,2);
  assert.equal(available.description.loaded_returned_images,1);
  assert.equal(available.description.not_loaded_returned_images,1);
  assert.equal(available.description.unscanned_elements,1);
  assert.equal(available.unloaded_or_folded_content_verified,false);
  validateSavedDetails(result,target);
});

test('detail availability distinguishes an absent region, no supported content, text and mixed content', () => {
  for (const [observed,text,withImage,kind] of [[false,'',false,'region_not_observed'],[true,'',false,'no_supported_content_observed'],
    [true,'Visible terms',false,'text_only'],[true,'Visible terms',true,'text_and_image_links']]) {
    const raw=rawDetails();Object.assign(raw.details.description,{observed,text,elements_seen:Number(withImage),items:withImage?raw.details.description.items:[]});
    assert.equal(validateDetails(raw,target).details.availability.description.content_kind,kind);
  }
});

test('legacy details remain valid and do not acquire availability fields during cached validation', () => {
  const legacy=validateDetails(rawDetails(),target);legacy.details.schema_version=1;delete legacy.details.availability;
  const original=JSON.stringify(legacy);validateSavedDetails(legacy,target);
  assert.equal(JSON.stringify(legacy),original);
  legacy.details.availability={};assert.throws(()=>validateSavedDetails(legacy,target),{code:'INVALID_CHECKPOINT'});
});

test('saved availability cannot inflate image loading or upgrade detail coverage', () => {
  const result=validateDetails(rawDetails(),target);
  for (const mutate of [d=>{d.availability.description.loaded_returned_images+=1;},d=>{d.availability.description.content_kind='text_only';},
    d=>{d.availability.unloaded_or_folded_content_verified=true;},d=>{d.schema_version=3;}]) {
    const changed=structuredClone(result);mutate(changed.details);
    assert.throws(()=>validateSavedDetails(changed,target),{code:'INVALID_CHECKPOINT'});
  }
});

test('detail observations preserve parameter sources, omit tracking and retain deduplicated image positions', () => {
  const result = validateDetails(rawDetails(), target), details = result.details;
  assert.equal(details.shop.url, 'https://shop123.taobao.com/category.htm');
  assert.equal(details.attributes.items[0].name, '连接方式');
  assert.equal(details.attributes.items[1].value, 'Synthetic brand');
  assert.deepEqual(details.gallery.items.map(item => item.position), [1, 4]);
  assert.equal(details.gallery.duplicates_omitted, 1);
  assert.equal(details.gallery.unsupported_urls_omitted, 1);
  assert.equal(details.description.image_text_extracted, false);
  assert.equal(details.description.text, '');
  assert.equal(details.coverage.full_description, false);
  assert.equal(details.services.conditions_verified, false);
  assert.ok(!JSON.stringify(result).includes('DO_NOT_KEEP'));
  validateSavedDetails(result, target);
});

test('detail URLs reject credentials, redirects, lookalike hosts and unverified image queries', () => {
  for (const value of ['javascript:alert(1)', 'https://user:pass@img.alicdn.com/a.jpg',
    'https://img.alicdn.com.evil.test/a.jpg', 'https://img.alicdn.com:123/a.jpg',
    'https://img.alicdn.com/a.jpg?token=secret', 'https://img.alicdn.com/a.jpg#secret', 'https://img.alicdn.com/a\nb.jpg']) {
    assert.equal(detailUrl(value, 'image'), null);
  }
  assert.equal(detailUrl('https://shop123.taobao.com/order.htm', 'shop'), null);
  assert.equal(detailUrl('https://example.tmall.com/?spm=tracking', 'shop'), 'https://example.tmall.com/');
  assert.equal(detailUrl('https://img.alicdn.com/a.jpg', 'image'), 'https://img.alicdn.com/a.jpg');
});

test('missing detail regions remain explicit and a wholly unsupported page is not a successful empty read', () => {
  const raw = rawDetails();
  raw.details.shop = null;
  raw.details.attributes = { observed: false, rows_seen: 0, items: [] };
  for (const key of ['gallery', 'description']) Object.assign(raw.details[key], { observed: false, elements_seen: 0, items: [] });
  const result = validateDetails(raw, target);
  assert.ok(result.details.missing.includes('description_content'));
  validateSavedDetails(result, target);
  raw.details.services = { observed: false, labels: [] };
  raw.details.shipping = { observed: false, freight_labels: [] };
  assert.throws(() => validateDetails(raw, target), { code: 'UNSUPPORTED_CAPABILITY' });
});

test('malformed parameter rows, image dimensions and contradictory region counts fail explicitly', () => {
  for (const mutate of [raw => { raw.details.attributes.items[0].name = ''; },
    raw => { raw.details.gallery.items[0].width = 0; }, raw => { raw.details.attributes.rows_seen = 0; },
    raw => { raw.details.description.observed = false; }, raw => { raw.details.services.labels = ['']; }]) {
    const raw = rawDetails(); mutate(raw); assert.throws(() => validateDetails(raw, target));
  }
});

test('saved details reject extra fields, invented coverage, invalid counts, positions and URLs', () => {
  const result = validateDetails(rawDetails(), target);
  for (const mutate of [details => { details.token = 'PRIVATE'; }, details => { details.coverage.full_description = true; },
    details => { details.gallery.elements_scanned = 21; }, details => { details.gallery.duplicates_omitted = 0; },
    details => { details.gallery.items[1].position = 1; }, details => { details.gallery.items[0].url = 'https://evil.test/a.jpg'; },
    details => { details.description.image_text_extracted = true; }]) {
    const changed = structuredClone(result); mutate(changed.details);
    assert.throws(() => validateSavedDetails(changed, target), { code: 'INVALID_CHECKPOINT' });
  }
});

test('details check identity before DOM access and never return plausible content behind a page gate', () => {
  const document = new Proxy({}, { get() { throw new Error('No DOM reads permitted'); } });
  assert.equal(vm.runInNewContext(detailsScript(target), { URL, location: { href: 'https://example.test/' }, document }).state, 'target_changed');
  for (const [state, code] of [['verification_required', 'VERIFICATION_REQUIRED'], ['rate_limited', 'RATE_LIMITED'], ['login_required', 'LOGIN_REQUIRED']]) {
    assert.throws(() => validateDetails({ ...rawDetails(), state }, target), { code });
  }
});
