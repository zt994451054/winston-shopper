import { ShoppingError } from '../errors.mjs';
import { throwPageError } from '../page-dom.mjs';
import { pddPageGate } from './page-gate.mjs';
import { PDD_SEARCH_CARD_LIMIT, pddSearchCards } from './search.mjs';
import { pddSearchTarget } from './targets.mjs';

/**
 * In-page: click search card N once, after checking that it still shows the title and price a saved pdd_search read
 * there. Cards are found and ordered as collectPddSearch does. The card is scrolled into view first, as a person
 * would, and its main image is clicked; PDD then opens goods.html in the same tab (2026-10-27). Nothing else is clicked.
 * @param {{query: string, position: number, title: string, amount_text: string}} expected
 * @param {Function} gate pddPageGate @param {Function} findCards pddSearchCards
 * @returns {{state: string}} 'clicked', a gate state, or why nothing was clicked.
 */
export function clickPddSearchCard(expected, gate, findCards) {
  const blocked = gate();
  if (blocked) return { state: blocked };
  const current = new URL(location.href);
  const keys = current.searchParams.getAll('search_key');
  if (current.hostname !== 'mobile.pinduoduo.com' || current.pathname !== '/search_result.html' || keys.length !== 1 || keys[0].trim() !== expected.query) {
    return { state: 'target_changed' };
  }
  if (document.readyState !== 'complete') return { state: 'loading' };
  const yen = [...document.querySelectorAll('body *')].filter(node => node.children.length === 0 && /^[¥￥]/.test(String(node.textContent).trim()));
  const cards = findCards(yen);
  if (!cards) return { state: 'structure_changed' };
  const card = cards[expected.position - 1];
  if (!card) return { state: 'card_not_loaded' };
  const lines = String(card.innerText ?? '').split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  // The amount follows ¥ as separate lines ("¥", "89", ".9"), so it is read from the joined text.
  const amount = lines.join('').match(/[¥￥]([0-9.]+)/)?.[1] ?? null;
  if (lines[0] !== expected.title || amount !== expected.amount_text) return { state: 'card_changed' };
  const image = [...card.querySelectorAll('img')].sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
  card.scrollIntoView({ block: 'center' });
  image.click();
  return { state: 'clicked' };
}

/**
 * @param {{query: string}} target Canonical PDD search target of the tab. @param {number} position 1-40.
 * @param {{title: string, amount_text: string}} card The saved card at that position.
 * @returns {string} One fixed single-click expression. @throws {ShoppingError} INVALID_ARGUMENTS.
 */
export function pddSearchCardClickScript(target, position, card) {
  const expected = pddSearchTarget(target?.query);
  if (JSON.stringify(expected) !== JSON.stringify(target) || !Number.isSafeInteger(position) || position < 1 || position > PDD_SEARCH_CARD_LIMIT ||
      typeof card?.title !== 'string' || !card.title || card.title.length > 300 || typeof card.amount_text !== 'string' || !/^[0-9.]{1,20}$/.test(card.amount_text)) {
    throw new ShoppingError('INVALID_ARGUMENTS', `Use the canonical PDD search, a card position from 1 to ${PDD_SEARCH_CARD_LIMIT} and that card's saved title and price.`);
  }
  const expectedCard = { query: expected.query, position, title: card.title, amount_text: card.amount_text };
  return `(${clickPddSearchCard})(${JSON.stringify(expectedCard)}, ${pddPageGate}, ${pddSearchCards})`;
}

const REFUSALS = {
  card_not_loaded: ['SEARCH_CARD_NOT_LOADED', 'The search page has no loaded card at this position.'],
  card_changed: ['SEARCH_CARD_CHANGED', 'The card at this position no longer shows the title and price the search task read.'],
};

/**
 * @param {unknown} value Page script result. @returns {{clicked: true}}
 * @throws {ShoppingError} Page gate errors, a refusal (nothing clicked, marked actionNotDispatched) or INVALID_RESPONSE.
 */
export function validatePddSearchCardClick(value) {
  if (value?.state === 'clicked' && Object.keys(value).length === 1) return { clicked: true };
  const refusal = REFUSALS[value?.state];
  try {
    if (refusal) throw new ShoppingError(...refusal, 'Read the search page again in a new pdd_search task, then start a new product task from it.');
    throwPageError(value?.state);
    throw new ShoppingError('INVALID_RESPONSE', 'The PDD search card click returned an unexpected acknowledgement.');
  } catch (error) {
    // Every non-click state comes from the page script before it clicked anything.
    if (typeof value?.state === 'string' && value.state !== 'clicked') error.actionNotDispatched = true;
    throw error;
  }
}
