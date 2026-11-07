import { parseProductUrl } from './targets.mjs';
import { parseJdProductUrl } from './jd/targets.mjs';
import { parsePddProductUrl } from './pdd/targets.mjs';

const PRODUCT_PARSERS = { taobao: parseProductUrl, jd: parseJdProductUrl, pdd: parsePddProductUrl };

/**
 * The product-page parser of one platform; bindings keep the canonical identity it returns.
 * @param {'taobao'|'jd'|'pdd'} platform @returns {(value: unknown) => object|null}
 * @example productParserOf('pdd')('https://mobile.pinduoduo.com/goods.html?goods_id=1').product_id // '1'
 */
export function productParserOf(platform) {
  return PRODUCT_PARSERS[platform];
}
