import { ShoppingError } from '../errors.mjs';
import { responseText, throwPageError } from '../page-dom.mjs';
import { pddPageGate } from './page-gate.mjs';
import { parsePddProductUrl } from './targets.mjs';

const LIMITS = Object.freeze({ line: 300, buttons: 4, headerLines: 12, otherLines: 12, groups: 6, options: 60, optionParts: 4 });
// A bottom bar button that opens the spec drawer: 单独购买, 免拼购买, 发起拼单, sometimes after 最后4件 or 快要抢光 (2026-10-28).
// 去拼单 joins someone else's group and is never one of them.
const BUY_BUTTON = /(购买|拼单)$/;

/**
 * In-page: observe the spec drawer of a PDD product page, or click one control in it. As seen on 2026-10-28, each buy
 * button of the bottom bar opens its own drawer (单独购买 shows the alone price, 免拼购买 the group price) from the
 * bottom of the page; the drawer stays in the page, hidden, while closed. A drawer is the element around the
 * 已选：…/请选择 … line that holds every spec group of the product; its header holds the price of the current
 * selection, then come the groups (a name and a list of options), then the drawer's own buttons. The selected option
 * has a border in its text colour (red); clicking it again clears it, so it is never clicked. The only controls this
 * function clicks are a bar buy button (only while a closed drawer with the groups is in the page and none is open),
 * one option that is not selected, or the drawer's close icon; never the drawer's own buttons (确定, 单独购买, 去拼单).
 * @param {{product_id: string, groups: string[], action: null|{kind: 'open', label: string}|{kind: 'option', group: string, text: string}|{kind: 'close'}}} expected
 * @param {Function} gate pddPageGate @param {object} limits
 * @returns {object} Raw guarded observation, or {state} for a click.
 */
