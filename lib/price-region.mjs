import { pageDom } from './page-dom.mjs';
import { searchControlsScript } from './search-controls.mjs';

function collectRegion(raw, dom) {
  if (raw.state !== 'observed') return raw;
  const roots = dom.all(document, dom.selector('sortBarWrapper'));
  if (roots.length !== 1) return { state: 'search_sort_state_mismatch' };
  const prices = dom.all(roots[0], '[role="tab"]').filter(node => dom.text(dom.all(node, '.next-tabs-tab-inner')[0] ?? node, 80) === '价格');
  if (prices.length !== 1) return { state: 'unsupported' };
  const price = prices[0];
  const rectangle = node => {
    const rect = node.getBoundingClientRect();
    return Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, Math.round(rect[key] * 100) / 100]));
  };
  const anchor = rectangle(price);
  const viewport = { width: innerWidth, height: innerHeight };
  const inViewport = anchor.width > 0 && anchor.height > 0 && anchor.x < innerWidth && anchor.y < innerHeight &&
    anchor.x + anchor.width > 0 && anchor.y + anchor.height > 0;
  const limits = { nodes: 80, children: 12, depth: 5, hit_points: 9, nearby_roots: 12 };
  const nodes = [], seen = new Set();
  let truncated = false;
  const visit = (node, parent, depth, source) => {
    if (seen.has(node) || !dom.visible(node)) return;
    if (nodes.length >= limits.nodes) { truncated = true; return; }
    seen.add(node);
    const id = nodes.length;
    const clean = (value, max) => value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
    const attribute = (name, max) => clean(node.getAttribute(name) ?? '', max);
    nodes.push({ id, parent, source, tag: node.tagName.toUpperCase(), class_name: attribute('class', 300),
      role: attribute('role', 40), aria_controls: attribute('aria-controls', 80), aria_owns: attribute('aria-owns', 80),
      aria_expanded: attribute('aria-expanded', 20), text: clean(dom.text(node, 160), 160), rect: rectangle(node),
      is_price_tab: node === price, within_price_tab: price.contains(node), within_sort_bar: roots[0].contains(node) });
    const children = [...node.children].filter(dom.visible);
    if (children.length > limits.children || (depth >= limits.depth && children.length)) truncated = true;
    if (depth >= limits.depth) return;
    for (const child of children.slice(0, limits.children)) visit(child, id, depth + 1, source);
  };
  let local = price;
  for (let level = 0; level < 3 && local !== roots[0]; level += 1) {
    if (!local.parentElement || !roots[0].contains(local.parentElement)) break;
    local = local.parentElement;
  }
  visit(local, null, 0, 'price_ancestors');
  const nearby = new Set(), points = [];
  // Portaled menus can sit after thousands of product nodes; sample geometry without scanning the page.
  if (inViewport) for (const xOffset of [8, 80, 160]) for (const yOffset of [8, 42, 80]) {
    const x = anchor.x + xOffset, y = anchor.y + anchor.height + yOffset;
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
    points.push({ x, y });
    const hits = document.elementsFromPoint(x, y);
    if (hits.length > 4) truncated = true;
    for (const hit of hits.slice(0, 4)) {
      let candidate = hit;
      for (let level = 0; candidate && level < 3; level += 1, candidate = candidate.parentElement) {
        if (!dom.visible(candidate) || ['HTML', 'BODY'].includes(candidate.tagName.toUpperCase())) continue;
        const rect = rectangle(candidate);
        if (rect.width <= 0 || rect.height <= 0 || rect.width > 400 || rect.height > 240 ||
            rect.x < anchor.x - 30 || rect.x > anchor.x + 240 || rect.y < anchor.y - 20 || rect.y > anchor.y + anchor.height + 180) continue;
        if (nearby.size >= limits.nearby_roots && !nearby.has(candidate)) { truncated = true; continue; }
        nearby.add(candidate);
      }
    }
  }
  for (const node of nearby) visit(node, null, 0, 'nearby_hit_test');
  return { ...raw, price_region: { anchor, viewport, in_viewport: inViewport, nodes, hit_points: points,
    truncated, limits, menu_relation_verified: false, price_direction: null } };
}

/**
 * Build one fixed, read-only price-region diagnostic; the caller must reserve an observation first.
 * @param {object} target Canonical search root, as returned by searchTarget().
 * @returns {string} Guarded expression with bounded visible layout evidence; nearby nodes do not establish menu ownership.
 * @throws {ShoppingError} INVALID_SEARCH for a noncanonical root. Example: priceRegionScript(searchTarget('mouse')).
 */
export function priceRegionScript(target) {
  return `(() => { const raw = ${searchControlsScript(target)};
    return (${collectRegion.toString()})(raw, (${pageDom.toString()})()); })()`;
}
