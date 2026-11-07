import { ShoppingError } from './errors.mjs';
import { parseProductUrl } from './targets.mjs';
import { pageDom, throwPageError } from './page-dom.mjs';
import { reviewPanelVisibility } from './reviews.mjs';

function inspectPanel(expected, dom, visibility, open) {
  const url = new URL(location.href);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname ||
      url.searchParams.getAll('id').length !== 1 || url.searchParams.get('id') !== expected.product_id) return { state: 'target_changed' };
  const drawers = dom.all(document, dom.selector('Drawer')).filter(node => dom.one(node, 'Comments'));
  const gate = dom.gate(drawers.length === 1 ? drawers[0] : null);
  if (gate) return { state: gate };
  if (drawers.length > 1 || dom.all(document, dom.selector('ItemTitle')).length !== 1) return { state: 'structure_changed' };
  if (drawers.length) {
    const roots = dom.all(drawers[0], dom.selector('Comments'));
    if (roots.length !== 1) return { state: 'structure_changed' };
    const state = visibility(roots[0]);
    if (!state) return open ? { state: 'action_dispatched', clicked: false } : { state: 'panel_visible' };
    if (state !== 'review_drawer_not_visible') return { state };
  }
  const previews = dom.all(document, dom.selector('Comments')).filter(node => !node.closest(dom.selector('Drawer')));
  if (previews.length !== 1) return { state: 'review_panel_required' };
  const entries = dom.all(previews[0], dom.selector('ShowButton')).filter(node => dom.text(node, 80) === '查看全部评价');
  if (entries.length !== 1) return { state: 'review_panel_required' };
  const entry = entries[0];
  if (!['DIV', 'BUTTON'].includes(entry.tagName) || entry.closest('a') || dom.all(entry, 'a, button').length ||
      entry.disabled || entry.getAttribute('aria-disabled') === 'true' || entry.getAttribute('data-disabled') === 'true') return { state: 'review_panel_required' };
  for (let node = entry; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0' ||
        node.getAttribute('hidden') !== null || node.getAttribute('inert') !== null || node.getAttribute('aria-hidden') === 'true') return { state: 'review_panel_required' };
  }
  if (!open) return { state: 'panel_action_required' };
  // Scroll only this verified entry, then require its hit-tested surface before dispatching the saved intent.
  entry.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
  if (visibility(entry)) return { state: 'review_panel_required' };
  const rect = entry.getBoundingClientRect(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
  if (x < 0 || x >= innerWidth || y < 0 || y >= innerHeight) return { state: 'review_panel_required' };
  const surface = document.elementsFromPoint(x, y)[0];
  if (!surface || !entry.contains(surface)) return { state: 'blocked_unknown' };
  const finalGate = dom.gate(drawers.length === 1 ? drawers[0] : null);
  if (finalGate) return { state: finalGate };
  entry.click();
  return { state: 'action_dispatched', clicked: true };
}

/**
 * Inspect or open the unique normal review entry, even when a closed drawer is still mounted offscreen.
 * @param {object} target @param {boolean} [open=false] Caller must reserve one scroll/open intent first.
 * @returns {string} Fixed script; no pagination, media access or retry. Already visible panels are left open.
 * @throws {ShoppingError} INVALID_TARGET or INVALID_ARGUMENTS.
 * @example reviewPanelScript(target, true);
 */
export function reviewPanelScript(target, open = false) {
  const expected = parseProductUrl(target?.url);
  if (!expected) throw new ShoppingError('INVALID_TARGET', 'A public product target is required.');
  if (typeof open !== 'boolean') throw new ShoppingError('INVALID_ARGUMENTS', 'The panel action flag must be boolean.');
  return `(() => { try { return (${inspectPanel.toString()})(${JSON.stringify(expected)}, (${pageDom.toString()})(), ${reviewPanelVisibility.toString()}, ${open}); }
    catch { return { state: 'structure_changed' }; } })()`;
}

function closePanel(expected, dom, visibility, inspect) {
  const state = inspect(expected, dom, visibility, false);
  if (state.state === 'panel_action_required') return { state: 'action_dispatched', clicked: false };
  if (state.state !== 'panel_visible') return state;
  const drawers = dom.all(document, dom.selector('Drawer')).filter(node => dom.one(node, 'Comments'));
  if (drawers.length !== 1) return { state: 'structure_changed' };
  const drawer = drawers[0];
  const candidates = dom.all(drawer, dom.selector('closeWrap')).filter(node =>
    node.closest(dom.selector('Drawer')) === drawer && !node.closest(dom.selector('Comments')));
  if (candidates.length !== 1) return { state: 'structure_changed' };
  const close = candidates[0];
  if (!['DIV', 'BUTTON'].includes(close.tagName) || close.closest('a') || dom.all(close, 'a, button').length ||
      close.disabled || close.getAttribute('aria-disabled') === 'true' || close.getAttribute('data-disabled') === 'true' || visibility(close)) {
    return { state: 'structure_changed' };
  }
  const rect = close.getBoundingClientRect(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return { state: 'structure_changed' };
  const surface = document.elementsFromPoint(x, y)[0];
  if (!surface || !close.contains(surface)) return { state: 'blocked_unknown' };
  const gate = dom.gate(drawer);
  if (gate) return { state: gate };
  close.click();
  return { state: 'action_dispatched', clicked: true };
}

/** @param {unknown} raw @returns {{state: 'open'|'closed'}} Actual collection state, without review/media extraction. @throws {ShoppingError} Gate, identity, structure or invalid-response errors. @example validateReviewPanelState({ state: 'panel_visible' }); */
export function validateReviewPanelState(raw) {
  throwPageError(raw?.state);
  if (raw?.state === 'panel_visible') return { state: 'open' };
  if (raw?.state === 'panel_action_required') return { state: 'closed' };
  throw new ShoppingError('INVALID_RESPONSE', 'The review panel state is invalid.');
}

/**
 * Produce one guarded normal close; no scrolling, review/media extraction or retry.
 * @param {object} target Exact public product target. Caller must establish ownership or explicit recovery authority and reserve its intent.
 * @returns {string} Page-local script; an already closed panel produces clicked:false.
 * @throws {ShoppingError} INVALID_TARGET before IO.
 * @example reviewPanelCloseScript(target);
 */
export function reviewPanelCloseScript(target) {
  const expected = parseProductUrl(target?.url);
  if (!expected) throw new ShoppingError('INVALID_TARGET', 'A public product target is required.');
  return `(() => { try { return (${closePanel.toString()})(${JSON.stringify(expected)}, (${pageDom.toString()})(), ${reviewPanelVisibility.toString()}, ${inspectPanel.toString()}); }
    catch { return { state: 'structure_changed' }; } })()`;
}