export function pddSpecPage(expected, gate, limits) {
  const blocked = gate();
  if (blocked) return { state: blocked };
  const current = new URL(location.href);
  const ids = current.searchParams.getAll('goods_id');
  if (current.hostname !== 'mobile.pinduoduo.com' || current.pathname !== '/goods.html' || ids.length !== 1 || ids[0] !== expected.product_id) {
    return { state: 'target_changed' };
  }
  if (document.readyState !== 'complete') return { state: 'loading' };
  const clip = text => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, limits.line);
  const shown = element => {
    if (!element.getClientRects().length) return false;
    for (let up = element; up; up = up.parentElement) {
      const style = getComputedStyle(up);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  };
  // A group name can carry a link inside it, as 尺码 does with 尺码详情; only the name's own text is the name.
  const nameOf = node => clip([...node.children].reduce((text, child) => text.replace(String(child.textContent ?? ''), ''), String(node.textContent ?? ''))) ||
    clip(node.textContent);
  const groupsIn = root => [...root.querySelectorAll('*')].filter(group => group.children.length === 2 && group.children[1].children.length > 0 &&
    expected.groups.includes(nameOf(group.children[0]))).map(group => ({ name: nameOf(group.children[0]), options: [...group.children[1].children] }));
  const partsOf = option => [option, ...option.querySelectorAll('*')].filter(node => node.children.length === 0).map(node => clip(node.textContent)).filter(Boolean);
  const textOf = option => partsOf(option).join(' / ');
  const transparent = color => /^rgba\(.*,\s*0\)$/.test(color) || color === 'transparent';
  const selectedOption = option => { const style = getComputedStyle(option); return !transparent(style.borderColor) && style.borderColor === style.color; };
  // A sold-out option was drawn in light grey with pointer-events: none (2026-10-28 运动鞋); the other checks are the usual ways a page disables one.
  const unavailableOption = option => {
    const style = getComputedStyle(option);
    return Number(style.opacity) < 1 || style.pointerEvents === 'none' || option.getAttribute('aria-disabled') === 'true' ||
      [option, ...option.querySelectorAll('*')].some(node => getComputedStyle(node).textDecorationLine.includes('line-through'));
  };
  const chosenPattern = /^(已选[:：]|请选择)/;
  const lines = [...document.querySelectorAll('body *')].filter(node => chosenPattern.test(clip(node.textContent)) &&
    ![...node.children].some(child => chosenPattern.test(clip(child.textContent))));
  const drawers = [];
  for (const line of lines) {
    let root = line;
    while (root && root !== document.body && groupsIn(root).length < expected.groups.length) root = root.parentElement;
    if (root && root !== document.body && !drawers.some(drawer => drawer.root === root)) drawers.push({ line, root });
  }
  const open = drawers.filter(drawer => shown(drawer.line));
  // The bottom bar is the smallest fixed element holding 客服.
  const bars = [...document.querySelectorAll('body *')].filter(node => getComputedStyle(node).position === 'fixed' && clip(node.textContent).includes('客服') &&
    node.getBoundingClientRect().height > 40 && !drawers.some(drawer => drawer.root.contains(node)));
  const bar = bars.sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height)[0];
  const buttonNodes = bar ? [...bar.querySelectorAll('*')].filter(node => node.children.length === 0 && shown(node) && limits.buyButton.test(clip(node.textContent)) &&
    !clip(node.textContent).endsWith('去拼单')) : [];

  const action = expected.action;
  if (action?.kind === 'open') {
    if (!drawers.length) return { state: 'drawer_unavailable' };
    if (open.length) return { state: 'drawer_already_open' };
    const hits = buttonNodes.filter(node => clip(node.textContent) === action.label);
    if (hits.length !== 1) return { state: 'button_not_found' };
    hits[0].click();
    return { state: 'clicked' };
  }
  if (action?.kind === 'option') {
    if (open.length !== 1) return { state: 'drawer_not_open' };
    const group = groupsIn(open[0].root).find(item => item.name === action.group);
    const hits = group ? group.options.filter(option => textOf(option) === action.text) : [];
    if (hits.length !== 1) return { state: 'option_not_found' };
    if (selectedOption(hits[0])) return { state: 'option_selected' };
    if (unavailableOption(hits[0])) return { state: 'option_unavailable' };
    hits[0].click();
    return { state: 'clicked' };
  }
  if (action?.kind === 'close') {
    if (open.length !== 1) return { state: 'drawer_not_open' };
    // The close icon is a small text-free box with an svg at the drawer's top (27×27 on 2026-10-28).
    const top = open[0].root.getBoundingClientRect().top;
    const icons = [...open[0].root.querySelectorAll('div')].filter(node => {
      const box = node.getBoundingClientRect();
      return node.querySelector('svg') && !clip(node.textContent) && box.width > 10 && box.width < 40 && box.top < top + 80 && shown(node);
    });
    if (icons.length !== 1) return { state: 'close_not_found' };
    icons[0].click();
    return { state: 'clicked' };
  }

  const observed = { state: 'observed', drawers_in_page: drawers.length, open_count: open.length,
    buttons: buttonNodes.map(node => clip(node.textContent)).slice(0, limits.buttons), buttons_total: buttonNodes.length, open: null };
  if (open.length === 1) {
    const groups = groupsIn(open[0].root);
    const texts = String(open[0].root.innerText ?? '').split('\n').map(clip).filter(Boolean);
    const firstGroup = texts.findIndex(text => expected.groups.some(name => text.startsWith(name)));
    const known = new Set(groups.flatMap(group => [group.name, ...group.options.flatMap(partsOf)]));
    observed.open = {
      header: texts.slice(0, firstGroup < 0 ? 0 : firstGroup).slice(0, limits.headerLines),
      groups: groups.slice(0, limits.groups).map(group => ({ name: group.name, options_total: group.options.length,
        options: group.options.slice(0, limits.options).map(option => ({ parts: partsOf(option).slice(0, limits.optionParts),
          selected: selectedOption(option), unavailable: unavailableOption(option) })) })),
      groups_total: groups.length,
      // The rest of the drawer: quantity, its own buttons and hints such as 拼单购买无需等待，立省11.8元.
      other_lines: texts.slice(Math.max(firstGroup, 0)).filter(text => !known.has(text) && !expected.groups.some(name => text.startsWith(name))).slice(0, limits.otherLines),
    };
  }
  return observed;
}

