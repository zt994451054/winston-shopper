import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { ShoppingError } from './errors.mjs';
import { EXTENSION_PROTOCOL, EXTENSION_INVENTORY_SCOPE, isExtensionProtocol, validateBridgeStatus, requireReadyBridge } from './bridge-protocol.mjs';
import { metadataScript, productTargetScript, parseTabId, validateMetadata } from './targets.mjs';
import { parseProductUrl } from './targets.mjs';
import { cartTargetScript, validateCartTarget, parseCartUrl } from './cart-target.mjs';
import { cartRowsScript, validateCartRows, cartBatchScript, validateCartBatch } from './cart-rows.mjs';
import { CART_AVAILABILITY_RULES } from './cart-availability.mjs';
import { orderListTargetScript, validateOrderListTarget, orderDetailTargetScript, validateOrderDetailTarget, parseOrderListUrl } from './order-target.mjs';
import { orderRowsScript, validateOrderRows, orderBatchScript, validateOrderBatch } from './order-rows.mjs';
import { orderDetailPageScript, validateOrderDetailPage } from './order-detail-page.mjs';
import { orderDetailBodyScript, validateOrderDetailBody } from './order-detail-body.mjs';
import { orderDetailEntryScript, validateOrderDetailEntry, orderDetailEntryReference } from './order-detail-entry.mjs';
import { productScript, selectionScript, validateProduct, validateSelectionAcknowledgement } from './product.mjs';
import { searchScript, parseSearchUrl, isSearchHome, validateSearch } from './search.mjs';
import { reviewsScript, validateReviews } from './reviews.mjs';
import { reviewCategoriesScript, validateReviewCategoryObservation } from './review-categories.mjs';
import { reviewPanelScript, reviewPanelCloseScript, validateReviewPanelState } from './review-panel.mjs';
import { validateReadActionAcknowledgement } from './read-action.mjs';
import { detailsScript, validateDetails } from './details.mjs';
import { descriptionExpansionScript, validateDescriptionObservation } from './description-entry.mjs';
import { descriptionImageLoadingScript, validateDescriptionImageObservation, validateDescriptionImageScroll } from './description-image-loading.mjs';
import { parseSearchPageUrl } from './search.mjs';
import { searchPagesScript, validateSearchPage } from './search-pages.mjs';
import { SEARCH_RANGE_CARD_LIMIT, parseSearchRangeUrl, searchCollectionScript, validateSearchCollectionPage } from './search-page-range.mjs';
import { searchSortScript, searchSortTargetScript, searchSortDiagnosticScript, validateSearchSort, matchesSearchSort } from './search-sort.mjs';
import { parseSortableSearchUrl, searchPageTarget } from './search.mjs';
import { searchPriceScript, validateSearchPriceObservation, pickPriceDirectionScript, confirmPriceRangeScript, priceTabSelectorScript,
  validatePriceTabSelector, validatePriceReference, validatePriceClickAcknowledgement, PRICE_BOUND_PLACEHOLDERS,
  priceControlsScript, validatePriceControlsReply, nextPricePageScript, validateNextPriceAcknowledgement, matchesPriceView,
  pickSourceScript, pickFilterScript } from './search-price.mjs';
import { throwPageError } from './page-dom.mjs';
import { searchControlsScript, validateSearchControls } from './search-controls.mjs';
import { priceEntryScript, validatePriceEntry } from './price-entry.mjs';
import { validateHoverPreparation, validatePriceHoverReference } from './price-hover.mjs';
import { priceRegionScript } from './price-region.mjs';
import { serviceEntryScript } from './service-entry.mjs';
import { mainImageScript, validateMainImageObservation } from './main-images.mjs';
import { galleryScript, validateGallery } from './gallery.mjs';
import { specificationImagesScript, specificationImageBatchScript, specificationImageContinuation, validateSpecificationImages } from './specification-images.mjs';
import { specificationCollectionScript, validateSpecificationCollectionObservation } from './specification-images.mjs';
import { savedTabUrl } from './saved-tab.mjs';
import { jdCartScript, validateJdCart } from './jd/cart.mjs';
import { jdOrdersScript, validateJdOrders } from './jd/orders.mjs';
import { jdOrderDetailClickScript, validateJdOrderDetailClick } from './jd/order-entry.mjs';
import { jdOrderDetailScript, validateJdOrderDetail } from './jd/order-detail.mjs';
import { jdSearchScript, validateJdSearch } from './jd/search.mjs';
import { jdNextPageScript, jdSearchPageScript, validateJdNextPage, validateJdSearchPage } from './jd/search-pages.mjs';
import { jdPriceRangeConfirmScript, jdPriceRangeHoverScript, jdPriceRangePanelScript, jdSortClickScript, jdSortedSearchScript, requirePriceRange,
  validateJdPriceRangeConfirm, validateJdPriceRangeHover, validateJdPriceRangePanel, validateJdSortClick, validateJdSortedSearch } from './jd/search-sort.mjs';
import { jdDetailScrollScript, jdProductScript, validateJdDetailScroll, validateJdProductObservation } from './jd/product.mjs';
import { jdReviewCloseScript, jdReviewOpenScript, jdReviewReadScript, jdReviewSelectScript, validateJdReviewClose, validateJdReviewObservation, validateJdReviewOpen, validateJdReviewSelect } from './jd/review-categories.mjs';
import { pddSearchScript, validatePddSearch } from './pdd/search.mjs';
import { pddSearchCardClickScript, validatePddSearchCardClick } from './pdd/product-entry.mjs';
import { pddProductScript, validatePddProduct } from './pdd/product.mjs';
import { pddOrdersScript, validatePddOrders } from './pdd/orders.mjs';
import { pddOrderCardClickScript, pddOrderDetailScript, pddOrderExpandScript, validatePddOrderClick, validatePddOrderDetail } from './pdd/order-detail.mjs';
import { pddSpecClickScript, pddSpecStateScript, validatePddSpecClick, validatePddSpecState } from './pdd/spec-prices.mjs';
import { pddReviewsLinkClickScript, pddReviewsScript, validatePddReviews, validatePddReviewsLinkClick } from './pdd/reviews.mjs';
import { RANGE_INPUTS as PDD_RANGE_INPUTS, pddRangeConfirmScript, pddSortClickScript, pddSortStateScript, requirePddPriceRange, validatePddSortClick,
  validatePddSortState } from './pdd/search-sort.mjs';
import { parsePddOrderDetailUrl, parsePddOrderListUrl, parsePddProductUrl, parsePddReviewsUrl, parsePddSearchUrl, pddLandingKind, pddMetadataScript, pddSearchTarget, validatePddMetadata } from './pdd/targets.mjs';
import { jdLandingKind, jdMetadataScript, jdSearchTarget, parseJdCartUrl, parseJdOrderDetailUrl, parseJdOrderListUrl, parseJdProductUrl, parseJdSearchUrl, validateJdMetadata } from './jd/targets.mjs';
import { orderPageScript, validateOrderPage } from './order-page-view.mjs';
import { requireOrderTab } from './order-read.mjs';

const MAX_RESPONSE_BYTES = 262144;
// The pinned extension's pointer move returned only after about 5 s in live use (2026-10-12), exceeding the default deadline.
const POINTER_TIMEOUT_MS = 15000;
const TAB_OPEN_TIMEOUT_MS = 30000;
// Reads only the address of an explicitly saved tab; nothing from the page content leaves it.
const TAB_ADDRESS_SCRIPT = '(() => ({ state: "tab_address", url: location.href }))()';

const READ = ['read'], ACTION = ['action'], SEARCH_LOAD = ['load', 'search'], PAGE_LOAD = ['load', 'page'];
/**
 * Pacing class of every public page method. Loads make the platform fetch data and count towards a quota;
 * reads and other actions only receive spacing. Metadata calls (status, tab inventory) are not paced.
 */
export const PACED_METHODS = Object.freeze({
  readCartTarget: READ, readCartRows: READ, readOrderListTarget: READ, readOrderDetailTarget: READ, readOrderDetailPageState: READ,
  readOrderDetailBody: READ, inspectOrderDetailEntry: READ, readOrderRows: READ, readOrderBatch: READ, readOrderPage: READ, readCartBatch: READ,
  readMetadata: READ, readProduct: READ, readSpecificationCollection: READ, readSpecificationImages: READ, readGallery: READ,
  readDetails: READ, readDescriptionExpansion: READ, readDescriptionImageLoading: READ, readMainImage: READ, probeProductTarget: READ,
  readSearchPage: READ, readSearchCollectionPage: READ, probeSortTarget: READ, readSearchSort: READ, readSearchPrice: READ,
  readSearchControls: READ, readPriceEntry: READ, inspectPriceRegion: READ, inspectPriceEntry: READ, inspectPriceHoverPreparation: READ,
  inspectSearchSort: READ, readSearch: READ, readReviews: READ, readReviewCategories: READ, readReviewPanelState: READ,
  expandDescription: ACTION, scrollDescriptionImage: ACTION, selectMainImage: ACTION, hoverPriceTab: ACTION, fillPriceRange: ACTION, nextPricePage: SEARCH_LOAD, pickSearchSource: SEARCH_LOAD, pickSearchFilter: SEARCH_LOAD,
  hoverPriceEntry: ACTION, openPriceEntry: ACTION, selectOption: ACTION, expandServices: ACTION, openReviewPanel: ACTION,
  closeReviewPanel: ACTION, selectReviewCategory: ACTION, expandReviews: ACTION,
  navigateSearch: SEARCH_LOAD, nextSearchPage: SEARCH_LOAD, nextSearchCollectionPage: SEARCH_LOAD, selectSalesSort: SEARCH_LOAD,
  pickPriceDirection: SEARCH_LOAD, confirmPriceRange: SEARCH_LOAD, openSearchPage: SEARCH_LOAD,
  openOrderDetailEntry: PAGE_LOAD, openProductPage: PAGE_LOAD, openOrderListPage: PAGE_LOAD, openCartPage: PAGE_LOAD, nextOrderPage: PAGE_LOAD,
  openJdSearchPage: SEARCH_LOAD, openJdProductPage: PAGE_LOAD, openJdOrderListPage: PAGE_LOAD, openJdCartPage: PAGE_LOAD, readJdSearch: READ,
  readJdSearchPage: READ, clickJdNextPage: SEARCH_LOAD, readJdSortedSearch: READ, clickJdSortTag: SEARCH_LOAD,
  readJdPriceRangePanel: READ, hoverJdPriceRange: ACTION, fillJdPriceRange: ACTION, confirmJdPriceRange: SEARCH_LOAD,
  readJdCart: READ, readJdOrders: READ, clickJdOrderDetail: PAGE_LOAD, readJdOrderDetail: READ, readJdProduct: READ, scrollJdDetails: ACTION, readJdReviewCategories: READ, openJdReviewPanel: ACTION, selectJdReviewCategory: ACTION,
  closeJdReviewPanel: ACTION,
  openPddSearchPage: SEARCH_LOAD, openPddOrderListPage: PAGE_LOAD, readPddSearch: READ,
  clickPddSearchCard: PAGE_LOAD, readPddProduct: READ, clickPddReviewsLink: PAGE_LOAD, readPddReviews: READ,
  readPddOrders: READ, clickPddOrderCard: PAGE_LOAD, expandPddOrderInfo: ACTION, readPddOrderDetail: READ,
  clickPddSort: SEARCH_LOAD, readPddSortState: READ, openPddFilter: ACTION, fillPddPriceRange: ACTION, confirmPddPriceRange: SEARCH_LOAD,
  readPddSpecState: READ, clickPddSpec: ACTION,
});

const jdLanding = (url, matched) => matched ? 'requested' : jdLandingKind(url);
const pddLanding = (url, matched) => matched ? 'requested' : pddLandingKind(url);

/**
 * Accept only explicit loopback HTTP endpoints, without credentials or extra paths.
 * @param {string} value
 * @returns {string} A normalized origin.
 * @throws {ShoppingError} INVALID_ENDPOINT.
 * @example normalizeEndpoint('http://127.0.0.1:19825')
 */
export function normalizeEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { /* Report a fixed message, never the input. */ }
  if (!url || url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new ShoppingError('INVALID_ENDPOINT', 'Use a loopback HTTP origin without credentials, path, query, or fragment.', 'Example: --endpoint http://127.0.0.1:19825');
  }
  return url.origin;
}

async function readJson(response, maximumBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.byteLength;
    if (size > maximumBytes) {
      response.destroy();
      throw new ShoppingError('RESPONSE_TOO_LARGE', 'The bridge response exceeded the diagnostic size limit.');
    }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ShoppingError('INVALID_RESPONSE', 'The bridge did not return valid JSON.'); }
}

