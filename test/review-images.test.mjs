import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReviewImages } from '../lib/review-images.mjs';
import { validateReviews, validateSavedReviews } from '../lib/reviews.mjs';
import { parseProductUrl } from '../lib/targets.mjs';
import { rawReviews } from '../test-support/search-review-fixture.mjs';

const target = parseProductUrl('https://detail.tmall.com/item.htm?id=123');
const emptyImages = () => ({album_observed:false,slots_seen:0,items:[]});
const image = (url='https://img.alicdn.com/photo.jpg') => ({state:'image_observed',url,loaded:true,width:800,height:600});
function fixture() {
  const raw=rawReviews(target);raw.schema_version=3;raw.fold_notice_text='';
  raw.reviews.forEach(review=>Object.assign(review,{images:{album_observed:true,slots_seen:4,
    items:[image(),{state:'covered'},image('https://evil.test/DO_NOT_KEEP'),{state:'image_not_observed'}]},
    seller_replies_seen:1,seller_replies:[{raw:'商家回复：Main reply'}],followups_seen:1,
    followups:[{raw:'7天后追评：Later',interval_text:'7天后追评：',images:emptyImages(),
      seller_replies_seen:1,seller_replies:[{raw:'商家回复：Later reply'}]}]}));
  return raw;
}

test('v3 round trips preserve image slots, raw relation text, positions and unknown IDs',()=>{
  const result=validateReviews(fixture(),target).result;
  const before=JSON.stringify(result);validateSavedReviews(result,target);assert.equal(JSON.stringify(result),before);
  assert.ok(!before.includes('DO_NOT_KEEP'));
  assert.equal(result.reviews[0].review_id,null);
  assert.equal(result.reviews[0].images.slots[2].state,'unsupported_url');
  assert.equal(result.reviews[0].followups[0].seller_replies[0].body,'Later reply');
  assert.equal(result.reviews[0].images.original_images_verified,false);
});

test('review images reject unsafe links without retaining credentials, queries or tracker fragments',()=>{
  for(const url of ['http://img.alicdn.com/a.jpg','https://u:p@img.alicdn.com/a.jpg','https://img.alicdn.com/a.jpg?token=DO_NOT_KEEP',
    'https://img.alicdn.com.evil.test/a.jpg','data:image/png;base64,DO_NOT_KEEP','https://img.alicdn.com/a.jpg#DO_NOT_KEEP']) {
    const result=normalizeReviewImages({album_observed:true,slots_seen:1,items:[image(url)]});
    assert.equal(result.image_links_returned,0);assert.equal(result.slots[0].state,'unsupported_url');
    assert.ok(!JSON.stringify(result).includes('DO_NOT_KEEP'));
  }
});

test('invalid review image counts, dimensions and covered URLs fail instead of producing plausible photos',()=>{
  for(const value of [null,{...emptyImages(),slots_seen:1},{album_observed:true,slots_seen:2,items:[image()]},
    {album_observed:true,slots_seen:1,items:[{state:'covered',url:'https://img.alicdn.com/cover.jpg'}]},
    {album_observed:true,slots_seen:1,items:[{...image(),width:0}]},
    {album_observed:true,slots_seen:1,items:[{state:'unknown'}]}]) assert.throws(()=>normalizeReviewImages(value),{code:'INVALID_RESPONSE'});
});

test('v3 cached images and coverage cannot be promoted, reparented through edited fields or silently backfilled',()=>{
  const result=validateReviews(fixture(),target).result;
  for(const mutate of [r=>{r.omitted_count=1;},r=>{r.reviews[0].images.original_images_verified=true;},
    r=>{r.reviews[0].images.slots[0].position=2;},r=>{r.reviews[0].images.covered_slots=0;},
    r=>{r.reviews[0].images.slots[1].image={url:'https://img.alicdn.com/fake.jpg'};},
    r=>{r.reviews[0].relation_scope.followups.omitted=1;},r=>{delete r.reviews[0].images;},
    r=>{r.reviews[0].followups[0].seller_replies[0].body='Wrong';}]) {
    const saved=structuredClone(result);mutate(saved);assert.throws(()=>validateSavedReviews(saved,target),{code:'INVALID_CHECKPOINT'});
  }
  const legacy=validateReviews(rawReviews(target),target).result;
  const before=JSON.stringify(legacy);validateSavedReviews(legacy,target);assert.equal(JSON.stringify(legacy),before);
  assert.equal(legacy.reviews[0].images,undefined);
});

test('v3 requires coherent collection and relation counts and keeps unloaded images explicit',()=>{
  for(const mutate of [r=>{r.loaded_count=3;},r=>{r.reviews[0].followups_seen=2;},
    r=>{r.reviews[0].seller_replies_seen=-1;},r=>{delete r.reviews[0].followups[0].seller_replies_seen;}]) {
    const raw=fixture();mutate(raw);assert.throws(()=>validateReviews(raw,target),{code:'INVALID_RESPONSE'});
  }
  const raw=fixture();Object.assign(raw.reviews[0].images.items[0],{loaded:false,width:0,height:0});
  const result=validateReviews(raw,target).result;validateSavedReviews(result,target);
  assert.equal(result.reviews[0].images.slots[0].image.loaded,false);
});