function requireExpected(productId, groups) {
  if (!parsePddProductUrl(`https://mobile.pinduoduo.com/goods.html?goods_id=${productId}`) || !Array.isArray(groups) || !groups.length ||
      groups.length > LIMITS.groups || groups.some(name => typeof name !== 'string' || !name || name.length > 60) || new Set(groups).size !== groups.length) {
    throw new ShoppingError('INVALID_ARGUMENTS', 'Use a PDD goods_id and the spec group names its product task read.');
  }
}

const serializedLimits = () => `Object.assign(${JSON.stringify(LIMITS)}, { buyButton: ${BUY_BUTTON} })`;

/**
 * @param {string} productId @param {string[]} groups Spec group names from the product task.
 * @returns {string} One fixed read-only expression. @throws {ShoppingError} INVALID_ARGUMENTS.
 */
export function pddSpecStateScript(productId, groups) {
  requireExpected(productId, groups);
  return `(${pddSpecPage})(${JSON.stringify({ product_id: productId, groups, action: null })}, ${pddPageGate}, ${serializedLimits()})`;
}

/**
 * @param {string} productId @param {string[]} groups
 * @param {{kind: 'open', label: string}|{kind: 'option', group: string, text: string}|{kind: 'close'}} action
 * @returns {string} One fixed single-click expression. @throws {ShoppingError} INVALID_ARGUMENTS.
 */
export function pddSpecClickScript(productId, groups, action) {
  requireExpected(productId, groups);
  const valid = action?.kind === 'open' ? Object.keys(action).length === 2 && typeof action.label === 'string' && BUY_BUTTON.test(action.label) &&
      !action.label.endsWith('去拼单') && action.label.length <= 40
    : action?.kind === 'option' ? Object.keys(action).length === 3 && groups.includes(action.group) && typeof action.text === 'string' && action.text && action.text.length <= 400
      : action?.kind === 'close' && Object.keys(action).length === 1;
  if (!valid) throw new ShoppingError('INVALID_ARGUMENTS', 'Use a bar buy button, one spec option or the drawer close icon.');
  return `(${pddSpecPage})(${JSON.stringify({ product_id: productId, groups, action })}, ${pddPageGate}, ${serializedLimits()})`;
}

const CLICK_REFUSALS = {
  drawer_unavailable: ['SPEC_DRAWER_UNAVAILABLE', 'The product page holds no spec drawer with the saved groups, so a buy button is not clicked.'],
  drawer_already_open: ['SPEC_DRAWER_STATE_CHANGED', 'A spec drawer is already open.'],
  drawer_not_open: ['SPEC_DRAWER_STATE_CHANGED', 'No single spec drawer is open.'],
  button_not_found: ['SPEC_BUTTON_NOT_FOUND', 'The bottom bar does not show this buy button once.'],
  option_not_found: ['SPEC_OPTION_NOT_FOUND', 'The open drawer does not show this option once.'],
  option_selected: ['SPEC_OPTION_SELECTED', 'The option is already selected; clicking it would clear it.'],
  option_unavailable: ['SPEC_OPTION_UNAVAILABLE', 'The option is shown as not selectable.'],
  close_not_found: ['SPEC_DRAWER_CLOSE_NOT_FOUND', 'The open drawer has no single close icon.'],
};

/**
 * @param {unknown} value Page script result. @returns {{clicked: true}}
 * @throws {ShoppingError} Page gate errors, a refusal (nothing clicked, marked actionNotDispatched) or INVALID_RESPONSE.
 */
export function validatePddSpecClick(value) {
  if (value?.state === 'clicked' && Object.keys(value).length === 1) return { clicked: true };
  const refusal = CLICK_REFUSALS[value?.state];
  try {
    if (refusal) throw new ShoppingError(...refusal, 'Look at the tab; this task clicks nothing else on it.');
    throwPageError(value?.state);
    throw new ShoppingError('INVALID_RESPONSE', 'The PDD spec drawer click returned an unexpected acknowledgement.');
  } catch (error) {
    // Every non-click state comes from the page script before it clicked anything.
    if (typeof value?.state === 'string' && value.state !== 'clicked') error.actionNotDispatched = true;
    throw error;
  }
}

const invalid = () => new ShoppingError('INVALID_RESPONSE', 'The PDD spec drawer response does not match the supported page.');
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function textArray(value, max) {
  if (!Array.isArray(value) || value.length > max) throw invalid();
  return value.map(text => responseText(text, LIMITS.line)).filter(Boolean);
}

