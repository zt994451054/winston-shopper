import { ShoppingError } from './errors.mjs';

/**
 * Page-local helpers, serialized with fixed collectors; never reads storage or sends requests.
 * @returns {object} Visible DOM helpers. gate(null, {readOnly:true}) permits unrelated dialogs for DOM reads; explicit login, verification and rate gates still stop.
 */
export function pageDom() {
  const selector = prefix => `[class^="${prefix}--"], [class*=" ${prefix}--"]`;
  const visible = element => {
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  };
  const all = (root, query) => [...root.querySelectorAll(query)].filter(visible);
  const one = (root, prefix) => all(root, selector(prefix))[0];
  const text = (node, max) => (node?.innerText ?? '').trim().slice(0, max);
  const gate = (allowedDrawer = null, { readOnly = false } = {}) => {
    const frames = all(document, 'iframe').map(frame => {
      try { const url = new URL(frame.getAttribute('src'), location.href); return `${url.hostname}${url.pathname}`; }
      catch { return ''; }
    });
    const verification = all(document, '#nc_1_wrapper, #baxia-dialog-content, #baxia-dialog, [id^="aliyunCaptcha"], [id^="nc_1_n1z"]');
    const dialogs = all(document, '[role="dialog"], [aria-modal="true"], [class*="loginDialog"], [class*="login-dialog"]');
    const dialogText = dialogs.map(node => text(node, 1500)).join('\n');
    if (verification.length || frames.some(url => /captcha|punish|baxia/.test(url)) || /滑块|验证码|安全验证|drag the slider/i.test(dialogText)) return 'verification_required';
    if (/访问.{0,4}频繁|请求.{0,4}频繁|稍后再试|too many requests/i.test(dialogText + document.title.slice(0, 300))) return 'rate_limited';
    if (frames.some(url => /^(login\.taobao\.com|login\.tmall\.com)\//.test(url)) || /扫码登录|密码登录|请.{0,4}登录/.test(dialogText) ||
        readOnly && dialogs.some(node => /loginDialog|login-dialog/.test(node.getAttribute('class') ?? ''))) return 'login_required';
    if (!readOnly && dialogs.some(node => node !== allowedDrawer)) return 'blocked_unknown';
    return null;
  };
  return { selector, visible, all, one, text, gate };
}

/** @param {unknown} state @returns {void} @throws {ShoppingError} Known page gate or structure errors. */
export function throwPageError(state) {
  const errors = {
    target_changed: ['TARGET_CHANGED', 'The task page no longer matches its target.'],
    verification_required: ['VERIFICATION_REQUIRED', 'The page requires user verification.'],
    login_required: ['LOGIN_REQUIRED', 'The page requires user login.'],
    rate_limited: ['RATE_LIMITED', 'The page reports an access restriction.'],
    blocked_unknown: ['ACCESS_BLOCKED', 'An unrecognized dialog blocks the read.'],
    description_entry_unavailable: ['DESCRIPTION_ENTRY_UNAVAILABLE', 'The bound description entry is disabled, hidden, offscreen or obstructed.'],
    loading: ['PAGE_LOADING', 'The document is still loading.'],
    structure_changed: ['PAGE_STRUCTURE_CHANGED', 'The supported page regions could not be identified.'],
    review_drawer_not_visible: ['REVIEW_DRAWER_NOT_VISIBLE', 'The mounted review content is outside the viewport or hidden.',
      'Preserve the task and its budget. Inspect the current panel without replaying prior actions or creating a replacement task.'],
    review_panel_required: ['REVIEW_PANEL_REQUIRED', 'Text category sampling requires an already visible review panel.', 'Preserve the task; open the original review panel before any explicitly authorized recovery.'],
    review_categories_ambiguous: ['REVIEW_CATEGORIES_AMBIGUOUS', 'The review category labels or selection markers could not be uniquely identified.'],
    review_category_unavailable: ['REVIEW_CATEGORY_UNAVAILABLE', 'The requested review category is missing, disabled or outside the viewport.'],
    search_pagination_missing: ['SEARCH_PAGINATION_MISSING', 'The search page does not have one or two supported visible pagination regions.'],
    search_page_display_missing: ['SEARCH_PAGE_DISPLAY_MISSING', 'The expected visible current-page/total-page display was not found.'],
    search_sort_state_mismatch: ['SEARCH_SORT_STATE_MISMATCH', 'The search sort region does not uniquely report the supported default selection.'],
    search_page_controls_mismatch: ['SEARCH_PAGE_CONTROLS_MISMATCH', 'The visible previous/next page controls do not match the supported layout.'],
    search_results_unavailable: ['SEARCH_RESULTS_UNAVAILABLE', 'The search results area shows only a load-failure message; the platform may be limiting requests.',
      'Pause this platform. Only after the user later asks to resume, run task-resume --after-cooldown once.'],
    unsupported: ['UNSUPPORTED_CAPABILITY', 'This page has no supported entry for the requested operation.'],
  };
  if (Object.hasOwn(errors, state)) throw new ShoppingError(...errors[state]);
}

/** @param {unknown} value @param {number} max @returns {string} Bounded, control-free text. @throws {ShoppingError} INVALID_RESPONSE. */
export function responseText(value, max) {
  if (typeof value !== 'string' || value.length > max) throw new ShoppingError('INVALID_RESPONSE', 'The page returned an invalid text field.');
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
}