/** A bounded adapter exposing only fixed public reads and guarded reading actions. */
export class BrowserBridge {
  #pacer = null;
  /**
   * @param {string} endpoint A loopback HTTP origin.
   * @param {{timeoutMs?: number}} options A per-request deadline.
   * @throws {ShoppingError} INVALID_ENDPOINT, INVALID_TIMEOUT or INVALID_TRANSPORT for a retired transport option.
   */
  constructor(endpoint, { timeoutMs = 5000, transport } = {}) {
    this.endpoint = normalizeEndpoint(endpoint);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 20 || timeoutMs > 30000) {
      throw new ShoppingError('INVALID_TIMEOUT', 'Request timeout must be an integer from 20 to 30000 milliseconds.');
    }
    this.timeoutMs = timeoutMs;
    if (transport !== undefined) throw new ShoppingError('INVALID_TRANSPORT', 'Only the Playwright extension HTTP channel is supported.');
    this.protocol = EXTENSION_PROTOCOL;
    this.inventoryScope = EXTENSION_INVENTORY_SCOPE;
  }

  /**
   * Route every classified page method through a persistent pacer (see lib/pacing.mjs). Call once per bridge.
   * @param {{before: Function, after: Function}} pacer @returns {BrowserBridge} This bridge.
   * @throws {ShoppingError} INVALID_ARGUMENTS when a pacer is already attached.
   */
  usePacer(pacer) {
    if (this.#pacer) throw new ShoppingError('INVALID_ARGUMENTS', 'This bridge already has a pacer.');
    this.#pacer = pacer;
    for (const [name, [kind, category]] of Object.entries(PACED_METHODS)) {
      const original = this[name].bind(this);
      this[name] = async (...args) => {
        await pacer.before(kind, category);
        let dispatched = true;
        try { return await original(...args); }
        catch (error) { dispatched = !error.actionNotDispatched; throw error; }
        finally { await pacer.after(kind, { dispatched }); }
      };
    }
    return this;
  }

  async #request(path, payload, maximumBytes = MAX_RESPONSE_BYTES, timeoutMs = this.timeoutMs) {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      return await new Promise((resolve, reject) => {
        const body = payload ? JSON.stringify(payload) : undefined;
        // A dedicated direct connection keeps loopback commands out of environment proxies.
        const request = http.request(`${this.endpoint}${path}`, {
          method: payload ? 'POST' : 'GET', agent: false, signal,
          ...(payload ? { headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } } : {}),
        }, async response => {
          try {
            const status = response.statusCode;
            if (status < 200 || status >= 300) {
              response.destroy();
              const code = status >= 300 && status < 400 ? 'BRIDGE_REDIRECT' : 'BRIDGE_HTTP_ERROR';
              throw new ShoppingError(code, `The configured bridge returned HTTP ${status}.`, 'Check the bridge endpoint; no redirect or retry was performed.');
            }
            resolve(await readJson(response, maximumBytes));
          } catch (error) { reject(error); }
        });
        request.once('error', reject);
        request.end(body);
      });
    } catch (error) {
      if (error instanceof ShoppingError) throw error;
      if (signal.aborted) {
        throw new ShoppingError('BRIDGE_TIMEOUT', 'The bridge request exceeded its deadline.', 'Check the connection, then rerun explicitly. No automatic retry was performed.');
      }
      throw new ShoppingError('BRIDGE_UNAVAILABLE', 'The configured browser bridge is not reachable.', 'Run setup, start the bridge, and check the configured endpoint.');
    }
  }

  /** @returns {Promise<object>} Runtime connection status for the selected transport. @throws {ShoppingError} Connection or protocol errors. */
  async status() {
    return validateBridgeStatus(await this.#request('/status'));
  }

  /** @returns {Promise<object>} Already connected status. @throws {ShoppingError} Service readiness or connection errors. */
  async requireConnected() {
    return requireReadyBridge(await this.status());
  }

  async #command(action, fields = {}, maximumBytes = MAX_RESPONSE_BYTES, timeoutMs = this.timeoutMs) {
    const id = randomUUID();
    const response = await this.#request('/command', { id, action, ...fields }, maximumBytes, timeoutMs);
    if (response?.id !== id || typeof response.success !== 'boolean') {
      throw new ShoppingError('INVALID_RESPONSE', 'The bridge response does not match the submitted command.');
    }
    if (!response.success) {
      throw new ShoppingError('BROWSER_COMMAND_FAILED', 'The browser could not complete the fixed command.', 'Check task status and connection. External error text was withheld.');
    }
    return response.data;
  }

  /**
   * List tab IDs and URLs in this transport's declared scope; callers must redact output.
   * @returns {Promise<Array<{id: number, url: string}>>}
   * @throws {ShoppingError} Connection or invalid response errors; never retries.
   */
  /**
   * Read one tab's current address by ID, for a saved tab outside the extension's current window. Not paced: it reads
   * the local address only and sends nothing to the platform.
   * @param {number} tabId @returns {Promise<string|null>} null when the tab cannot be reached or this backend cannot read other windows.
   * @throws {ShoppingError} Connection or transport failures other than an unreachable tab.
   */
  async readTabAddress(tabId) {
    if (!isExtensionProtocol(this.protocol)) return null;
    let data;
    try { data = await this.#command('eval', { tabId: parseTabId(tabId), script: TAB_ADDRESS_SCRIPT }); }
    catch (error) { if (error.code === 'BROWSER_COMMAND_FAILED') return null; throw error; }
    const url = data?.result?.url;
    return data?.result?.state === 'tab_address' && typeof url === 'string' && url.length <= 16384 ? url : null;
  }

  /**
   * Show one explicitly blocked page for user assistance, or to recover a read that requires visibility.
   * Callers save human pauses first; ordinary page commands never request this action (user 2026-11-04).
   * @param {number} tabId @returns {Promise<boolean>} Whether the page reports itself visible afterwards.
   * @throws {ShoppingError} Service readiness, unsupported command or missing tab errors; callers preserve their original pause.
   * @example await bridge.showTab(88);
   */
  async showTab(tabId) {
    await this.requireConnected();
    const data = await this.#command('tab_show', { tabId: parseTabId(tabId) });
    return data?.visible === true;
  }

  async listTabs() {
    const data = await this.#command('tab_list');
    const tabs = Array.isArray(data) ? data : data?.tabs;
    if (!Array.isArray(tabs) || tabs.length > 1000) {
      throw new ShoppingError('INVALID_RESPONSE', 'The bridge returned an invalid tab inventory.');
    }
    const ids = new Set();
    return tabs.map(tab => {
      let id;
      try { id = parseTabId(tab?.id ?? tab?.tabId); } catch { /* Normalize untrusted protocol errors. */ }
      if (!id || ids.has(id) || typeof tab.url !== 'string' || tab.url.length > 16384) {
        throw new ShoppingError('INVALID_RESPONSE', 'The bridge returned an invalid or duplicate tab entry.');
      }
      ids.add(id);
      return { id, url: tab.url };
    });
  }

  /**
   * Check one saved cart tab's address without reading rows or changing browser selection.
   * Callers refresh tabs and reserve this read in the original task before dispatch.
   * @param {number} tabId The explicitly selected cart tab.
   * @param {{url:string}} target The observed canonical cart identity.
   * @returns {Promise<{url:string,page_state:string}>} Address evidence only.
   * @throws {ShoppingError} Target, connection, command or response errors; never retries.
   * @example await bridge.readCartTarget(41, {url:'https://cart.taobao.com/cart.htm'});
   */
  async readCartTarget(tabId, target) {
    const script = cartTargetScript(target);
    const id = parseTabId(tabId);
    await this.requireConnected();
    const data = await this.#command('eval', { tabId: id, script });
    return validateCartTarget(data?.result, target);
  }

  /**
   * Read at most five loaded cart rows on an explicit tab; never changes cart state.
   * @param {number} tabId Selected cart tab after a fresh inventory.
   * @param {{url:string}} target Canonical Taobao cart identity.
   * @returns {Promise<object>} Local-only partial snapshot with unclassified price text and per-row availability (schema 4).
   * @throws {ShoppingError} Target, connection, page-state or response errors; no retries.
   * @example await bridge.readCartRows(41, {url:'https://cart.taobao.com/cart.htm'});
   */
  async readCartRows(tabId, target) {
    const script = cartRowsScript(target, { availability: true });
    const id = parseTabId(tabId);
    await this.requireConnected();
    const data = await this.#command('eval', { tabId: id, script });
    return validateCartRows(data?.result, target, { availability: true });
  }

  /**
   * @param {number} tabId Explicit buyer order-list tab. @param {{url:string}} target Canonical list route.
   * @returns {Promise<object>} Address-only observation, without order/account fields or actions.
   * @throws {ShoppingError} Invalid target/tab before IO, connection failures or address/gate errors. No retries.
   * @example await bridge.readOrderListTarget(41, target);
   */
  async readOrderListTarget(tabId, target) {
    const script = orderListTargetScript(target);
    const id = parseTabId(tabId);
    await this.requireConnected();
    const data = await this.#command('eval', { tabId: id, script });
    return validateOrderListTarget(data?.result, target);
  }

  /**
   * @param {number} tabId Explicit detail tab after a fresh inventory. @param {{url:string,order_id:string}} target Saved detail link.
   * @returns {Promise<object>} Address-only evidence; no printed ID, contact fields or account profile.
   * @throws {ShoppingError} Invalid arguments before IO, connection or address/gate errors. No internal retries.
   * @example await bridge.readOrderDetailTarget(41, target);
   */
  async readOrderDetailTarget(tabId, target) {
    const script = orderDetailTargetScript(target), id = parseTabId(tabId);
    await this.requireConnected();
    const data = await this.#command('eval', { tabId: id, script });
    return validateOrderDetailTarget(data?.result, target);
  }

  /**
   * @param {number} tabId Explicit saved detail tab. @param {{url:string,order_id:string}} target Canonical detail link.
   * @returns {Promise<object>} Limited error-panel observation; absence of an error does not verify normal order details.
   * @throws {ShoppingError} Invalid arguments before IO, connection, page gate, structure or response errors. No retries.
   * @example await bridge.readOrderDetailPageState(41, target);
   */
  async readOrderDetailPageState(tabId, target) {
    const script = orderDetailPageScript(target), id = parseTabId(tabId);
    await this.requireConnected();
    const data = await this.#command('eval', { tabId:id, script });
    return validateOrderDetailPage(data?.result, target);
  }

  /**
   * @param {number} tabId Explicit saved detail tab after a fresh inventory.
   * @param {{url:string,order_id:string}} target Canonical detail identity.
   * @returns {Promise<object>} Bounded normal body after a matching printed-ID guard; local only, no settlement proof.
   * @throws {ShoppingError} Invalid arguments before IO, connection, page gate, identity or structure errors. No retries.
   * @example await bridge.readOrderDetailBody(41, target);
   */
  async readOrderDetailBody(tabId, target) {
    const script = orderDetailBodyScript(target), id = parseTabId(tabId);
    await this.requireConnected();
    const data = await this.#command('eval', {tabId:id,script}, 1048576);
    return validateOrderDetailBody(data?.result, target);
  }

  /**
   * @param {number} tabId Explicit list tab. @param {object} list Saved list route. @param {object} detail Saved detail identity.
   * @param {number} position Single saved list position.
   * @returns {Promise<object>} Read-only preparation of the current header link; no navigation.
   * @throws {ShoppingError} Invalid arguments before IO or connection, gate, identity, interaction or response failure. No retries.
   * @example await bridge.inspectOrderDetailEntry(41, list, detail, 2);
   */
  async inspectOrderDetailEntry(tabId, list, detail, position) {
    const script = orderDetailEntryScript(list, detail, position), id = parseTabId(tabId);
    await this.requireConnected();
    const data = await this.#command('eval', { tabId:id, script });
    return validateOrderDetailEntry(data?.result, list, detail, position);
  }

  /**
   * Use the declared backend's mouse-click path for one fresh, scoped header-link reference.
   * The caller must reserve one action plus three preparation reads before IO, then observe the resulting tab separately.
   * @param {number} tabId Explicit saved list tab. @param {object} list Saved list route. @param {object} detail Saved detail identity.
   * @param {object} before Validated, previously observed entry preparation.
   * @returns {Promise<object>} Dispatch acknowledgement only; navigation remains unverified.
   * @throws {ShoppingError} Preparation failures are marked actionNotDispatched; uncertain click outcomes must never replay.
   * @example await bridge.openOrderDetailEntry(41, list, detail, before);
   */
  async openOrderDetailEntry(tabId, list, detail, before) {
    let ref;
    try {
      if (!isExtensionProtocol(this.protocol)) throw new ShoppingError('UNSUPPORTED_CAPABILITY', 'Order-entry mouse clicks require the declared extension backend.');
      validateOrderDetailEntry(before, list, detail, before?.position);
      const prepare = async () => {
        const current = await this.inspectOrderDetailEntry(tabId, list, detail, before.position);
        if (Object.keys(before).some(key => current[key] !== before[key])) throw new ShoppingError('TARGET_CHANGED', 'The observed order header entry changed during preparation.');
        return current.selector;
      };
      const selector = await prepare();
      const data = await this.#command('snapshot', { tabId, selector, interactive:true, compact:true, maxDepth:2 });
      ref = orderDetailEntryReference(data, before);
      await prepare();
    } catch (error) { error.actionNotDispatched = true; throw error; }
    const data = await this.#command('click', { tabId, ref });
    if (data?.role !== 'link' || data?.name !== '订单详情') throw new ShoppingError('INVALID_RESPONSE', 'The click acknowledgement did not identify the prepared order-detail link.');
    return { clicked:true, navigation_verified:false };
  }

  /**
   * @param {number} tabId Explicit buyer-list tab after a fresh inventory. @param {{url:string}} target Saved canonical route.
   * @returns {Promise<object>} At most five loaded orders with separate order/item price observations; local only.
   * @throws {ShoppingError} Invalid target/tab before IO, connection, gate, structure or response errors. No retries.
   * @example await bridge.readOrderRows(41, target);
   */
  async readOrderRows(tabId, target) {
    const script = orderRowsScript(target);
    const id = parseTabId(tabId);
    await this.requireConnected();
    const data = await this.#command('eval', { tabId: id, script }, 1048576);
    return validateOrderRows(data?.result, target);
  }

  /**
   * @param {number} tabId Explicit tab. @param {{url:string}} target Canonical route. @param {object} plan Reserved range and prefix guards.
   * @returns {Promise<object>} One validated batch; at most five new orders, no actions or internal retries.
   * @throws {ShoppingError} Invalid arguments before IO, target/connection gates, changed prefix or response failure.
   * @example await bridge.readOrderBatch(41, target, plan);
   */
  async readOrderBatch(tabId, target, plan) {
    const script = orderBatchScript(target, plan), id = parseTabId(tabId);
    await this.requireConnected();
    const data = await this.#command('eval', { tabId: id, script }, 1048576);
    return validateOrderBatch(data?.result, target, plan);
  }

  /**
   * @param {number} tabId Saved tab. @param {{url:string}} target Canonical route. @param {number[]} allowedPages Saved page allowance.
   * @returns {Promise<object>} Every loaded order of one list page (at most fifty) with the displayed pager and view; no actions or retries.
   * @throws {ShoppingError} Invalid arguments, address/connection gates, page gates, structure or response errors.
   * @example await bridge.readOrderPage(41, target, [2, 3]);
   */
  async readOrderPage(tabId, target, allowedPages) {
    const script = orderPageScript(target, { allowedPages }), id = parseTabId(tabId);
    await requireOrderTab(this, { tab_id: id, target });
    const data = await this.#command('eval', { tabId: id, script }, 4194304);
    return validateOrderPage(data?.result, target, allowedPages);
  }

  /**
   * @param {number} tabId Saved tab. @param {{url:string}} target Canonical route. @param {object} before Validated current page.
   * @returns {Promise<object>} One next-page acknowledgement guarded by the page's number, order IDs and view.
   * @throws {ShoppingError} Preparation and in-page guard failures are marked actionNotDispatched; unknown dispatch IO remains uncertain.
   * @example await bridge.nextOrderPage(41, target, savedPage);
   */
  async nextOrderPage(tabId, target, before) {
    let script, id;
    try {
      script = orderPageScript(target, { allowedPages: [before?.pager?.current_page], before });
      id = parseTabId(tabId);
      await requireOrderTab(this, { tab_id: id, target });
    } catch (error) { error.actionNotDispatched = true; throw error; }
    const data = await this.#command('eval', { tabId: id, script }, 4194304);
    return validateReadActionAcknowledgement(data?.result);
  }

  /**
   * @param {number} tabId Selected tab. @param {{url:string}} target Canonical cart identity. @param {object} plan Reserved range/guards.
   * @param {{availability?:boolean, availabilityRules?:1|2}} [options] false or rule 1 only to continue a collection started
   * without row availability or under the earlier classification rule.
   * @returns {Promise<object>} One validated partial batch; no retries or actions.
   * @throws {ShoppingError} Invalid plan before IO, target/connection/page errors or changed row guards.
   * @example await bridge.readCartBatch(41, target, plan);
   */
  async readCartBatch(tabId, target, plan, { availability = true, availabilityRules = CART_AVAILABILITY_RULES } = {}) {
    const options = { availability: availability === true, availabilityRules };
    const script = cartBatchScript(target, plan, options);
    const id = parseTabId(tabId);
    await this.requireConnected();
    const data = await this.#command('eval', { tabId: id, script });
    return validateCartBatch(data?.result, target, plan, options);
  }

  /**
   * Read only public metadata after checking identity inside the selected page.
   * @param {number} tabId @param {{url: string}} target
   * @returns {Promise<object>} Validated metadata; does not assert login or page readiness.
   * @throws {ShoppingError} Identity, connection, or response errors.
   */
  async readMetadata(tabId, target) {
    const [script, validate] = target?.platform === 'jd' ? [jdMetadataScript, validateJdMetadata]
      : target?.platform === 'pdd' ? [pddMetadataScript, validatePddMetadata] : [metadataScript, validateMetadata];
    const data = await this.#command('eval', { tabId: parseTabId(tabId), script: script(target) });
    return validate(data?.result, target);
  }

  /**
   * Recheck the connection and target, then read bounded, already-loaded product regions.
   * @param {number} tabId @param {{url: string}} target
   * @param {{layoutDiagnostics?:boolean}} options Enable same-read diagnostics for a new task.
   * @returns {Promise<object>} Validated partial public snapshot.
   * @throws {ShoppingError} Connection, identity, page-state, or parsing failure. Never retries.
   * @example await bridge.readProduct(41, target, { layoutDiagnostics: true });
   */
  async readProduct(tabId, target, options = {}) {
    const script = productScript(target, options);
    await this.#requireProductTarget(tabId, target);
    const data = await this.#command('eval', { tabId, script });
    return validateProduct(data?.result, target);
  }

  /**
   * @param {number} tabId @param {object} target Bound identity. @param {object} plan Reserved inventory guard and positions.
   * @returns {Promise<object>} All scanned labels and at most five images; a reserved loading plan may scroll one IMG and returns its pre-action source.
   * @throws {ShoppingError} Identity, page gate or schema errors; no internal retry.
   * @example await bridge.readSpecificationCollection(41, target, plan);
   */
  async readSpecificationCollection(tabId, target, plan) {
    const script = specificationCollectionScript(target, plan);
    await this.#requireProductTarget(tabId, target);
    const data = await this.#command('eval', { tabId, script });
    return validateSpecificationCollectionObservation(data?.result, target);
  }

  /** @param {number} tabId @param {object} target @param {object[]} [batches] Previous batches, or [] for the first; omitted retains legacy output. @returns {Promise<object>} Up to five option/image associations. @throws {ShoppingError} Identity, page or schema errors; no internal retry. @example await bridge.readSpecificationImages(41, target); */
  async readSpecificationImages(tabId, target, batches) {
    const script = batches === undefined ? specificationImagesScript(target) : specificationImageBatchScript(target, batches);
    await this.#requireProductTarget(tabId, target);
    const data = await this.#command('eval', { tabId, script });
    const result = validateSpecificationImages(data?.result, target);
    if (batches !== undefined && (result.schema_version !== 2 || result.batch.offset !== specificationImageContinuation(batches, target).offset)) {
      throw new ShoppingError('INVALID_RESPONSE', 'The image batch does not match the requested continuation.');
    }
    return result;
  }

  /** @param {number} tabId @param {object} target @returns {Promise<object>} Top gallery links only, independent of title, price and currently displayed media. @throws {ShoppingError} Target, page or schema errors; no internal retry. @example await bridge.readGallery(41, target); */
  async readGallery(tabId, target) {
    const script = galleryScript(target);
    await this.#requireProductTarget(tabId, target);
    const data = await this.#command('eval', { tabId, script });
    return validateGallery(data?.result, target);
  }

  /** @param {number} tabId @param {object} target @returns {Promise<object>} Product snapshot and loaded parameters, asset links and service labels. @throws {ShoppingError} Connection, identity, page or schema errors; no retries. */
  async readDetails(tabId, target) {
    const script = detailsScript(target);
    await this.#requireProductTarget(tabId, target);
    const data = await this.#command('eval', { tabId, script }, 1048576);
    return validateDetails(data?.result, target);
  }

  /** @param {number} tabId @param {object} target @returns {Promise<object>} Details and bounded explicit description-entry evidence. @throws {ShoppingError} Identity, page or schema errors; no retries. @example await bridge.readDescriptionExpansion(41, target); */
  async readDescriptionExpansion(tabId, target) {
    const script = descriptionExpansionScript(target);
    await this.#requireProductTarget(tabId, target);
    const data = await this.#command('eval', { tabId, script }, 1048576);
    return validateDescriptionObservation(data?.result, target);
  }

  /** @param {number} tabId @param {object} target @param {object} entry Saved collapsed entry scan. @returns {Promise<{clicked: boolean}>} Dispatch acknowledgement only. @throws {ShoppingError} Undispatched guards or uncertain transport errors; no retries. @example await bridge.expandDescription(41, target, entry); */
  async expandDescription(tabId, target, entry) {
    let script;
    try { script = descriptionExpansionScript(target, entry); await this.#requireProductTarget(tabId, target); }
    catch (error) { error.actionNotDispatched = true; throw error; }
    const data = await this.#command('eval', { tabId, script }, 1048576);
    return validateReadActionAcknowledgement(data?.result);
  }

  /** @param {number} tabId @param {object} target @param {number} position Original IMG position. @returns {Promise<object>} Same-read details and bounded image scope, without actions. @throws {ShoppingError} Identity, gate or schema errors; no retries. @example await bridge.readDescriptionImageLoading(41, target, 1); */
  async readDescriptionImageLoading(tabId, target, position) {
    const script = descriptionImageLoadingScript(target, position);
    await this.#requireProductTarget(tabId, target);
    const data = await this.#command('eval', { tabId, script }, 1048576);
    return validateDescriptionImageObservation(data?.result, target, position);
  }

  /** @param {number} tabId @param {object} target @param {number} position Original IMG position. @param {object} expected Prior source. @returns {Promise<object>} Pre-action source plus one scroll acknowledgement, without loading proof. @throws {ShoppingError} Undispatched guards or uncertain transport errors; no retries. @example await bridge.scrollDescriptionImage(41, target, 1, initial); */
  async scrollDescriptionImage(tabId, target, position, expected) {
    let script;
    try { script = descriptionImageLoadingScript(target, position, expected); await this.#requireProductTarget(tabId, target); }
    catch (error) { error.actionNotDispatched = true; throw error; }
    const data = await this.#command('eval', { tabId, script }, 1048576);
    try { return validateDescriptionImageScroll(data?.result, target, position, expected); }
    catch (error) { if (data?.result?.state) error.actionNotDispatched = true; throw error; }
  }

  /** @param {number} tabId @param {object} target @param {string} thumbnail @returns {Promise<object>} One bounded main-image observation, with no scroll, cleanup or download. @throws {ShoppingError} Target, gate or schema errors; no retries. @example await bridge.readMainImage(41, target, thumbnail); */
  async readMainImage(tabId, target, thumbnail) {
    const script = mainImageScript(target, thumbnail);
    await this.#requireProductTarget(tabId, target);
    const data = await this.#command('eval', { tabId, script });
    return validateMainImageObservation(data?.result, target, thumbnail);
  }

  /** @param {number} tabId @param {object} target @param {string} thumbnail @returns {Promise<{clicked: boolean}>} Dispatch reply only; the caller must reserve and confirm. @throws {ShoppingError} Guards marked undispatched or uncertain transport failure; no retries. @example await bridge.selectMainImage(41, target, thumbnail); */
  async selectMainImage(tabId, target, thumbnail) {
    let script;
    try {
      script = mainImageScript(target, thumbnail, true);
      await this.#requireProductTarget(tabId, target);
    } catch (error) { error.actionNotDispatched = true; throw error; }
    const data = await this.#command('eval', { tabId, script });
    return validateReadActionAcknowledgement(data?.result);
  }

  async #requireProductTarget(tabId, target) {
    try { await this.#requireTarget(tabId, target); }
    catch (error) {
      if (error.code !== 'TARGET_MISSING' || !isExtensionProtocol(this.protocol)) throw error;
      await this.probeProductTarget(tabId, target);
    }
  }

  /** @param {number} tabId Explicitly saved tab. @param {object} target @returns {Promise<object>} Matching canonical identity only, without title or DOM reads. @throws {ShoppingError} Identity, login, connection or protocol errors; no retries or focus changes. */
  async probeProductTarget(tabId, target) {
    const script = productTargetScript(target);
    await this.requireConnected();
    const data = await this.#command('eval', { tabId: parseTabId(tabId), script });
    throwPageError(data?.result?.state);
    const expected = parseProductUrl(target.url);
    if (data?.result?.state !== 'observed' || data.result.url !== expected.url ||
        Object.keys(data.result).sort().join(',') !== 'state,url') {
      throw new ShoppingError('INVALID_RESPONSE', 'The address probe did not confirm the saved product.');
    }
    return expected;
  }

  async #requireSearchPage(tabId, target, allowSecond) {
    await this.requireConnected();
    const actual = parseSearchPageUrl(await savedTabUrl(this, tabId, 'The saved search page is neither listed nor reachable by its ID.'));
    if (!actual || actual.query !== target.query || (!allowSecond && actual.page !== 1)) {
      throw new ShoppingError('TARGET_CHANGED', 'Restore the same query and the page allowed by the saved next-page intent.');
    }
  }

  /** @param {number} tabId @param {object} target @param {boolean} allowSecond @returns {Promise<object>} At most 25 cards and pagination state. @throws {ShoppingError} Target, gate or response errors; no retries. */
  async readSearchPage(tabId, target, allowSecond) {
    const script = searchPagesScript(target, { allowSecond });
    await this.#requireSearchPage(tabId, target, allowSecond);
    const data = await this.#command('eval', { tabId, script });
    return validateSearchPage(data?.result, target, allowSecond);
  }

  /** @param {number} tabId @param {object} target @param {object} before @returns {Promise<object>} Single next-page acknowledgement. @throws {ShoppingError} Pre-dispatch errors are marked; ambiguous dispatches must only be observed. */
  async nextSearchPage(tabId, target, before) {
    let script;
    try {
      script = searchPagesScript(target, { before });
      await this.#requireSearchPage(tabId, target, false);
    } catch (error) { error.actionNotDispatched = true; throw error; }
    const data = await this.#command('eval', { tabId, script });
    return validateReadActionAcknowledgement(data?.result);
  }

  async #requireSearchCollectionPage(tabId, target, allowedPages) {
    await this.requireConnected();
    const actual = parseSearchRangeUrl(await savedTabUrl(this, tabId, 'The saved search collection tab is neither listed nor reachable by its ID.'));
    if (!actual || actual.query !== target.query || !allowedPages.includes(actual.page)) {
      throw new ShoppingError('TARGET_CHANGED', 'Restore the saved query and a page permitted by its current collection intent.');
    }
  }

  /**
   * @param {number} tabId Saved tab. @param {object} target Canonical query. @param {number[]} allowedPages Explicit saved allowance.
   * @param {{cardLimit?:number}} [options] The task's cards-per-page limit (25 or 50).
   * @returns {Promise<object>} One bounded range-page observation or transition marker, without actions or retries.
   * @throws {ShoppingError} Invalid arguments, target, connection, gates or response errors.
   * @example await bridge.readSearchCollectionPage(tabId, target, [2,3], {cardLimit:50});
   */
  async readSearchCollectionPage(tabId, target, allowedPages, {cardLimit = SEARCH_RANGE_CARD_LIMIT} = {}) {
    const script = searchCollectionScript(target, {allowedPages,cardLimit}), id = parseTabId(tabId);
    await this.#requireSearchCollectionPage(id, target, allowedPages);
    const data = await this.#command('eval', {tabId:id,script});
    return validateSearchCollectionPage(data?.result, target, allowedPages, {cardLimit});
  }

  /**
   * @param {number} tabId Saved tab. @param {object} target Canonical query. @param {object} before Validated current page.
   * @returns {Promise<object>} One next-page acknowledgement guarded by saved card positions and displayed pagination.
   * @throws {ShoppingError} Preparation failures are marked actionNotDispatched; unknown dispatch IO remains uncertain.
   * @example await bridge.nextSearchCollectionPage(tabId, target, before);
   */
  async nextSearchCollectionPage(tabId, target, before) {
    let script, id;
    try {
      script = searchCollectionScript(target, {allowedPages:[before?.search?.page],before,cardLimit:before?.search?.limits?.cards});
      id = parseTabId(tabId);
      await this.#requireSearchCollectionPage(id, target, [before.search.page]);
    } catch (error) {error.actionNotDispatched = true; throw error;}
    const data = await this.#command('eval', {tabId:id,script});
    return validateReadActionAcknowledgement(data?.result);
  }

  /**
   * Verify the address of an explicitly saved sort tab, including outside the current-window inventory.
   * @param {number} tabId @param {object} target @param {boolean} dispatched
   * @returns {Promise<object>} Canonical matching address; no page content or unrelated URL leaves the page.
   * @throws {ShoppingError} Connection, missing tab, login or identity failure. Never retries or focuses a window.
   */
  async probeSortTarget(tabId, target, dispatched = false) {
    const script = searchSortTargetScript(target, dispatched);
    await this.requireConnected();
    const data = await this.#command('eval', { tabId: parseTabId(tabId), script });
    throwPageError(data?.result?.state);
    const actual = parseSortableSearchUrl(data?.result?.url);
    if (data?.result?.state !== 'observed' || actual?.url !== data.result.url || !matchesSearchSort(actual?.url, target, { action_reserved: dispatched })) {
      throw new ShoppingError('INVALID_RESPONSE', 'The address probe did not confirm the saved sort target.');
    }
    return actual;
  }

  async #requireSortableSearch(tabId, target, dispatched) {
    await this.requireConnected();
    const tab = (await this.listTabs()).find(item => item.id === parseTabId(tabId));
    if (!tab) {
      if (!isExtensionProtocol(this.protocol)) throw new ShoppingError('TARGET_MISSING', 'The saved sort page is absent.');
      await this.probeSortTarget(tabId, target, dispatched);
      return;
    }
    if (!matchesSearchSort(tab.url, target, { action_reserved: dispatched })) {
      let hostname;
      try { hostname = new URL(tab.url).hostname; } catch { /* Fail closed on unknown URLs. */ }
      if (['login.taobao.com', 'login.tmall.com'].includes(hostname)) throw new ShoppingError('LOGIN_REQUIRED', 'The sort task moved to login.');
      throw new ShoppingError('TARGET_CHANGED', 'The search URL is inconsistent with the saved sort intent.');
    }
  }

  /** @param {number} tabId @param {object} target @param {boolean} dispatched @returns {Promise<object>} Bounded sort observation. @throws {ShoppingError} Identity, gate or layout failure; no retries. */
  async readSearchSort(tabId, target, dispatched) {
    const script = searchSortScript(target, { dispatched });
    await this.#requireSortableSearch(tabId, target, dispatched);
    const data = await this.#command('eval', { tabId, script });
    return validateSearchSort(data?.result, target, dispatched);
  }

  /**
   * Open the canonical first search page for one query in a new active tab of the extension's current window.
   * @param {string} query @returns {Promise<{tab_id: number, kind: 'search', url_matches: boolean}>} No URL is returned.
   * @throws {ShoppingError} Invalid query or connection failures before dispatch are marked undispatched.
   */
  async openSearchPage(query) {
    let target;
    try { target = searchPageTarget(query, 1); } catch (error) { error.actionNotDispatched = true; throw error; }
    return this.#openTab(target.url, 'search', url => parseSearchUrl(url)?.url === target.url);
  }

  /** @param {string} url A Taobao or Tmall item link; tracking parameters are dropped. @returns {Promise<{tab_id: number, kind: 'product', url_matches: boolean}>} */
  async openProductPage(url) {
    const product = parseProductUrl(url);
    if (!product) {
      const error = new ShoppingError('INVALID_ARGUMENTS', 'Use an item.taobao.com or detail.tmall.com item link.');
      error.actionNotDispatched = true;
      throw error;
    }
    return this.#openTab(product.url, 'product', value => parseProductUrl(value)?.url === product.url);
  }

  /** @returns {Promise<{tab_id: number, kind: 'orders', url_matches: boolean}>} The buyer order list (已买到的宝贝); login may be required. */
  async openOrderListPage() {
    const list = parseOrderListUrl('https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm');
    return this.#openTab(list.url, 'orders', value => parseOrderListUrl(value)?.url === list.url);
  }

  /** @returns {Promise<{tab_id: number, kind: 'cart', url_matches: boolean}>} New cart tab; nothing on the page is clicked or changed. @throws {ShoppingError} Connection or acknowledgement errors. @example await bridge.openCartPage(); */
  async openCartPage() {
    const cart = parseCartUrl('https://cart.taobao.com/cart.htm');
    return this.#openTab(cart.url, 'cart', value => parseCartUrl(value)?.url === cart.url);
  }

  /**
   * JD counterparts of the open*Page methods. Each result also says where the tab landed, as a category only:
   * requested, login_page, risk_page or other_page.
   * @param {string} query @returns {Promise<{tab_id: number, kind: 'search', url_matches: boolean, landing: string}>}
   */
  async openJdSearchPage(query) {
    let target;
    try { target = jdSearchTarget(query); } catch (error) { error.actionNotDispatched = true; throw error; }
    return this.#openTab(target.url, 'search', url => parseJdSearchUrl(url)?.query === target.query, jdLanding);
  }

  /** @param {string} url An item.jd.com link; tracking parameters are dropped. @returns {Promise<object>} As openJdSearchPage, kind product. */
  async openJdProductPage(url) {
    const product = parseJdProductUrl(url);
    if (!product) {
      const error = new ShoppingError('INVALID_ARGUMENTS', 'Use an item.jd.com product link.');
      error.actionNotDispatched = true;
      throw error;
    }
    return this.#openTab(product.url, 'product', value => parseJdProductUrl(value)?.product_id === product.product_id, jdLanding);
  }

  /** @returns {Promise<object>} As openJdSearchPage, kind orders; login may be required. */
  async openJdOrderListPage() {
    return this.#openTab(parseJdOrderListUrl('https://order.jd.com/center/list.action').url, 'orders', value => parseJdOrderListUrl(value) !== null, jdLanding);
  }

  /** @returns {Promise<object>} As openJdSearchPage, kind cart; nothing on the page is clicked or changed. */
  async openJdCartPage() {
    return this.#openTab(parseJdCartUrl('https://cart.jd.com/cart_index').url, 'cart', value => parseJdCartUrl(value) !== null, jdLanding);
  }

  /**
   * PDD counterparts of the open*Page methods, on its mobile web site. PDD has no cart. Each result says where the tab
   * landed, as a category only: requested, login_page, risk_page or other_page.
   * @param {string} query @returns {Promise<{tab_id: number, kind: 'search', url_matches: boolean, landing: string}>}
   */
  async openPddSearchPage(query) {
    let target;
    try { target = pddSearchTarget(query); } catch (error) { error.actionNotDispatched = true; throw error; }
    return this.#openTab(target.url, 'search', url => parsePddSearchUrl(url)?.query === target.query, pddLanding);
  }

  /** @returns {Promise<object>} As openPddSearchPage, kind orders; login may be required. */
  async openPddOrderListPage() {
    return this.#openTab(parsePddOrderListUrl('https://mobile.pinduoduo.com/orders.html').url, 'orders', value => parsePddOrderListUrl(value) !== null, pddLanding);
  }

  /**
   * Read the loaded cards of one PDD search page; never clicks, scrolls or navigates.
   * @param {number} tabId @param {object} target Canonical PDD search target.
   * @returns {Promise<object>} Validated search result.
   * @throws {ShoppingError} TARGET_MISSING, TARGET_CHANGED, LOGIN_REQUIRED or RATE_LIMITED from the tab address, page gates or INVALID_RESPONSE.
   * @example await bridge.readPddSearch(88, pddSearchTarget('罗技 M330'));
   */
  async readPddSearch(tabId, target) {
    const script = pddSearchScript(target);
    await this.requireConnected();
    const url = await savedTabUrl(this, tabId, 'The saved PDD search page is neither listed nor reachable by its ID.');
    if (parsePddSearchUrl(url)?.query !== target.query) {
      const landing = pddLandingKind(url);
      throwPageError(landing === 'login_page' ? 'login_required' : landing === 'risk_page' ? 'verification_required' : 'target_changed');
    }
    const data = await this.#command('eval', { tabId: parseTabId(tabId), script });
    return validatePddSearch(data?.result, target);
  }

  /**
   * Read the PDD search page's sort_type and which sort bar item is marked; never clicks, scrolls or navigates.
   * @param {number} tabId @param {object} target Canonical PDD search target.
   * @returns {Promise<{sort_type: string|null, selected: string[], price_range: string|null, panel: {open: boolean, minimum: string|null, maximum: string|null}}>}
   * @throws {ShoppingError} Identity or gate errors from the tab address, page gates, PAGE_STRUCTURE_CHANGED or INVALID_RESPONSE.
   * @example await bridge.readPddSortState(88, pddSearchTarget('无线鼠标'));
   */
  async readPddSortState(tabId, target) {
    const script = pddSortStateScript(target);
    await this.#requirePddPage(tabId, url => parsePddSearchUrl(url)?.query === target.query, 'The saved PDD search page is neither listed nor reachable by its ID.');
    const data = await this.#command('eval', { tabId: parseTabId(tabId), script });
    return validatePddSortState(data?.result);
  }

  /**
   * Click one sort bar item once on a PDD search tab, after the page confirms the address shows the expected sort_type and
   * price range. Paced as a search load: the click re-sorts the results. Refusals and failures before the page script runs
   * are marked actionNotDispatched; any other error leaves the click uncertain.
   * @param {number} tabId @param {object} target Canonical PDD search target.
   * @param {{label: string, from: string|null, range?: string|null}} step range is the price=A,B the page must show, or null.
   * @returns {Promise<{clicked: true}>} @throws {ShoppingError} Never retried here.
   * @example await bridge.clickPddSort(88, pddSearchTarget('无线鼠标'), { label: '价格', from: null });
   */
  async clickPddSort(tabId, target, step) {
    let script;
    try {
      script = pddSortClickScript(target, step);
      await this.#requirePddPage(tabId, url => parsePddSearchUrl(url)?.query === target.query, 'The saved PDD search page is neither listed nor reachable by its ID.');
    } catch (error) { error.actionNotDispatched = true; throw error; }
    const data = await this.#command('eval', { tabId: parseTabId(tabId), script });
    return validatePddSortClick(data?.result);
  }

  /**
   * Click 筛选 once on a PDD search tab without a price range; it opens the filter panel in place. Errors as clickPddSort.
   * @param {number} tabId @param {object} target @returns {Promise<{clicked: true}>}
   * @example await bridge.openPddFilter(88, pddSearchTarget('无线鼠标'));
   */
  async openPddFilter(tabId, target) {
    let script;
    try {
      script = pddSortClickScript(target, { label: '筛选', from: null, range: null });
      await this.#requirePddPage(tabId, url => parsePddSearchUrl(url)?.query === target.query, 'The saved PDD search page is neither listed nor reachable by its ID.');
    } catch (error) { error.actionNotDispatched = true; throw error; }
    const data = await this.#command('eval', { tabId: parseTabId(tabId), script });
    return validatePddSortClick(data?.result);
  }

  /**
   * Type both bounds into the open, empty 最低价 and 最高价 inputs through the extension's fill command, each on a fresh
   * snapshot reference scoped to its placeholder, as fillJdPriceRange does. Nothing is clicked.
   * @param {number} tabId @param {object} target @param {number} minimum @param {number} maximum Whole yuan.
   * @returns {Promise<{filled: true}>}
   * @throws {ShoppingError} SEARCH_PRICE_RANGE_UNAVAILABLE or SEARCH_PRICE_RANGE_NOT_EMPTY before typing (marked actionNotDispatched);
   *   INVALID_RESPONSE or transport errors once typing may have started.
   * @example await bridge.fillPddPriceRange(88, pddSearchTarget('无线鼠标'), 30, 60);
   */
  async fillPddPriceRange(tabId, target, minimum, maximum) {
    const id = parseTabId(tabId);
    const reference = async placeholder => {
      const data = await this.#command('snapshot', { tabId: id, selector: `input[placeholder="${placeholder}"]`, interactive: true, compact: true, maxDepth: 1 });
      const refs = Object.entries(data?.snapshotData?.refs ?? {});
      if (refs.length !== 1 || !/^[A-Za-z0-9_-]{1,32}$/.test(refs[0][0]) || refs[0][1]?.role !== 'textbox' || refs[0][1]?.name !== placeholder) {
        throw new ShoppingError('SEARCH_PRICE_RANGE_UNAVAILABLE', 'The price range input is not one textbox.', 'Open the search page again and start a new task.');
      }
      return refs[0][0];
    };
    const fields = [[PDD_RANGE_INPUTS[0], String(minimum)], [PDD_RANGE_INPUTS[1], String(maximum)]];
    let first;
    try {
      if (!isExtensionProtocol(this.protocol)) throw new ShoppingError('UNSUPPORTED_CAPABILITY', 'Price inputs are filled only through the declared extension backend.');
      requirePddPriceRange(minimum, maximum);
      const script = pddSortStateScript(target);
      await this.#requirePddPage(tabId, url => parsePddSearchUrl(url)?.query === target.query, 'The saved PDD search page is neither listed nor reachable by its ID.');
      const shown = validatePddSortState((await this.#command('eval', { tabId: id, script }))?.result);
      if (!shown.panel.open || shown.price_range !== null) {
        throw new ShoppingError('SEARCH_PRICE_RANGE_UNAVAILABLE', 'The 筛选 panel is not open on a page without a range; nothing was typed.', 'Open the search page again and start a new task.');
      }
      if (shown.panel.minimum !== '' || shown.panel.maximum !== '') {
        throw new ShoppingError('SEARCH_PRICE_RANGE_NOT_EMPTY', 'A price range input already holds text; nothing was typed.', 'Open the search page again and start a new task.');
      }
      first = await reference(fields[0][0]);
    } catch (error) { error.actionNotDispatched = true; throw error; }
    for (const [index, [placeholder, text]] of fields.entries()) {
      const ref = index === 0 ? first : await reference(placeholder);
      const data = await this.#command('fill', { tabId: id, ref, text });
      if (data?.role !== 'textbox' || data?.name !== placeholder || data?.filledText !== text) {
        throw new ShoppingError('INVALID_RESPONSE', 'The fill acknowledgement did not match the requested bound.');
      }
    }
    return { filled: true };
  }

  /**
   * Click the 筛选 panel's 确认 once, after the page confirms both inputs hold the bounds. Paced as a search load: it
   * filters the results in place. Errors as clickPddSort.
   * @param {number} tabId @param {object} target @param {number} minimum @param {number} maximum @returns {Promise<{clicked: true}>}
   * @example await bridge.confirmPddPriceRange(88, pddSearchTarget('无线鼠标'), 30, 60);
   */
  async confirmPddPriceRange(tabId, target, minimum, maximum) {
    let script;
    try {
      script = pddRangeConfirmScript(target, minimum, maximum);
      await this.#requirePddPage(tabId, url => parsePddSearchUrl(url)?.query === target.query, 'The saved PDD search page is neither listed nor reachable by its ID.');
    } catch (error) { error.actionNotDispatched = true; throw error; }
    const data = await this.#command('eval', { tabId: parseTabId(tabId), script });
    return validatePddSortClick(data?.result);
  }

  /**
   * Click search card N once on a PDD search tab, after the page confirms the card still shows the saved title and price.
   * Paced as a page load: PDD then opens the product page in the same tab. Refusals and failures before the page script
   * runs are marked actionNotDispatched; any other error leaves the click uncertain.
   * @param {number} tabId Search tab. @param {object} target Canonical PDD search target. @param {number} position 1-40.
   * @param {{title: string, amount_text: string}} card The saved card. @returns {Promise<{clicked: true}>}
   * @throws {ShoppingError} Identity, gate or refusal errors (not dispatched), or transport errors after dispatch; never retried here.
   * @example await bridge.clickPddSearchCard(88, pddSearchTarget('连衣裙'), 4, { title: '秋冬', amount_text: '89.9' });
   */
  async clickPddSearchCard(tabId, target, position, card) {
    let script;
    try {
      script = pddSearchCardClickScript(target, position, card);
      await this.requireConnected();
      const url = await savedTabUrl(this, tabId, 'The PDD search tab is neither listed nor reachable by its ID.');
      if (parsePddSearchUrl(url)?.query !== target.query) {
        const landing = pddLandingKind(url);
        throwPageError(landing === 'login_page' ? 'login_required' : landing === 'risk_page' ? 'verification_required' : 'target_changed');
      }
    } catch (error) { error.actionNotDispatched = true; throw error; }
    const data = await this.#command('eval', { tabId: parseTabId(tabId), script });
    return validatePddSearchCardClick(data?.result);
  }

  /**
   * Read the PDD product page a search card opened; never clicks, scrolls or navigates.
   * @param {number} tabId @param {string} productId goods_id from the tab address. @param {string} titlePrefix The card title.
   * @returns {Promise<{observed_at: string, raw: object}>} The validated raw observation, kept so a saved result can be rebuilt.
   * @throws {ShoppingError} TARGET_MISSING, TARGET_CHANGED, LOGIN_REQUIRED or VERIFICATION_REQUIRED from the tab address, page gates,
   *   TITLE_MISMATCH or INVALID_RESPONSE.
   * @example await bridge.readPddProduct(88, '123456', '秋冬');
   */
  async readPddProduct(tabId, productId, titlePrefix) {
    const script = pddProductScript(productId, titlePrefix);
    await this.requireConnected();
    const url = await savedTabUrl(this, tabId, 'The PDD product tab is neither listed nor reachable by its ID.');
    if (parsePddProductUrl(url)?.product_id !== productId) {
      const landing = pddLandingKind(url);
      throwPageError(landing === 'login_page' ? 'login_required' : landing === 'risk_page' ? 'verification_required' : 'target_changed');
    }
    const data = await this.#command('eval', { tabId: parseTabId(tabId), script });
    const observedAt = new Date().toISOString();
    validatePddProduct(data?.result, productId, titlePrefix, { observedAt });
    return { observed_at: observedAt, raw: data.result };
  }

  /**
   * Click 查看全部 once on a PDD product page, after the page script checks 商品评价(N) still shows the saved count.
   * Paced as a page load: PDD then opens the review page in the same tab. Refusals and failures before the page script
   * runs are marked actionNotDispatched; any other error leaves the click uncertain.
   * @param {number} tabId Product tab. @param {string} productId goods_id. @param {number} count Saved review count.
   * @returns {Promise<{clicked: true}>}
   * @throws {ShoppingError} Identity, gate or refusal errors (not dispatched), or transport errors after dispatch; never retried here.
   * @example await bridge.clickPddReviewsLink(88, '123456', 142);
   */
  async clickPddReviewsLink(tabId, productId, count) {
    let script;
    try {
      script = pddReviewsLinkClickScript(productId, count);
      await this.requireConnected();
      const url = await savedTabUrl(this, tabId, 'The PDD product tab is neither listed nor reachable by its ID.');
      if (parsePddProductUrl(url)?.product_id !== productId) {
        const landing = pddLandingKind(url);
        throwPageError(landing === 'login_page' ? 'login_required' : landing === 'risk_page' ? 'verification_required' : 'target_changed');
      }
    } catch (error) { error.actionNotDispatched = true; throw error; }
    const data = await this.#command('eval', { tabId: parseTabId(tabId), script });
    return validatePddReviewsLinkClick(data?.result);
  }

  /**
   * Read the loaded reviews of a PDD review page; never clicks, scrolls or navigates.
   * @param {number} tabId @param {string} productId goods_id from the tab address.
   * @returns {Promise<{observed_at: string, raw: object}>} The validated raw observation, kept so a saved result can be rebuilt.
   * @throws {ShoppingError} TARGET_MISSING, TARGET_CHANGED, LOGIN_REQUIRED or VERIFICATION_REQUIRED from the tab address, page gates or INVALID_RESPONSE.
   * @example await bridge.readPddReviews(88, '123456');
   */
  async readPddReviews(tabId, productId) {
    const script = pddReviewsScript(productId);
    await this.requireConnected();
    const url = await savedTabUrl(this, tabId, 'The PDD review tab is neither listed nor reachable by its ID.');
    if (parsePddReviewsUrl(url)?.product_id !== productId) {
      const landing = pddLandingKind(url);
      throwPageError(landing === 'login_page' ? 'login_required' : landing === 'risk_page' ? 'verification_required' : 'target_changed');
    }
    const data = await this.#command('eval', { tabId: parseTabId(tabId), script });
    const observedAt = new Date().toISOString();
    validatePddReviews(data?.result, productId, { observedAt });
    return { observed_at: observedAt, raw: data.result };
  }

  /**
   * Read the bottom bar buy buttons and the open spec drawer of a PDD product page; never clicks, scrolls or navigates.
   * @param {number} tabId Product tab. @param {string} productId goods_id. @param {string[]} groups Spec group names from the product task.
   * @returns {Promise<{observed_at: string, raw: object}>} The validated raw observation, kept so a saved result can be rebuilt.
   * @throws {ShoppingError} TARGET_CHANGED when the tab left the product page, other identity or gate errors, PAGE_STRUCTURE_CHANGED or INVALID_RESPONSE.
   * @example await bridge.readPddSpecState(88, '123456', ['颜色分类', '尺码']);
   */
  async readPddSpecState(tabId, productId, groups) {
    const script = pddSpecStateScript(productId, groups);
    await this.#requirePddPage(tabId, url => parsePddProductUrl(url)?.product_id === productId, 'The PDD product tab is neither listed nor reachable by its ID.');
    const data = await this.#command('eval', { tabId: parseTabId(tabId), script });
    const observedAt = new Date().toISOString();
    validatePddSpecState(data?.result, groups);
    return { observed_at: observedAt, raw: data.result };
  }

  /**
   * Click one control of a PDD product page's spec drawer once: a bottom bar buy button that opens a drawer, one option
   * that is not selected, or the drawer's close icon. Never the drawer's own buttons. Refusals and failures before the page
   * script runs are marked actionNotDispatched; any other error leaves the click uncertain.
   * @param {number} tabId @param {string} productId @param {string[]} groups
   * @param {{kind: 'open', label: string}|{kind: 'option', group: string, text: string}|{kind: 'close'}} action
   * @returns {Promise<{clicked: true}>} @throws {ShoppingError} Never retried here.
   * @example await bridge.clickPddSpec(88, '123456', ['型号'], { kind: 'open', label: '免拼购买' });
   */
  async clickPddSpec(tabId, productId, groups, action) {
    let script;
    try {
      script = pddSpecClickScript(productId, groups, action);
      await this.#requirePddPage(tabId, url => parsePddProductUrl(url)?.product_id === productId, 'The PDD product tab is neither listed nor reachable by its ID.');
    } catch (error) { error.actionNotDispatched = true; throw error; }
    const data = await this.#command('eval', { tabId: parseTabId(tabId), script });
    return validatePddSpecClick(data?.result);
  }

  /** Fail before a page script when the tab is not on the expected PDD page; marks the error as not dispatched. */
  async #requirePddPage(tabId, matches, message) {
    await this.requireConnected();
    const url = await savedTabUrl(this, tabId, message);
    if (!matches(url)) {
      const landing = pddLandingKind(url);
      throwPageError(landing === 'login_page' ? 'login_required' : landing === 'risk_page' ? 'verification_required' : 'target_changed');
    }
  }

  /**
   * Read the loaded cards of the PDD order list; never clicks, scrolls or navigates.
   * @param {number} tabId Order list tab. @returns {Promise<object>} Validated order list result.
   * @throws {ShoppingError} Identity or gate errors from the tab address, page gates or INVALID_RESPONSE.
   * @example await bridge.readPddOrders(88);
   */
  async readPddOrders(tabId) {
    const script = pddOrdersScript();
    await this.#requirePddPage(tabId, url => parsePddOrderListUrl(url) !== null, 'The PDD order list tab is neither listed nor reachable by its ID.');
    const data = await this.#command('eval', { tabId: parseTabId(tabId), script });
    return validatePddOrders(data?.result);
  }

  /**
   * Click the 商品名称 of order N once on the PDD order list, after the page script checks its shop, status and title.
   * Paced as a page load: PDD opens the order page in the same tab. Refusals and failures before the page script runs
   * are marked actionNotDispatched; any other error leaves the click uncertain.
   * @param {number} tabId @param {number} position 1-50. @param {{shop: string, status: string, title: string}} card
   * @returns {Promise<{clicked: true}>} @throws {ShoppingError} Never retried here.
   * @example await bridge.clickPddOrderCard(88, 3, { shop: '优尚一家', status: '交易成功', title: '断桥锁点…' });
   */
  async clickPddOrderCard(tabId, position, card) {
    let script;
    try {
      script = pddOrderCardClickScript(position, card);
      await this.#requirePddPage(tabId, url => parsePddOrderListUrl(url) !== null, 'The PDD order list tab is neither listed nor reachable by its ID.');
    } catch (error) { error.actionNotDispatched = true; throw error; }
    const data = await this.#command('eval', { tabId: parseTabId(tabId), script });
    return validatePddOrderClick(data?.result);
  }

  /**
   * Click 查看更多订单和优惠信息 once on a PDD order page; it unfolds the order times in place.
   * @param {number} tabId @param {string} orderId order_sn of the tab. @returns {Promise<{clicked: boolean}>} false when the page shows no such entry.
   * @throws {ShoppingError} As clickPddOrderCard.
   * @example await bridge.expandPddOrderInfo(88, '261026-123');
   */
  async expandPddOrderInfo(tabId, orderId) {
    let script;
    try {
      script = pddOrderExpandScript(orderId);
      await this.#requirePddPage(tabId, url => parsePddOrderDetailUrl(url)?.order_id === orderId, 'The PDD order tab is neither listed nor reachable by its ID.');
    } catch (error) { error.actionNotDispatched = true; throw error; }
    const data = await this.#command('eval', { tabId: parseTabId(tabId), script });
    return validatePddOrderClick(data?.result, true);
  }

  /**
   * Read a PDD order page without its consignee, payment and logistics rows; never clicks, scrolls or navigates.
   * @param {number} tabId @param {string} orderId order_sn of the tab. @param {string} shop Shop name from the list.
   * @returns {Promise<{observed_at: string, raw: object}>} The validated raw observation, kept so a saved result can be rebuilt.
   * @throws {ShoppingError} Identity or gate errors, ORDER_NUMBER_MISMATCH or INVALID_RESPONSE.
   * @example await bridge.readPddOrderDetail(88, '261026-123', '优尚一家');
   */
  async readPddOrderDetail(tabId, orderId, shop) {
    const script = pddOrderDetailScript(orderId, shop);
    await this.#requirePddPage(tabId, url => parsePddOrderDetailUrl(url)?.order_id === orderId, 'The PDD order tab is neither listed nor reachable by its ID.');
    const data = await this.#command('eval', { tabId: parseTabId(tabId), script });
    const observedAt = new Date().toISOString();
    validatePddOrderDetail(data?.result, orderId, { observedAt });
    return { observed_at: observedAt, raw: data.result };
  }

  /**
   * Read the loaded first screen of one JD search page; never clicks, scrolls or navigates.
   * @param {number} tabId @param {object} target Canonical JD search target.
   * @returns {Promise<object>} Validated search result.
   * @throws {ShoppingError} TARGET_MISSING, TARGET_CHANGED, LOGIN_REQUIRED or RATE_LIMITED from the tab address, page gates or INVALID_RESPONSE.
   * @example await bridge.readJdSearch(88, jdSearchTarget('罗技 M330'));
   */
  async readJdSearch(tabId, target) {
    const script = jdSearchScript(target);
    await this.requireConnected();
    const url = await savedTabUrl(this, tabId, 'The saved JD search page is neither listed nor reachable by its ID.');
    if (parseJdSearchUrl(url)?.query !== target.query) {
      const landing = jdLandingKind(url);
      throwPageError(landing === 'login_page' ? 'login_required' : landing === 'risk_page' ? 'rate_limited' : 'target_changed');
    }
    const data = await this.#command('eval', { tabId: parseTabId(tabId), script });
    return validateJdSearch(data?.result, target);
  }

  /**
   * Read the search pager and the loaded first screen of cards together; never clicks, scrolls or navigates. JD keeps the
   * page number out of the address, so only the pager tells which page this is.
   * Failures before the page script runs are marked actionNotDispatched.
   * @param {number} tabId @param {object} target Canonical JD search target.
   * @returns {Promise<{observed_at: string, raw: object}>} The validated raw observation, kept so a saved result can be rebuilt.
   * @throws {ShoppingError} TARGET_MISSING, TARGET_CHANGED, LOGIN_REQUIRED or RATE_LIMITED from the tab address, page gates,
   *   SEARCH_PAGINATION_MISSING, SEARCH_PAGE_CONTROLS_MISMATCH or INVALID_RESPONSE.
   * @example await bridge.readJdSearchPage(88, jdSearchTarget('罗技 M330'));
   */
  async readJdSearchPage(tabId, target) {
    let script;
    try {
      script = jdSearchPageScript(target);
      await this.requireConnected();
      await this.#requireJdSearchTab(tabId, target);
    } catch (error) { error.actionNotDispatched = true; throw error; }
    const data = await this.#command('eval', { tabId: parseTabId(tabId), script });
    const observedAt = new Date().toISOString();
    validateJdSearchPage(data?.result, target, { observedAt });
    return { observed_at: observedAt, raw: data.result };
  }

  /**
   * Click 下一页 once on the search pager after the page confirms it still shows fromPage. Paced as a search load: the
   * click replaces the results in place. Refusals (including SEARCH_LAST_PAGE) and failures before the page script runs
   * are marked actionNotDispatched; any other error leaves the click uncertain.
   * @param {number} tabId @param {object} target Canonical JD search target. @param {number} fromPage 1-4.
   * @returns {Promise<{clicked: true}>}
   * @throws {ShoppingError} Identity, gate or refusal errors (not dispatched), or transport errors after dispatch; never retried here.
   * @example await bridge.clickJdNextPage(88, jdSearchTarget('罗技 M330'), 1);
   */
  async clickJdNextPage(tabId, target, fromPage) {
    let script;
    try {
      script = jdNextPageScript(target, fromPage);
      await this.requireConnected();
      await this.#requireJdSearchTab(tabId, target);
    } catch (error) { error.actionNotDispatched = true; throw error; }
    const data = await this.#command('eval', { tabId: parseTabId(tabId), script });
    return validateJdNextPage(data?.result);
  }

  /**
   * Read the sort bar, the pager and the loaded first screen of cards together; never clicks, scrolls or navigates. JD keeps
   * the sort out of the address, so only the sort bar tells which sort is shown.
   * Failures before the page script runs are marked actionNotDispatched.
   * @param {number} tabId @param {object} target Canonical JD search target.
   * @returns {Promise<{observed_at: string, raw: object}>} The validated raw observation, kept so a saved result can be rebuilt.
   * @throws {ShoppingError} TARGET_MISSING, TARGET_CHANGED, LOGIN_REQUIRED or RATE_LIMITED from the tab address, page gates,
   *   SEARCH_SORT_STATE_MISMATCH, SEARCH_PAGINATION_MISSING, SEARCH_PAGE_CONTROLS_MISMATCH or INVALID_RESPONSE.
   * @example await bridge.readJdSortedSearch(88, jdSearchTarget('罗技 M330'));
   */
  async readJdSortedSearch(tabId, target) {
    let script;
    try {
      script = jdSortedSearchScript(target);
      await this.requireConnected();
      await this.#requireJdSearchTab(tabId, target);
    } catch (error) { error.actionNotDispatched = true; throw error; }
    const data = await this.#command('eval', { tabId: parseTabId(tabId), script });
    const observedAt = new Date().toISOString();
    validateJdSortedSearch(data?.result, target, { observedAt });
    return { observed_at: observedAt, raw: data.result };
  }

  /**
   * Click the 销量 or 价格 sort tag once, after the page confirms it still shows the sort state the task last read. Paced as
   * a search load: the click reorders the results in place. Refusals (including SEARCH_SORT_STATE_CHANGED) and failures
   * before the page script runs are marked actionNotDispatched; any other error leaves the click uncertain.
   * @param {number} tabId @param {object} target Canonical JD search target. @param {'销量'|'价格'} label
   * @param {{active_sort: string, price_icon: string|null}} before @returns {Promise<{clicked: true}>}
   * @throws {ShoppingError} Identity, gate or refusal errors (not dispatched), or transport errors after dispatch; never retried here.
   * @example await bridge.clickJdSortTag(88, jdSearchTarget('罗技 M330'), '价格', { active_sort: 'comprehensive', price_icon: null });
   */
  async clickJdSortTag(tabId, target, label, before) {
    let script;
    try {
      script = jdSortClickScript(target, label, before);
      await this.requireConnected();
      await this.#requireJdSearchTab(tabId, target);
    } catch (error) { error.actionNotDispatched = true; throw error; }
    const data = await this.#command('eval', { tabId: parseTabId(tabId), script });
    return validateJdSortClick(data?.result);
  }

  /**
   * Read the open 价格区间 dropdown on a JD search tab: how many are open and, for one, its inputs. Read only.
   * @param {number} tabId @param {object} target Canonical JD search target.
   * @returns {Promise<{open: number, inputs: {placeholder: string, value: string, unique: boolean}[]}>}
   * @throws {ShoppingError} Identity or gate errors (failures before the read are marked actionNotDispatched), or INVALID_RESPONSE.
   */
  async readJdPriceRangePanel(tabId, target) {
    let script;
    try {
      script = jdPriceRangePanelScript(target);
      await this.requireConnected();
      await this.#requireJdSearchTab(tabId, target);
    } catch (error) { error.actionNotDispatched = true; throw error; }
    return validateJdPriceRangePanel((await this.#command('eval', { tabId: parseTabId(tabId), script }))?.result);
  }

  /**
   * Open the 价格区间 dropdown with scripted pointer events (a script click does not open it). Changes nothing on the server.
   * @param {number} tabId @param {object} target Canonical JD search target. @returns {Promise<{hovered: true}>}
   * @throws {ShoppingError} SEARCH_PRICE_RANGE_STATE_CHANGED, identity or gate errors, all marked actionNotDispatched; or INVALID_RESPONSE.
   */
  async hoverJdPriceRange(tabId, target) {
    let script;
    try {
      script = jdPriceRangeHoverScript(target);
      await this.requireConnected();
      await this.#requireJdSearchTab(tabId, target);
    } catch (error) { error.actionNotDispatched = true; throw error; }
    return validateJdPriceRangeHover((await this.#command('eval', { tabId: parseTabId(tabId), script }))?.result);
  }

  /**
   * Type both bounds into the open, empty 价格区间 inputs through the extension's fill command, each on a fresh snapshot
   * reference scoped to that input's placeholder (as the Taobao price task does). Nothing is clicked.
   * @param {number} tabId @param {object} target Canonical JD search target. @param {number} minimum @param {number} maximum Whole yuan.
   * @returns {Promise<{filled: true}>}
   * @throws {ShoppingError} SEARCH_PRICE_RANGE_UNAVAILABLE or SEARCH_PRICE_RANGE_NOT_EMPTY before typing (marked actionNotDispatched);
   *   INVALID_RESPONSE or transport errors once typing may have started.
   */
  async fillJdPriceRange(tabId, target, minimum, maximum) {
    const id = parseTabId(tabId);
    const reference = async placeholder => {
      const data = await this.#command('snapshot', { tabId: id, selector: `input[placeholder="${placeholder}"]`, interactive: true, compact: true, maxDepth: 1 });
      const refs = Object.entries(data?.snapshotData?.refs ?? {});
      if (refs.length !== 1 || !/^[A-Za-z0-9_-]{1,32}$/.test(refs[0][0]) || refs[0][1]?.role !== 'textbox' || refs[0][1]?.name !== placeholder) {
        throw new ShoppingError('SEARCH_PRICE_RANGE_UNAVAILABLE', 'The price range input is not one textbox.', 'Open the search page again and start a new task.');
      }
      return refs[0][0];
    };
    let fields, first;
    try {
      if (!isExtensionProtocol(this.protocol)) throw new ShoppingError('UNSUPPORTED_CAPABILITY', 'Price inputs are filled only through the declared extension backend.');
      requirePriceRange(minimum, maximum);
      const script = jdPriceRangePanelScript(target);
      await this.requireConnected();
      await this.#requireJdSearchTab(tabId, target);
      const panel = validateJdPriceRangePanel((await this.#command('eval', { tabId: id, script }))?.result);
      // Placeholders become a CSS selector, so only short CJK words are accepted (2026-10-22: 最低价, 最高价).
      if (panel.open !== 1 || panel.inputs.length !== 2 || panel.inputs[0].placeholder === panel.inputs[1].placeholder ||
          panel.inputs.some(input => !input.unique || !/^[\u4e00-\u9fa5]{1,6}$/.test(input.placeholder))) {
        throw new ShoppingError('SEARCH_PRICE_RANGE_UNAVAILABLE', 'The price range dropdown is not open with two inputs; nothing was typed.', 'Open the search page again and start a new task.');
      }
      if (panel.inputs.some(input => input.value !== '')) {
        throw new ShoppingError('SEARCH_PRICE_RANGE_NOT_EMPTY', 'A price range input already holds text; nothing was typed.', 'Open the search page again and start a new task.');
      }
      fields = [[panel.inputs[0].placeholder, String(minimum)], [panel.inputs[1].placeholder, String(maximum)]];
      first = await reference(fields[0][0]);
    } catch (error) { error.actionNotDispatched = true; throw error; }
    for (const [index, [placeholder, text]] of fields.entries()) {
      const ref = index === 0 ? first : await reference(placeholder);
      const data = await this.#command('fill', { tabId: id, ref, text });
      if (data?.role !== 'textbox' || data?.name !== placeholder || data?.filledText !== text) {
        throw new ShoppingError('INVALID_RESPONSE', 'The fill acknowledgement did not match the requested bound.');
      }
    }
    return { filled: true };
  }

  /**
   * Click 确定 once in the open 价格区间 dropdown, only when both inputs hold the requested bounds. Paced as a search load:
   * it refilters the results in place (2026-10-22). Refusals are marked actionNotDispatched; other errors leave it uncertain.
   * @param {number} tabId @param {object} target Canonical JD search target. @param {number} minimum @param {number} maximum
   * @returns {Promise<{clicked: true}>}
   * @throws {ShoppingError} SEARCH_PRICE_RANGE_NOT_FILLED, SEARCH_PRICE_RANGE_UNAVAILABLE, identity, gate or transport errors; never retried here.
   */
  async confirmJdPriceRange(tabId, target, minimum, maximum) {
    let script;
    try {
      script = jdPriceRangeConfirmScript(target, minimum, maximum);
      await this.requireConnected();
      await this.#requireJdSearchTab(tabId, target);
    } catch (error) { error.actionNotDispatched = true; throw error; }
    return validateJdPriceRangeConfirm((await this.#command('eval', { tabId: parseTabId(tabId), script }))?.result);
  }

  async #requireJdSearchTab(tabId, target) {
    const url = await savedTabUrl(this, tabId, 'The saved JD search page is neither listed nor reachable by its ID.');
    if (parseJdSearchUrl(url)?.query === target.query) return;
    const landing = jdLandingKind(url);
    throwPageError(landing === 'login_page' ? 'login_required' : landing === 'risk_page' ? 'rate_limited' : 'target_changed');
  }

  /**
   * Read the loaded JD cart rows; never clicks, scrolls or navigates.
   * Failures before the page script runs are marked actionNotDispatched.
   * @param {number} tabId @param {{platform: 'jd', url: string}} target Canonical JD cart target.
   * @returns {Promise<object>} Validated cart result.
   * @throws {ShoppingError} TARGET_MISSING, TARGET_CHANGED, LOGIN_REQUIRED or RATE_LIMITED from the tab address, page gates or INVALID_RESPONSE.
   * @example await bridge.readJdCart(88, parseJdCartUrl('https://cart.jd.com/cart_index'));
   */
  async readJdCart(tabId, target) {
    let script;
    try {
      script = jdCartScript(target);
      await this.requireConnected();
      const url = await savedTabUrl(this, tabId, 'The saved JD cart page is neither listed nor reachable by its ID.');
      if (parseJdCartUrl(url)?.url !== target.url) {
        const landing = jdLandingKind(url);
        throwPageError(landing === 'login_page' ? 'login_required' : landing === 'risk_page' ? 'rate_limited' : 'target_changed');
      }
    } catch (error) { error.actionNotDispatched = true; throw error; }
    const data = await this.#command('eval', { tabId: parseTabId(tabId), script });
    return validateJdCart(data?.result, target);
  }

  /**
   * Read the loaded JD order cards; never clicks, scrolls or navigates.
   * Failures before the page script runs are marked actionNotDispatched.
   * @param {number} tabId @param {{platform: 'jd', url: string}} target Canonical JD order list target.
   * @returns {Promise<object>} Validated order list result.
   * @throws {ShoppingError} TARGET_MISSING, TARGET_CHANGED, LOGIN_REQUIRED or RATE_LIMITED from the tab address, page gates or INVALID_RESPONSE.
   * @example await bridge.readJdOrders(88, parseJdOrderListUrl('https://order.jd.com/center/list.action'));
   */
  async readJdOrders(tabId, target) {
    let script;
    try {
      script = jdOrdersScript(target);
      await this.requireConnected();
      const url = await savedTabUrl(this, tabId, 'The saved JD order list page is neither listed nor reachable by its ID.');
      if (parseJdOrderListUrl(url)?.url !== target.url) {
        const landing = jdLandingKind(url);
        throwPageError(landing === 'login_page' ? 'login_required' : landing === 'risk_page' ? 'rate_limited' : 'target_changed');
      }
    } catch (error) { error.actionNotDispatched = true; throw error; }
    const data = await this.#command('eval', { tabId: parseTabId(tabId), script });
    return validateJdOrders(data?.result, target);
  }

  /**
   * Click 订单详情 once on the loaded order card at one position, after the page confirms the card still shows orderId.
   * Paced as a page load: the click makes JD open the order's detail page in a new tab. Refusals and failures before the
   * page script runs are marked actionNotDispatched; any other error leaves the click uncertain.
   * @param {number} tabId Order list tab. @param {{platform: 'jd', url: string}} target Canonical order list target.
   * @param {number} position 1-10. @param {string} orderId @returns {Promise<{clicked: true}>}
   * @throws {ShoppingError} Identity, gate or refusal errors (not dispatched), or transport errors after dispatch; never retried here.
   * @example await bridge.clickJdOrderDetail(89, parseJdOrderListUrl('https://order.jd.com/center/list.action'), 1, '123456789012');
   */
  async clickJdOrderDetail(tabId, target, position, orderId) {
    let script;
    try {
      script = jdOrderDetailClickScript(target, position, orderId);
      await this.requireConnected();
      const url = await savedTabUrl(this, tabId, 'The saved JD order list page is neither listed nor reachable by its ID.');
      if (parseJdOrderListUrl(url)?.url !== target.url) {
        const landing = jdLandingKind(url);
        throwPageError(landing === 'login_page' ? 'login_required' : landing === 'risk_page' ? 'rate_limited' : 'target_changed');
      }
    } catch (error) { error.actionNotDispatched = true; throw error; }
    const data = await this.#command('eval', { tabId: parseTabId(tabId), script });
    return validateJdOrderDetailClick(data?.result);
  }

  /**
   * Read one JD order detail tab for orderId; never clicks, scrolls or switches its tabs. The tab address is checked by
   * order id only: its PassKey is neither read back nor kept.
   * @param {number} tabId Detail tab. @param {string} orderId
   * @returns {Promise<{observed_at: string, raw: object}>} The validated raw observation, kept so a saved result can be rebuilt.
   * @throws {ShoppingError} TARGET_MISSING, TARGET_CHANGED, LOGIN_REQUIRED or RATE_LIMITED from the tab address, page gates or INVALID_RESPONSE.
   * Failures before the page script runs are marked actionNotDispatched.
   * @example await bridge.readJdOrderDetail(90, '123456789012');
   */
  async readJdOrderDetail(tabId, orderId) {
    let script;
    try {
      script = jdOrderDetailScript(orderId);
      await this.requireConnected();
      const url = await savedTabUrl(this, tabId, 'The JD order detail page is neither listed nor reachable by its ID.');
      if (parseJdOrderDetailUrl(url)?.order_id !== orderId) {
        const landing = jdLandingKind(url);
        throwPageError(landing === 'login_page' ? 'login_required' : landing === 'risk_page' ? 'rate_limited' : 'target_changed');
      }
    } catch (error) { error.actionNotDispatched = true; throw error; }
    const data = await this.#command('eval', { tabId: parseTabId(tabId), script });
    const observedAt = new Date().toISOString();
    validateJdOrderDetail(data?.result, orderId, { observedAt });
    return { observed_at: observedAt, raw: data.result };
  }

  /**
   * Close the JD order detail tab a task opened, after confirming it still shows orderId. Not paced: nothing is sent to JD.
   * @param {number} tabId @param {string} orderId @returns {Promise<{closed: true}>}
   * @throws {ShoppingError} As closeTab.
   */
  async closeJdOrderDetailTab(tabId, orderId) {
    return this.closeTab(tabId, url => parseJdOrderDetailUrl(url)?.order_id === orderId);
  }

  /**
   * Read one bound JD product page: the right panel and the current state of its 商品详情 section; never clicks or scrolls.
   * @param {number} tabId @param {object} target Canonical JD product target.
   * @returns {Promise<{observed_at: string, raw: object}>} The validated raw observation, kept so a saved result can be rebuilt.
   * @throws {ShoppingError} TARGET_MISSING, TARGET_CHANGED, LOGIN_REQUIRED or RATE_LIMITED from the tab address, page gates or INVALID_RESPONSE.
   * @example await bridge.readJdProduct(88, parseJdProductUrl('https://item.jd.com/3290995.html'));
   */
  async readJdProduct(tabId, target) {
    const script = jdProductScript(target);
    await this.requireConnected();
    await this.#requireJdProductTab(tabId, target);
    const data = await this.#command('eval', { tabId: parseTabId(tabId), script }, MAX_RESPONSE_BYTES);
    validateJdProductObservation(data?.result, target);
    return { observed_at: new Date().toISOString(), raw: data.result };
  }

  /**
   * Scroll the bound JD product page once so its 商品详情 title is at the top. Errors raised before the page script ran,
   * or reported by it instead of scrolling, are marked actionNotDispatched; any other error leaves the scroll uncertain.
   * @param {number} tabId @param {object} target @returns {Promise<{scroll_y_before: number, scroll_y_after: number}>}
   * @throws {ShoppingError} Identity or gate errors (not dispatched), or transport errors after dispatch; never retried here.
   * @example await bridge.scrollJdDetails(88, target);
   */
  async scrollJdDetails(tabId, target) {
    let script;
    try {
      script = jdDetailScrollScript(target);
      await this.requireConnected();
      await this.#requireJdProductTab(tabId, target);
    } catch (error) { error.actionNotDispatched = true; throw error; }
    const data = await this.#command('eval', { tabId: parseTabId(tabId), script });
    try { return validateJdDetailScroll(data?.result); }
    catch (error) { if (data?.result?.state && data.result.state !== 'scrolled') error.actionNotDispatched = true; throw error; }
  }

  /**
   * Read the bound JD product's 全部评价 overlay without clicking. A hidden document is still a successful read.
   * @param {number} tabId @param {object} target Canonical JD product target.
   * @returns {Promise<{observed_at: string, raw: object}>} The validated observation.
   * @throws {ShoppingError} Identity or gate errors. Failures before the page script runs are marked actionNotDispatched.
   * @example await bridge.readJdReviewCategories(88, parseJdProductUrl('https://item.jd.com/3290995.html'));
   */
  async readJdReviewCategories(tabId, target) {
    let script;
    try {
      script = jdReviewReadScript(target);
      await this.requireConnected();
      await this.#requireJdProductTab(tabId, target);
    } catch (error) { error.actionNotDispatched = true; throw error; }
    const data = await this.#command('eval', { tabId: parseTabId(tabId), script }, MAX_RESPONSE_BYTES);
    validateJdReviewObservation(data?.result);
    return { observed_at: new Date().toISOString(), raw: data.result };
  }

  /**
   * Click 全部评价 once. A refusal or a failure before the page script runs is marked actionNotDispatched.
   * @param {number} tabId @param {object} target @returns {Promise<{clicked: true}>}
   * @throws {ShoppingError} Not dispatched when the click did not happen; transport errors after dispatch stay uncertain.
   * @example await bridge.openJdReviewPanel(88, target);
   */
  async openJdReviewPanel(tabId, target) {
    return this.#jdReviewClick(tabId, target, () => jdReviewOpenScript(target), validateJdReviewOpen);
  }

  /**
   * Click one category tag once. An invalid label is refused before the page script is sent.
   * @param {number} tabId @param {object} target @param {string} name Exact tag name.
   * @returns {Promise<{clicked: true}>}
   * @throws {ShoppingError} Not dispatched when the click did not happen.
   * @example await bridge.selectJdReviewCategory(88, target, '好评');
   */
  async selectJdReviewCategory(tabId, target, name) {
    return this.#jdReviewClick(tabId, target, () => jdReviewSelectScript(target, name), validateJdReviewSelect);
  }

  /**
   * Click the overlay's close control once. The page may be hidden; the script does not require it to be visible.
   * @param {number} tabId @param {object} target @returns {Promise<{clicked: true}>}
   * @throws {ShoppingError} Not dispatched when the click did not happen.
   * @example await bridge.closeJdReviewPanel(88, target);
   */
  async closeJdReviewPanel(tabId, target) {
    return this.#jdReviewClick(tabId, target, () => jdReviewCloseScript(target), validateJdReviewClose);
  }

  async #jdReviewClick(tabId, target, build, validate) {
    let script;
    try {
      script = build();
      await this.requireConnected();
      await this.#requireJdProductTab(tabId, target);
    } catch (error) { error.actionNotDispatched = true; throw error; }
    const data = await this.#command('eval', { tabId: parseTabId(tabId), script });
    try { return validate(data?.result); }
    catch (error) { if (data?.result?.state && data.result.state !== 'clicked') error.actionNotDispatched = true; throw error; }
  }

  async #requireJdProductTab(tabId, target) {
    const url = await savedTabUrl(this, tabId, 'The saved JD product page is neither listed nor reachable by its ID.');
    if (parseJdProductUrl(url)?.product_id !== target.product_id) {
      const landing = jdLandingKind(url);
      throwPageError(landing === 'login_page' ? 'login_required' : landing === 'risk_page' ? 'rate_limited' : 'target_changed');
    }
  }

  async #openTab(url, kind, matches, describeLanding = null) {
    try {
      if (!isExtensionProtocol(this.protocol)) throw new ShoppingError('UNSUPPORTED_CAPABILITY', 'Opening pages is implemented only for the declared extension backend.');
      await this.requireConnected();
    } catch (error) { error.actionNotDispatched = true; throw error; }
    // tab_new waits for the page load, so it needs more than the ordinary command deadline.
    const data = await this.#command('tab_new', { url }, MAX_RESPONSE_BYTES, Math.max(this.timeoutMs, TAB_OPEN_TIMEOUT_MS));
    let tabId;
    try { tabId = parseTabId(data?.tabId); } catch { throw new ShoppingError('INVALID_RESPONSE', 'The new tab acknowledgement has no valid tab ID.'); }
    const urlMatches = typeof data.url === 'string' && matches(data.url);
    return { tab_id: tabId, kind, url_matches: urlMatches, ...(describeLanding ? { landing: describeLanding(data.url, urlMatches) } : {}) };
  }

  /**
   * Close one tab after confirming it is listed and still shows the expected page; the tab ID is always sent explicitly.
   * @param {number} tabId @param {(url: string) => boolean} matches Address check for the page that was opened.
   * @returns {Promise<{closed: true}>}
   * @throws {ShoppingError} TARGET_MISSING or TAB_ADDRESS_CHANGED (both undispatched), or BROWSER_COMMAND_FAILED when the tab stays listed.
   */
  async closeTab(tabId, matches) {
    const id = parseTabId(tabId);
    try {
      if (!isExtensionProtocol(this.protocol)) throw new ShoppingError('UNSUPPORTED_CAPABILITY', 'Closing pages is implemented only for the declared extension backend.');
      await this.requireConnected();
      const url = await savedTabUrl(this, id, 'The tab is neither listed nor reachable; it may already be closed. Nothing was closed.');
      if (!matches(url)) throw new ShoppingError('TAB_ADDRESS_CHANGED', 'The tab no longer shows the page that was opened; nothing was closed.', 'Leave it open, or close it yourself after checking it.');
    } catch (error) { error.actionNotDispatched = true; throw error; }
    // Without tabId the extension closes the current tab, so the ID is never omitted.
    await this.#command('tab_close', { tabId: id });
    if ((await this.listTabs()).some(item => item.id === id) || await this.readTabAddress(id) !== null) {
      throw new ShoppingError('BROWSER_COMMAND_FAILED', 'The browser acknowledged the close but the tab still exists.', 'Check tabs before trying again.');
    }
    return { closed: true };
  }

  async #requireSearchFirstPage(tabId, target, views = [{ page: 1, source: 'all' }]) {
    await this.requireConnected();
    const url = await savedTabUrl(this, tabId, 'The saved search page is neither listed nor reachable by its ID.');
    // Applying a price sort or range keeps the original URL; later pages change only its page parameter and 天猫 only its
    // tab parameter, so the URL alone never proves the applied state.
    if (!matchesPriceView(url, target, views)) {
      let hostname;
      try { hostname = new URL(url).hostname; } catch { /* Unknown URLs fail identity validation. */ }
      if (['login.taobao.com', 'login.tmall.com'].includes(hostname)) throw new ShoppingError('LOGIN_REQUIRED', 'The search tab moved to login.');
      throw new ShoppingError('TARGET_CHANGED', 'The tab no longer shows the saved first search page.');
    }
  }

  /** @param {number} tabId @param {object} target @returns {Promise<object>} Validated first-page cards and price control state. @throws {ShoppingError} Identity, gate or layout failure; no retries or actions. */
  async readSearchPrice(tabId, target, page = 1, { allowPrevious = false, source = 'all', previousSource = null, cardLimit = SEARCH_RANGE_CARD_LIMIT } = {}) {
    const script = searchPriceScript(target, page, { allowPrevious, source, previousSource, cardLimit });
    await this.#requireSearchFirstPage(tabId, target, [{ page, source }, ...(allowPrevious && page > 1 ? [{ page: page - 1, source }] : []),
      ...(previousSource ? [{ page, source: previousSource }] : [])]);
    const data = await this.#command('eval', { tabId, script });
    return validateSearchPriceObservation(data?.result, target, page, { allowPrevious, source, previousSource, cardLimit });
  }

  /**
   * Click 下一页 once from a confirmed price result page, guarded by its page number and saved card order.
   * @param {number} tabId @param {object} target @param {{page: number, product_ids: string[]}} from The confirmed current page.
   * @param {{cardLimit?: number}} [options] The cards per observation the confirmed page was read with.
   * @returns {Promise<{clicked: true}>}
   * @throws {ShoppingError} LAST_PAGE_REACHED and other preparation failures are marked undispatched; uncertain replies must not repeat.
   */
  async nextPricePage(tabId, target, from, { cardLimit = SEARCH_RANGE_CARD_LIMIT } = {}) {
    let script;
    try {
      script = nextPricePageScript(target, from, { cardLimit });
      await this.#requireSearchFirstPage(tabId, target, [{ page: from.page, source: from.source ?? 'all' }]);
    } catch (error) { error.actionNotDispatched = true; throw error; }
    return validateNextPriceAcknowledgement((await this.#command('eval', { tabId, script }))?.result);
  }

  /**
   * Move the real pointer onto one fixed sort-bar tab (综合, 价格 or 区间) through a freshly scoped reference.
   * @param {number} tabId @param {object} target @param {string} label @param {number} [page=1] The result page the tab is on.
   * @returns {Promise<{hovered: true}>} Acknowledgement only; the caller observes any overlay.
   * @throws {ShoppingError} Preparation failures are marked undispatched; pointer errors are uncertain and must not repeat.
   */
  async hoverPriceTab(tabId, target, label, page = 1, source = 'all') {
    let ref;
    try {
      if (!isExtensionProtocol(this.protocol)) throw new ShoppingError('UNSUPPORTED_CAPABILITY', 'Price controls are implemented only for the declared extension backend.');
      const script = priceTabSelectorScript(target, label, page, source);
      const prepare = async () => {
        await this.#requireSearchFirstPage(tabId, target, [{ page, source }]);
        return validatePriceTabSelector((await this.#command('eval', { tabId, script }))?.result);
      };
      const selector = await prepare();
      ref = validatePriceReference(await this.#command('snapshot', { tabId, selector, interactive: true, compact: true, maxDepth: 3 }), target, 'tab', label, page, source);
      if (await prepare() !== selector) throw new ShoppingError('TARGET_CHANGED', 'The sort-bar tab changed while preparing its pointer reference.');
    } catch (error) { error.actionNotDispatched = true; throw error; }
    const data = await this.#command('hover', { tabId, ref }, MAX_RESPONSE_BYTES, Math.max(this.timeoutMs, POINTER_TIMEOUT_MS));
    if (data?.role !== 'tab' || data?.name !== label) throw new ShoppingError('INVALID_RESPONSE', 'The pointer acknowledgement did not identify the requested tab.');
    return { hovered: true };
  }

  /**
   * Click the 天猫 source tab once on the 所有宝贝 first page. 天猫 clears any selected filters (live 2026-10-13), so it comes first.
   * @param {number} tabId @param {object} target @param {'tmall'} source @returns {Promise<{clicked: true}>}
   * @throws {ShoppingError} Certain non-dispatch is marked; uncertain replies must not repeat.
   */
  async pickSearchSource(tabId, target, source) {
    let script;
    try {
      script = pickSourceScript(target, source);
      await this.#requireSearchFirstPage(tabId, target, [{ page: 1, source: 'all' }]);
    } catch (error) { error.actionNotDispatched = true; throw error; }
    return validatePriceClickAcknowledgement((await this.#command('eval', { tabId, script }))?.result);
  }

  /**
   * Click one supported filter-strip item (包邮) once on the first page of the current source.
   * @param {number} tabId @param {object} target @param {string} label @param {'all'|'tmall'} [source='all'] @returns {Promise<{clicked: true}>}
   * @throws {ShoppingError} Certain non-dispatch is marked; uncertain replies must not repeat.
   */
  async pickSearchFilter(tabId, target, label, source = 'all') {
    let script;
    try {
      script = pickFilterScript(target, label, source);
      await this.#requireSearchFirstPage(tabId, target, [{ page: 1, source }]);
    } catch (error) { error.actionNotDispatched = true; throw error; }
    return validatePriceClickAcknowledgement((await this.#command('eval', { tabId, script }))?.result);
  }

  /** @param {number} tabId @param {object} target @param {string} label @returns {Promise<{clicked: true}>} One guarded option click. @throws {ShoppingError} Certain non-dispatch is marked; uncertain replies must not repeat. */
  async pickPriceDirection(tabId, target, label, source = 'all') {
    let script;
    try {
      script = pickPriceDirectionScript(target, label, source);
      await this.#requireSearchFirstPage(tabId, target, [{ page: 1, source }]);
    } catch (error) { error.actionNotDispatched = true; throw error; }
    return validatePriceClickAcknowledgement((await this.#command('eval', { tabId, script }))?.result);
  }

  /**
   * Type the requested CNY bounds into the open range panel, one right after the other, each through a fresh scoped textbox reference.
   * The panel must be open and the requested inputs empty before anything is typed.
   * @param {number} tabId @param {object} target @param {{field: 'minimum'|'maximum', text: string}[]} fields One or two bounds, minimum first.
   * @returns {Promise<{filled: true}>}
   * @throws {ShoppingError} PRICE_CONTROL_UNAVAILABLE (panel closed) and other preparation failures are marked undispatched;
   *   a failure after the first bound was typed is left uncertain.
   */
  async fillPriceRange(tabId, target, fields, source = 'all') {
    const reference = async (field) => {
      const placeholder = PRICE_BOUND_PLACEHOLDERS[field];
      const data = await this.#command('snapshot', { tabId, selector: `input[placeholder="${placeholder}"]`, interactive: true, compact: true, maxDepth: 1 });
      return { ref: validatePriceReference(data, target, 'textbox', placeholder, 1, source), placeholder };
    };
    let first;
    try {
      if (!isExtensionProtocol(this.protocol)) throw new ShoppingError('UNSUPPORTED_CAPABILITY', 'Price controls are implemented only for the declared extension backend.');
      if (!Array.isArray(fields) || fields.length < 1 || fields.length > 2 || fields.some(({ field, text } = {}) => !Object.hasOwn(PRICE_BOUND_PLACEHOLDERS, field) ||
          typeof text !== 'string' || !/^(0|[1-9][0-9]{0,8})(\.[0-9]{1,2})?$/.test(text)) ||
          (fields.length === 2 && (fields[0].field !== 'minimum' || fields[1].field !== 'maximum'))) {
        throw new ShoppingError('INVALID_ARGUMENTS', 'Only one or two plain CNY decimals can be typed into the fixed range inputs.');
      }
      await this.#requireSearchFirstPage(tabId, target, [{ page: 1, source }]);
      const controls = validatePriceControlsReply((await this.#command('eval', { tabId, script: priceControlsScript(target, source) }))?.result);
      if (!controls.range_panel) throw new ShoppingError('PRICE_CONTROL_UNAVAILABLE', 'The range panel is closed; nothing was typed.');
      if (fields.some(({ field }) => controls.range_panel[`${field}_text`] !== '')) {
        throw new ShoppingError('PRICE_CONTROL_NOT_CONFIRMED', 'A range input already holds text; nothing was typed.');
      }
      first = await reference(fields[0].field);
    } catch (error) { error.actionNotDispatched = true; throw error; }
    for (const [index, { field, text }] of fields.entries()) {
      const { ref, placeholder } = index === 0 ? first : await reference(field);
      const data = await this.#command('fill', { tabId, ref, text });
      if (data?.role !== 'textbox' || data?.name !== placeholder || data?.filledText !== text) throw new ShoppingError('INVALID_RESPONSE', 'The fill acknowledgement did not match the requested bound.');
    }
    return { filled: true };
  }

  /** @param {number} tabId @param {object} target @returns {Promise<{clicked: true}>} One guarded click on the open range panel's 确定. @throws {ShoppingError} Certain non-dispatch is marked. */
  async confirmPriceRange(tabId, target, source = 'all') {
    let script;
    try {
      script = confirmPriceRangeScript(target, source);
      await this.#requireSearchFirstPage(tabId, target, [{ page: 1, source }]);
    } catch (error) { error.actionNotDispatched = true; throw error; }
    return validatePriceClickAcknowledgement((await this.#command('eval', { tabId, script }))?.result);
  }

  /** @param {number} tabId @param {object} target @returns {Promise<object>} Read-only scoped controls and partial cards. @throws {ShoppingError} Identity, gate or response failure; no actions or retries. */
  async readSearchControls(tabId, target) {
    const script = searchControlsScript(target);
    await this.#requireSortableSearch(tabId, target, true);
    const data = await this.#command('eval', { tabId, script });
    return validateSearchControls(data?.result, target);
  }

  /** @param {number} tabId @param {object} target @param {{hover?: boolean}} options @returns {Promise<object>} Bounded price-entry observation. @throws {ShoppingError} Connection, gate or schema failure; no retries. */
  async readPriceEntry(tabId, target, options = {}) {
    return validatePriceEntry(await this.inspectPriceEntry(tabId, target, options), target, options);
  }

  /** @param {number} tabId @param {object} target @returns {Promise<object>} Raw bounded local layout, charged to the caller's original observation budget. @throws {ShoppingError} Identity or protocol errors; no actions or retries. */
  async inspectPriceRegion(tabId, target) {
    const script = priceRegionScript(target);
    await this.#requireSortableSearch(tabId, target, true);
    const data = await this.#command('eval', { tabId, script });
    if (!data?.result || typeof data.result.state !== 'string') throw new ShoppingError('INVALID_RESPONSE', 'Invalid price-region observation.');
    return data.result;
  }

  /** @param {number} tabId @param {object} target @param {{hover?: boolean}} options @returns {Promise<object>} Fixed bounded raw evidence for a diagnostic read already charged to its task. @throws {ShoppingError} Identity or protocol errors; no retries or extra DOM read. */
  async inspectPriceEntry(tabId, target, options = {}) {
    const script = priceEntryScript(target, undefined, options);
    await this.#requireSortableSearch(tabId, target, true);
    const data = await this.#command('eval', { tabId, script });
    if (!data?.result || typeof data.result.state !== 'string') throw new ShoppingError('INVALID_RESPONSE', 'The price-entry response is not an observation.');
    return data.result;
  }

  /** @param {number} tabId @param {object} target @param {object} before @returns {Promise<object>} Fixed read-only hover guard and bounded sibling layout, charged to the original reference-read reservation. @throws {ShoppingError} Identity or protocol errors; never dispatches an action. */
  async inspectPriceHoverPreparation(tabId, target, before) {
    const script = priceEntryScript(target, before, { hover: true });
    await this.#requireSortableSearch(tabId, target, true);
    const data = await this.#command('eval', { tabId, script });
    if (!data?.result || typeof data.result.state !== 'string') throw new ShoppingError('INVALID_RESPONSE', 'Invalid hover preparation response.');
    return data.result;
  }

  /**
   * Move the pointer once using a fresh scoped reference; the backend may scroll the entry into view.
   * @param {number} tabId @param {object} target @param {object} before A saved hover-mode snapshot.
   * @returns {Promise<object>} Dispatch acknowledgement only; no direction or menu ownership assertion.
   * @throws {ShoppingError} Preparation failures are undispatched; hover errors are uncertain and must not replay.
   */
  async hoverPriceEntry(tabId, target, before) {
    let ref;
    try {
      if (!isExtensionProtocol(this.protocol)) throw new ShoppingError('UNSUPPORTED_CAPABILITY', 'Price hover is implemented only for the declared extension backend.');
      const prepare = async () => {
        const value = await this.inspectPriceHoverPreparation(tabId, target, before);
        throwPageError(value.state);
        return validateHoverPreparation(value);
      };
      const selector = await prepare();
      const data = await this.#command('snapshot', { tabId, selector, interactive: true, compact: true, maxDepth: 3 });
      ref = validatePriceHoverReference(data, before);
      if (await prepare() !== selector) throw new ShoppingError('TARGET_CHANGED', 'The price entry changed while preparing its pointer reference.');
    } catch (error) { error.actionNotDispatched = true; throw error; }
    const data = await this.#command('hover', { tabId, ref });
    if (data?.role !== 'tab' || data?.name !== '价格') throw new ShoppingError('INVALID_RESPONSE', 'The hover acknowledgement did not identify the price tab.');
    return { hovered: true };
  }

  /** @param {number} tabId @param {object} target @param {object} before @returns {Promise<object>} One guarded price-tab click acknowledgement. @throws {ShoppingError} Pre-dispatch failures are marked; uncertain dispatches must not repeat. */
  async openPriceEntry(tabId, target, before) {
    let script;
    try {
      script = priceEntryScript(target, before);
      await this.#requireSortableSearch(tabId, target, true);
    } catch (error) { error.actionNotDispatched = true; throw error; }
    const data = await this.#command('eval', { tabId, script });
    return validateReadActionAcknowledgement(data?.result);
  }

  /** @param {number} tabId @param {object} target @param {boolean} dispatched @returns {Promise<object>} Fixed bounded evidence for an explicitly budgeted diagnostic read. @throws {ShoppingError} Connection or protocol errors. */
  async inspectSearchSort(tabId, target, dispatched) {
    const script = searchSortDiagnosticScript(target, dispatched);
    await this.#requireSortableSearch(tabId, target, dispatched);
    const data = await this.#command('eval', { tabId, script });
    if (!data?.result?.observation || typeof data.result.observation.state !== 'string' || !Object.hasOwn(data.result, 'layout')) {
      throw new ShoppingError('INVALID_RESPONSE', 'The sort diagnostic response is invalid.');
    }
    return data.result;
  }

  /** @param {number} tabId @param {object} target @param {object} before @returns {Promise<object>} Dispatch acknowledgement only. @throws {ShoppingError} Guard or uncertain command failure; never retries. */
  async selectSalesSort(tabId, target, before) {
    let script;
    try {
      script = searchSortScript(target, { before });
      await this.#requireSortableSearch(tabId, target, false);
    } catch (error) { error.actionNotDispatched = true; throw error; }
    const data = await this.#command('eval', { tabId, script });
    return validateReadActionAcknowledgement(data?.result);
  }

  async #requireTarget(tabId, target, search = false) {
    await this.requireConnected();
    const tab = (await this.listTabs()).find(item => item.id === parseTabId(tabId));
    if (!tab) throw new ShoppingError('TARGET_MISSING', 'The task tab is not in the selected browser inventory.', 'Diagnose the original target and connection before resuming.');
    const matches = search ? isSearchHome(tab.url) || parseSearchUrl(tab.url)?.url === target.url : parseProductUrl(tab.url)?.url === target.url;
    if (!matches) {
      let hostname;
      try { hostname = new URL(tab.url).hostname; } catch { /* Unknown URLs fail identity validation. */ }
      if (['login.taobao.com', 'login.tmall.com'].includes(hostname)) {
        throw new ShoppingError('LOGIN_REQUIRED', 'The bound tab has moved to the platform login page.');
      }
      throw new ShoppingError('TARGET_CHANGED', 'The task tab no longer shows its expected public target.');
    }
  }

  /**
   * Select one known product option; the task layer must persist intent and verify outcome.
   * @param {number} tabId @param {{url: string}} target @param {{group: string, option: string}} choice
   * @returns {Promise<{clicked: boolean}>} Dispatch acknowledgement, not proof of selection or price.
   * @throws {ShoppingError} Pre-dispatch guards or uncertain command failures. Never retries.
   */
  async selectOption(tabId, target, choice) {
    const script = selectionScript(target, choice);
    try { await this.#requireProductTarget(tabId, target); }
    catch (error) { error.actionNotDispatched = true; throw error; }
    const data = await this.#command('eval', { tabId, script });
    return validateSelectionAcknowledgement(data?.result, choice);
  }

  /**
   * Open the observed service entry at most once; callers must persist intent and observe the result.
   * @param {number} tabId @param {object} target @param {string[]} labels Exact saved service labels.
   * @returns {Promise<{clicked: boolean}>} Dispatch acknowledgement; false if already expanded.
   * @throws {ShoppingError} Target or page guards marked undispatched, or uncertain transport errors. Never retries.
   * @example bridge.expandServices(tabId, target, ['7天无理由退货']);
   */
  async expandServices(tabId, target, labels) {
    let script;
    try {
      script = serviceEntryScript(target, labels, true);
      await this.#requireProductTarget(tabId, target);
    } catch (error) { error.actionNotDispatched = true; throw error; }
    const data = await this.#command('eval', { tabId, script });
    return validateReadActionAcknowledgement(data?.result);
  }

  async #readRegion(tabId, target, script, validate, search = false, maximumBytes = MAX_RESPONSE_BYTES) {
    await this.#requireTarget(tabId, target, search);
    const data = await this.#command('eval', { tabId, script }, maximumBytes);
    return validate(data?.result, target);
  }

  async #readingAction(tabId, target, script, search = false) {
    try { await this.#requireTarget(tabId, target, search); }
    catch (error) { error.actionNotDispatched = true; throw error; }
    const data = await this.#command('eval', { tabId, script });
    return validateReadActionAcknowledgement(data?.result);
  }

  /**
   * Read the first page, checking the exact saved address if the extension's current-window list omits it.
   * @param {number} tabId @param {object} target
   * @returns {Promise<object>} First-page cards or navigation-needed state; this method never navigates.
   * @throws {ShoppingError} Identity, gate, connection or response errors; no retries.
   * @example await bridge.readSearch(tabId, searchTarget('books'));
   */
  async readSearch(tabId, target) {
    const script = searchScript(target);
    try { await this.#requireTarget(tabId, target, true); }
    catch (error) {
      if (error.code !== 'TARGET_MISSING' || !isExtensionProtocol(this.protocol)) throw error;
      // Reuse the location-only query probe, then enforce the stricter first-page identity before reading.
      const actual = await this.probeSortTarget(tabId, target, false);
      if (actual.url !== target.url) throw new ShoppingError('TARGET_CHANGED', 'Restore the original first-page search before reading.');
    }
    const data = await this.#command('eval', { tabId, script });
    return validateSearch(data?.result, target);
  }

  /** @param {number} tabId @param {object} target @returns {Promise<object>} Acknowledgement only; the caller must persist intent first. @throws {ShoppingError} A pre-dispatch guard or uncertain dispatch failure. */
  async navigateSearch(tabId, target) {
    return this.#readingAction(tabId, target, searchScript(target, true), true);
  }

  /** @param {number} tabId @param {object} target @returns {Promise<object>} Review panel state and bounded observations. @throws {ShoppingError} Identity, gate, connection or response errors; no retries. */
  async readReviews(tabId, target) {
    const script = reviewsScript(target);
    await this.#requireProductTarget(tabId, target);
    const data = await this.#command('eval', { tabId, script }, 1048576);
    return validateReviews(data?.result, target);
  }

  /** @param {number} tabId @param {object} target @returns {Promise<object>} Ten text-only review positions and actual category markers. @throws {ShoppingError} Identity, visibility, gate or schema errors; no retries. */
  async readReviewCategories(tabId, target) {
    const script = reviewCategoriesScript(target);
    await this.#requireProductTarget(tabId, target);
    const data = await this.#command('eval', { tabId, script }, 1048576);
    return validateReviewCategoryObservation(data?.result, target);
  }

  /** @param {number} tabId @param {object} target @returns {Promise<object>} One guarded scroll/open acknowledgement; caller reserves it before IO. @throws {ShoppingError} Identity, entry or gate failures; uncertain commands are never retried here. */
  async openReviewPanel(tabId, target) {
    let script;
    try {
      script = reviewPanelScript(target, true);
      await this.#requireProductTarget(tabId, target);
    } catch (error) { error.actionNotDispatched = true; throw error; }
    const data = await this.#command('eval', { tabId, script });
    return validateReadActionAcknowledgement(data?.result);
  }

  /** @param {number} tabId @param {object} target @returns {Promise<{state: 'open'|'closed'}>} Actual panel visibility without review/media extraction. @throws {ShoppingError} Target, gate or structure failures; no retry. @example await bridge.readReviewPanelState(41, target); */
  async readReviewPanelState(tabId, target) {
    const script = reviewPanelScript(target);
    await this.#requireProductTarget(tabId, target);
    const data = await this.#command('eval', { tabId, script });
    return validateReviewPanelState(data?.result);
  }

  /** @param {number} tabId @param {object} target @returns {Promise<{clicked: boolean}>} Single normal close acknowledgement, not proof of restoration. Caller reserves intent and owns the panel or holds recovery authority. @throws {ShoppingError} Guard or uncertain dispatch failure; never replayed here. @example await bridge.closeReviewPanel(41, target); */
  async closeReviewPanel(tabId, target) {
    let script;
    try {
      script = reviewPanelCloseScript(target);
      await this.#requireProductTarget(tabId, target);
    } catch (error) { error.actionNotDispatched = true; throw error; }
    const data = await this.#command('eval', { tabId, script });
    return validateReadActionAcknowledgement(data?.result);
  }

  /** @param {number} tabId @param {object} target @param {object} before @param {string} label @returns {Promise<object>} One guarded category click acknowledgement; caller persists intent first. @throws {ShoppingError} Guard or uncertain dispatch failure, never automatically replayed. */
  async selectReviewCategory(tabId, target, before, label) {
    let script;
    try {
      script = reviewCategoriesScript(target, { before, label });
      await this.#requireProductTarget(tabId, target);
    } catch (error) { error.actionNotDispatched = true; throw error; }
    const data = await this.#command('eval', { tabId, script }, 1048576);
    return validateReadActionAcknowledgement(data?.result);
  }

  /** @param {number} tabId @param {object} target @returns {Promise<object>} Expansion acknowledgement only. @throws {ShoppingError} A pre-dispatch guard or uncertain dispatch failure. */
  async expandReviews(tabId, target) {
    let script;
    try {
      script = reviewsScript(target, true);
      await this.#requireProductTarget(tabId, target);
    } catch (error) { error.actionNotDispatched = true; throw error; }
    const data = await this.#command('eval', { tabId, script });
    return validateReadActionAcknowledgement(data?.result);
  }
}
