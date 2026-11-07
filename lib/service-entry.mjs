import { ShoppingError } from './errors.mjs';
import { parseProductUrl } from './targets.mjs';
import { pageDom } from './page-dom.mjs';

function inspectEntry(expected, labels, activate, dom) {
  const current = new URL(location.href);
  if (current.origin !== expected.origin || current.pathname !== expected.pathname ||
      current.searchParams.getAll('id').length !== 1 || current.searchParams.get('id') !== expected.product_id) {
    return { state: 'target_changed' };
  }
  const gate = dom.gate();
  if (gate) return { state: gate };
  const roots = dom.all(document, dom.selector('GuaranteeInfo'));
  if (roots.length !== 1) return { state: roots.length ? 'structure_changed' : 'unsupported' };
  const triggers = dom.all(roots[0], dom.selector('triggerWrap')).filter(node => node.matches(dom.selector('hasMore')));
  if (triggers.length !== 1) return { state: triggers.length ? 'structure_changed' : 'unsupported' };
  const trigger = triggers[0];
  // Only the observed inline service trigger is allowed; a link can navigate away or commit another action.
  if (!['DIV', 'BUTTON'].includes(trigger.tagName) || trigger.closest('a') ||
      trigger.getAttribute('role') === 'link' || trigger.disabled === true ||
      trigger.getAttribute('aria-disabled') === 'true' || trigger.getAttribute('data-disabled') === 'true') {
    return { state: 'unsupported' };
  }
  const nodes = dom.all(trigger, dom.selector('guaranteeText'));
  if (nodes.length !== labels.length || nodes.some((node, index) => dom.text(node, 201) !== labels[index])) {
    return { state: 'structure_changed' };
  }
  if (!activate) return { state: 'entry_observed', product_id: expected.product_id, url: expected.url, labels };
  const expanded = dom.all(roots[0], dom.selector('isExpend'));
  const panels = dom.all(document, dom.selector('moreGuaranteeListWrap'));
  if (expanded.length > 1 || panels.length > 1 || (panels.length && !expanded.length)) return { state: 'structure_changed' };
  // The user may have opened it after the observation; another click would close the panel.
  if (expanded.length) return { state: 'action_dispatched', clicked: false };
  trigger.click();
  return { state: 'action_dispatched', clicked: true };
}

/**
 * Inspect or activate the observed inline service entry using exact labels from a prior detail read.
 * The caller must persist a single action intent and verify its outcome; this script never retries.
 * It does not collect service terms or confirm that a panel opened.
 * @param {{url: string}} target Bound public product.
 * @param {string[]} labels Ordered, nonempty service labels observed in its GuaranteeInfo region.
 * @param {boolean} [activate=false] Dispatch one click when all guards still match.
 * @returns {string} Fixed, identity- and gate-checked page script.
 * @throws {ShoppingError} INVALID_TARGET or INVALID_SERVICE_ENTRY before any browser command.
 * @example serviceEntryScript(target, ['7天无理由退换'], false);
 */
export function serviceEntryScript(target, labels, activate = false) {
  const expected = parseProductUrl(target?.url);
  if (!expected) throw new ShoppingError('INVALID_TARGET', 'A public product target is required for service entry inspection.');
  if (typeof activate !== 'boolean' || !Array.isArray(labels) || labels.length < 1 || labels.length > 20 ||
      labels.some(label => typeof label !== 'string' || label !== label.trim() || !label || label.length > 200 || /[\u0000-\u001f\u007f]/.test(label)) ||
      new Set(labels).size !== labels.length) {
    throw new ShoppingError('INVALID_SERVICE_ENTRY', 'Use 1–20 distinct exact service labels from the saved product detail region.');
  }
  return `(${inspectEntry.toString()})(${JSON.stringify(expected)}, ${JSON.stringify(labels)}, ${activate}, (${pageDom.toString()})())`;
}
