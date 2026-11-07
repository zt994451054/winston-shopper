import { ShoppingError } from './errors.mjs';
import { responseText } from './page-dom.mjs';
import { parseSortableSearchUrl } from './search.mjs';

/** @param {object} dom Page-local visible DOM helpers. @param {Element} price @param {Element} sortRoot @returns {object} Bounded visible labels and truncation flag; no application state or actions. */
export function collectPriceDirections(dom, price, sortRoot) {
  const pattern = /^(?:价格|总价|单价)?(?:从)?(?:低到高|高到低|升序|降序)(?:排序)?$/;
  const nodes = document.querySelectorAll('div, li, span, button, a, [role="menuitem"], [role="option"]');
  const candidates = [];
  const limit = Math.min(nodes.length, 3000);
  for (let index = 0; index < limit && candidates.length < 8; index += 1) {
    const node = nodes[index];
    if (!dom.visible(node) || node.children.length > 3) continue;
    const label = dom.text(node, 40);
    if (!pattern.test(label) || [...node.children].some(child => dom.visible(child) && dom.text(child, 40) === label)) continue;
    candidates.push({ label, tag: node.tagName.toUpperCase(), class_name: (node.getAttribute('class') ?? '').slice(0, 300),
      role: (node.getAttribute('role') ?? '').slice(0, 40), parent_class: (node.parentElement?.getAttribute('class') ?? '').slice(0, 300),
      within_price_tab: price.contains(node), within_sort_bar: sortRoot.contains(node) });
  }
  return { candidates, scan_truncated: nodes.length > limit || candidates.length === 8 };
}

/** @param {object} value @returns {object} Canonical bounded visible label evidence; ancestry does not prove menu ownership. @throws {ShoppingError} INVALID_RESPONSE. */
export function normalizePriceDirections(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'candidates,scan_truncated' || typeof value.scan_truncated !== 'boolean' ||
      !Array.isArray(value.candidates) || value.candidates.length > 8) throw new ShoppingError('INVALID_RESPONSE', 'Invalid bounded direction-label evidence.');
  return { candidates: value.candidates.map(candidate => {
    if (!candidate || Object.keys(candidate).sort().join(',') !== 'class_name,label,parent_class,role,tag,within_price_tab,within_sort_bar' ||
        typeof candidate.within_price_tab !== 'boolean' || typeof candidate.within_sort_bar !== 'boolean' ||
        (candidate.within_price_tab && !candidate.within_sort_bar)) throw new ShoppingError('INVALID_RESPONSE', 'Invalid direction-label ancestry.');
    const result = { label: responseText(candidate.label, 40), tag: responseText(candidate.tag, 20), class_name: responseText(candidate.class_name, 300),
      role: responseText(candidate.role, 40), parent_class: responseText(candidate.parent_class, 300),
      within_price_tab: candidate.within_price_tab, within_sort_bar: candidate.within_sort_bar };
    if (!/^(?:价格|总价|单价)?(?:从)?(?:低到高|高到低|升序|降序)(?:排序)?$/.test(result.label) || !/^[A-Z][A-Z0-9-]{0,19}$/.test(result.tag)) throw new ShoppingError('INVALID_RESPONSE', 'Unexpected direction-label metadata.');
    return result;
  }), scan_truncated: value.scan_truncated };
}

/** @param {object} value @returns {string} Only the guarded price-tab selector, never caller-supplied CSS. @throws {ShoppingError} INVALID_RESPONSE. */
export function validateHoverPreparation(value) {
  const prefix = ':is([class^="sortBarWrapper--"], [class*=" sortBarWrapper--"]) [role="tab"]:is([class^="customTabItemWithArr--"], [class*=" customTabItemWithArr--"]):nth-child(';
  if (value?.state !== 'hover_prepared' || typeof value.selector !== 'string' || ![1, 2, 3, 4, 5, 6, 7, 8].some(index => value.selector === `${prefix}${index})`)) {
    throw new ShoppingError('INVALID_RESPONSE', 'The guarded price hover did not provide an expected selector.');
  }
  return value.selector;
}

/** @param {object} data @param {object} before @returns {string} Fresh scoped accessibility reference for the unique price tab. @throws {ShoppingError} INVALID_RESPONSE or TARGET_CHANGED. */
export function validatePriceHoverReference(data, before) {
  if (parseSortableSearchUrl(data?.url)?.url !== before.inspection.search.url) throw new ShoppingError('TARGET_CHANGED', 'The scoped reference no longer belongs to the saved search page.');
  const refs = data?.snapshotData?.refs;
  if (!refs || Array.isArray(refs) || Object.keys(refs).length > 32) throw new ShoppingError('INVALID_RESPONSE', 'The scoped reference inventory is invalid.');
  const matches = Object.entries(refs).filter(([, ref]) => ref?.role === 'tab' && ref.name === '价格');
  if (matches.length !== 1 || !/^[a-zA-Z0-9_-]{1,32}$/.test(matches[0][0]) || !Number.isSafeInteger(matches[0][1].backendDOMNodeId) || matches[0][1].backendDOMNodeId < 1) {
    throw new ShoppingError('INVALID_RESPONSE', 'The scoped reference does not identify one price tab.');
  }
  return matches[0][0];
}
