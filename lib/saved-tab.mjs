import { ShoppingError } from './errors.mjs';
import { parseTabId } from './targets.mjs';

/**
 * Current address of a tab a task saved by ID. The extension lists only its current window, so when the user has
 * switched windows the saved tab is read directly by ID instead of being treated as gone. Bridges without
 * `readTabAddress` (test doubles) see only listed tabs, as before.
 * @param {{listTabs: Function, readTabAddress?: Function}} bridge @param {number} tabId Saved tab ID.
 * @param {string} [missingMessage] Message for an unreachable tab.
 * @returns {Promise<string>} The tab's current URL; callers still check it against their target.
 * @throws {ShoppingError} TARGET_MISSING when the tab is neither listed nor reachable by ID.
 * @example const url = await savedTabUrl(bridge, op.tab_id);
 */
export async function savedTabUrl(bridge, tabId, missingMessage = 'The saved tab is neither in the current window nor reachable by its ID.') {
  const id = parseTabId(tabId);
  const listed = (await bridge.listTabs()).find(tab => tab.id === id);
  if (listed) return listed.url;
  const url = typeof bridge.readTabAddress === 'function' ? await bridge.readTabAddress(id) : null;
  if (url === null) throw new ShoppingError('TARGET_MISSING', missingMessage, 'Diagnose the original target and connection before resuming.');
  return url;
}
