import vm from 'node:vm';
import { productScript } from '../lib/product.mjs';
import { parseProductUrl } from '../lib/targets.mjs';
import { layoutEvidenceId } from '../lib/layout-evidence.mjs';

export const layoutTarget = parseProductUrl('https://detail.tmall.com/item.htm?id=123');

export function node(prefix = '', text = '', children = [], attributes = {}) {
  const value = { tagName: 'DIV', className: prefix ? `${prefix}--fixture` : '', children, innerText: text, ...attributes,
    get childNodes() { return [{ nodeType: 3, nodeValue: text }, ...children]; },
    getAttribute(name) { return name === 'class' ? this.className : attributes[name] ?? null; },
    getClientRects() { return attributes.hidden ? [] : [{}]; },
    contains(other) { return this === other || children.some(child => child.contains(other)); },
    querySelectorAll(query) {
      const descendants = children.flatMap(child => [child, ...child.querySelectorAll('*')]);
      if (query === '*') return descendants;
      return descendants.filter(child => query.split(',').some(part => {
        const prefix = part.match(/\[class(?:\^|\*)=" ?([^" ]+)--"\]/)?.[1];
        if (prefix) return child.className.split(/\s+/).some(name => name.startsWith(`${prefix}--`));
        if (part.trim().startsWith('#')) return child.getAttribute('id') === part.trim().slice(1);
        const attr = part.match(/^\s*\[(role|aria-modal)="([^"]+)"\]/);
        return attr ? child.getAttribute(attr[1]) === attr[2] : part.trim().toUpperCase() === child.tagName;
      }));
    } };
  children.forEach(child => { child.parentElement = value; });
  return value;
}

export function layoutFixture() {
  const image = node('', '', [], { tagName: 'IMG', currentSrc: 'https://img.alicdn.com/black.jpg', naturalWidth: 800, naturalHeight: 800, complete: true });
  const option = node('UnfamiliarOption', '', [node('UnfamiliarLabel', '黑色'), image]);
  const group = node('UnfamiliarGroup', '', [node('UnfamiliarName', '颜色'), option]);
  const specifications = node('skuWrapper', '', [group]);
  const title = node('ItemTitle', '示例商品');
  const price = node('normalPrice', '', [node('UnfamiliarPrice', '店铺优惠后 ￥89')]);
  const summary = node('ItemHeadFixed', '', [node('ItemTitle', '摘要不能当正文')]);
  const body = node('UnfamiliarBody', '', [title, specifications, price]);
  const panel = node('GeneralSkuPanel', '', [summary, body]);
  return { panel, body, title, price, specifications, group, option, image, summary };
}

export function observeLayout(roots, { url = layoutTarget.url, diagnostics = true } = {}) {
  const document = Object.assign(node('', '', roots), { title: 'Synthetic product', readyState: 'complete' });
  return JSON.parse(JSON.stringify(vm.runInNewContext(productScript(layoutTarget, { layoutDiagnostics: diagnostics }), {
    URL, location: { href: url }, document,
    getComputedStyle: item => ({ display: item.hidden ? 'none' : 'block', visibility: 'visible' }),
  })));
}

export function proposalFor(evidence) {
  const region = kind => evidence.regions.find(item => item.kind === kind && item.excluded_reason === null);
  const title = region('title'), specifications = region('specification'), price = region('price');
  const find = prefix => specifications.nodes.find(item => item.component_prefixes.includes(prefix));
  const group = find('UnfamiliarGroup'), option = find('UnfamiliarOption');
  return { schema_version: 1, product_id: evidence.product_id, evidence_id: layoutEvidenceId(evidence), fields: [
    { field: 'title', region_ref: title.ref, node_ref: title.nodes[0].ref },
    { field: 'specification_group', region_ref: specifications.ref, node_ref: find('UnfamiliarName').ref, container_ref: group.ref },
    { field: 'specification_option', region_ref: specifications.ref, node_ref: find('UnfamiliarLabel').ref, container_ref: option.ref, group_ref: group.ref },
    { field: 'specification_image', region_ref: specifications.ref, node_ref: specifications.nodes.find(item => item.tag === 'IMG').ref, option_ref: option.ref },
    { field: 'display_price', region_ref: price.ref, node_ref: price.nodes.find(item => item.text).ref },
  ] };
}
