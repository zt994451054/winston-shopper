const ASSISTANCE_CODES = new Set(['LOGIN_REQUIRED', 'VERIFICATION_REQUIRED', 'RATE_LIMITED', 'SEARCH_RESULTS_UNAVAILABLE', 'PAGE_NOT_VISIBLE']);

/** @param {string} code Fixed failure code. @returns {boolean} Whether the blocked page may need human assistance. */
export function needsPageAssistance(code) {
  return ASSISTANCE_CODES.has(code);
}

/** Create one bounded display attempt per explicit tab for this execution; never discover or select a replacement page.
 * @param {{showTab?: Function}} bridge Connected bridge. @returns {(tabId: number) => Promise<boolean>} Best-effort display.
 * Display errors are contained and never replace the original failure or trigger another connection.
 */
export function createBlockedPageDisplay(bridge) {
  const attempted = new Set();
  return async tabId => {
    if (!Number.isSafeInteger(tabId) || tabId < 1 || attempted.has(tabId) || typeof bridge.showTab !== 'function') return false;
    attempted.add(tabId);
    try { return await bridge.showTab(tabId) === true; }
    catch { return false; }
  };
}

/** Display the exact blocked page only after its task pause has been committed.
 * @param {{task: object, op: object, error: object, showPage: Function}} context Already persisted pause and original failure.
 * @returns {Promise<boolean>} Whether the display succeeded; no checkpoint, budget or error is changed.
 */
export async function displayPausedPage({ task, op, error, showPage }) {
  if (!['waiting_user', 'waiting_cooldown', 'stopped'].includes(task.status) || !needsPageAssistance(error.code)) return false;
  // A gate on a new order tab must not bring its source list forward; null means the new page was ambiguous.
  const tabId = Object.hasOwn(error, 'blockedTabId') ? error.blockedTabId
    : op.order_detail_check?.detail_tab_id ?? op.order_detail_read?.detail_tab_id ?? op.tab_id;
  try { return await showPage(tabId) === true; }
  catch { return false; }
}