/**
 * @param {unknown} value pddSpecPage observation. @param {string[]} groups The expected group names.
 * @returns {{drawers_in_page: number, buttons: string[], buttons_cut: boolean, open: null|object}} Normalized, as saved.
 * @throws {ShoppingError} Page gates or INVALID_RESPONSE.
 */
export function validatePddSpecState(value, groups) {
  throwPageError(value?.state);
  if (value?.state !== 'observed' || !Number.isSafeInteger(value.drawers_in_page) || value.drawers_in_page < 0 || value.drawers_in_page > 10 ||
      !Number.isSafeInteger(value.open_count) || value.open_count < 0 || value.open_count > 10 || !Number.isSafeInteger(value.buttons_total) ||
      value.buttons_total < 0 || value.buttons_total > 20) throw invalid();
  const buttons = textArray(value.buttons, LIMITS.buttons);
  if (buttons.length > value.buttons_total || buttons.some(label => !BUY_BUTTON.test(label))) throw invalid();
  if (value.open_count > 1) throw new ShoppingError('PAGE_STRUCTURE_CHANGED', 'More than one PDD spec drawer is open.');
  if ((value.open_count === 1) !== isObject(value.open)) throw invalid();
  let open = null;
  if (value.open) {
    const raw = value.open;
    if (!Array.isArray(raw.groups) || raw.groups.length > LIMITS.groups || !Number.isSafeInteger(raw.groups_total)) throw invalid();
    open = { header: textArray(raw.header, LIMITS.headerLines), groups: raw.groups.map(group => {
      if (!isObject(group) || !groups.includes(group.name) || !Array.isArray(group.options) || group.options.length > LIMITS.options ||
          !Number.isSafeInteger(group.options_total) || group.options_total < group.options.length) throw invalid();
      return { name: group.name, options_cut: group.options_total > group.options.length, options: group.options.map(option => {
        if (!isObject(option) || typeof option.selected !== 'boolean' || typeof option.unavailable !== 'boolean') throw invalid();
        const parts = textArray(option.parts, LIMITS.optionParts);
        if (!parts.length) throw invalid();
        return { text: parts.join(' / '), selected: option.selected, unavailable: option.unavailable };
      }) };
    }), other_lines: textArray(raw.other_lines, LIMITS.otherLines) };
    if (open.groups.length !== groups.length || raw.groups_total !== groups.length) {
      throw new ShoppingError('PAGE_STRUCTURE_CHANGED', 'The open PDD spec drawer does not show the saved spec groups.');
    }
  }
  return { drawers_in_page: value.drawers_in_page, buttons, buttons_cut: value.buttons_total > buttons.length, open };
}

const PRICE_TEXT = /^(?:0|[1-9][0-9]{0,8})(?:\.[0-9]{1,2})?$/;

/**
 * Split an open drawer's header: the first line with ¥ is the price of the current selection (a range such as
 * 336.99-341.99 while a group is not chosen), the 已选/请选择 line is the selection, the rest are notes such as
 * 券前¥340.99 or 2件9.9折 (2026-10-28).
 * @param {string[]} header @returns {{price: object|null, chosen: string|null, notes: string[]}}
 */
export function pddSpecHeader(header) {
  const at = header.findIndex(line => /[¥￥]/.test(line));
  const chosen = header.find(line => /^(已选[:：]|请选择)/.test(line)) ?? null;
  const notes = header.filter((line, index) => index !== at && line !== chosen);
  if (at < 0) return { price: null, chosen, notes };
  const raw = header[at];
  const [label, rest] = raw.split(/[¥￥]/);
  const [low, high] = rest.replace(/\s+/g, '').split(/[-~～]/);
  const range = high !== undefined;
  const parsed = PRICE_TEXT.test(low) && (!range || PRICE_TEXT.test(high));
  return { price: { raw, label: label.trim(), amount_text: rest.trim(), kind: !parsed ? 'unparsed' : range ? 'range' : 'single',
    amount: parsed && !range ? Number(low) : null, minimum: parsed ? Number(low) : null, maximum: parsed ? Number(range ? high : low) : null, currency: 'CNY' },
  chosen, notes };
}
