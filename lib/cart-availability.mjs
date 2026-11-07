import { ShoppingError } from './errors.mjs';

// Observed on the live cart, 2026-10-13: these overlay texts accompany the full set of cannot-buy markers.
const CANNOT_BUY_IMAGE_TEXTS = new Set(['商品下架', '不可购买']);
const VARIANT_OUT_OF_STOCK_IMAGE_TEXT = '款式缺货';
// Rule 1 (2026-10-13) required a bare product image for no_marker_seen. Rule 2 (2026-10-14) also accepts promotional
// overlay text such as 全网低价, seen live on an enabled row without any invalid style; saved results keep the rule they were made with.
export const CART_AVAILABILITY_RULES = 2;
export const CART_AVAILABILITY_STATUSES = ['cannot_buy', 'variant_out_of_stock', 'no_marker_seen', 'unrecognized'];

const invalid = () => { throw new ShoppingError('INVALID_RESPONSE', 'The cart returned invalid availability evidence.'); };
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) invalid();
}
function clean(value) { return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim(); }
function textGroup(value, limit) {
  if (value === null) return null;
  exact(value, ['items', 'truncated']);
  if (typeof value.truncated !== 'boolean' || !Array.isArray(value.items) || value.items.length > 5) invalid();
  return { items: value.items.map(item => {
    exact(item, ['text', 'truncated']);
    if (typeof item.text !== 'string' || item.text.length > limit || typeof item.truncated !== 'boolean') invalid();
    return { text: clean(item.text), truncated: item.truncated };
  }), truncated: value.truncated };
}
function checkboxGroup(value) {
  exact(value, ['items', 'truncated']);
  if (typeof value.truncated !== 'boolean' || !Array.isArray(value.items) || value.items.length > 5) invalid();
  return { items: value.items.map(item => {
    exact(item, ['disabled']);
    if (typeof item.disabled !== 'boolean') invalid();
    return { disabled: item.disabled };
  }), truncated: value.truncated };
}
function marker(value) {
  if (value !== null && typeof value !== 'boolean') invalid();
  return value;
}

function onlyText(group) {
  return group && !group.truncated && group.items.length === 1 && !group.items[0].truncated && group.items[0].text ? group.items[0].text : null;
}
function noText(group) { return group !== null && !group.truncated && group.items.length === 0; }
function promotionalOnly(group) {
  return group !== null && !group.truncated && group.items.every(item => !item.truncated &&
    !CANNOT_BUY_IMAGE_TEXTS.has(item.text) && item.text !== VARIANT_OUT_OF_STOCK_IMAGE_TEXT);
}

// Only the exact live-observed marker combinations are classified; anything else stays unrecognized with its raw signals.
function classify(signals, rules) {
  const checkbox = !signals.checkboxes.truncated && signals.checkboxes.items.length === 1 ? signals.checkboxes.items[0].disabled : null;
  const image = onlyText(signals.image_texts), message = onlyText(signals.messages);
  const { specification_invalid: specification, price_invalid: price, quantity_disabled: quantity } = signals;
  if (checkbox === true && specification === true && price === true && quantity === true && CANNOT_BUY_IMAGE_TEXTS.has(image) && message) {
    return { status: 'cannot_buy', reason: { ...signals.messages.items[0] } };
  }
  if (checkbox === true && specification === false && price === true && quantity === false &&
      image === VARIANT_OUT_OF_STOCK_IMAGE_TEXT && noText(signals.messages)) return { status: 'variant_out_of_stock', reason: null };
  if (checkbox === false && specification === false && price === false && quantity === false && noText(signals.messages) &&
      (rules === 1 ? noText(signals.image_texts) : promotionalOnly(signals.image_texts))) return { status: 'no_marker_seen', reason: null };
  return { status: 'unrecognized', reason: null };
}

/**
 * Validate one row's raw availability signals and classify them from explicit page markers only.
 * @param {unknown} value Collector signals: overlay texts, detail messages, row checkboxes and three marker flags (null when the region is absent).
 * @param {{rules?:1|2}} [options] Classification rule; 1 only to revalidate results saved before rule 2.
 * @returns {{status:string, reason:{text:string,truncated:boolean}|null, classification_version?:2, signals:object, purchase_verified:false}}
 * `no_marker_seen` never means purchasable; `reason` is the verbatim detail message of a cannot-buy row.
 * Rule 1 results carry no `classification_version`, matching what was saved before it existed.
 * @throws {ShoppingError} INVALID_RESPONSE for malformed signals or an unknown rule.
 * @example normalizeCartAvailability({image_texts:{items:[],truncated:false}, messages:{items:[],truncated:false},
 *   checkboxes:{items:[{disabled:false}],truncated:false}, specification_invalid:false, price_invalid:false, quantity_disabled:false});
 */
export function normalizeCartAvailability(value, { rules = CART_AVAILABILITY_RULES } = {}) {
  if (rules !== 1 && rules !== 2) invalid();
  exact(value, ['image_texts', 'messages', 'checkboxes', 'specification_invalid', 'price_invalid', 'quantity_disabled']);
  const signals = { image_texts: textGroup(value.image_texts, 100), messages: textGroup(value.messages, 200),
    checkboxes: checkboxGroup(value.checkboxes), specification_invalid: marker(value.specification_invalid),
    price_invalid: marker(value.price_invalid), quantity_disabled: marker(value.quantity_disabled) };
  return { ...classify(signals, rules), ...(rules === 1 ? {} : { classification_version: rules }), signals, purchase_verified: false };
}

/** @param {object[]} rows Normalized rows with availability. @returns {object} Count per status, every status present. @example cartAvailabilitySummary(snapshot.rows); */
export function cartAvailabilitySummary(rows) {
  const summary = Object.fromEntries(CART_AVAILABILITY_STATUSES.map(status => [status, 0]));
  for (const row of rows) summary[row.availability.status] += 1;
  return summary;
}
