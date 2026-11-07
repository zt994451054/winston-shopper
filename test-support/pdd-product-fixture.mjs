import vm from 'node:vm';
import { node } from './pdd-search-fixture.mjs';

export const PDD_GOODS_ID = '700000000001';
export const PDD_PRODUCT_TITLE = '秋冬法式新款小黑裙半高领收腰显瘦连衣裙';
const IMAGE = name => `https://img-2.pddpic.com/mms-material-img/2026-10-27/${name}.jpeg`;
const AVATAR = 'https://avatar3.pddpic.com/a/PRIVATE_AVATAR.jpeg';
const span = text => node('span', { text });
const div = text => node('div', { text });

/** One 拼单 row of another buyer: nickname, timer and 去拼单, as on the 2026-10-27 dress page. */
function buyerRow(nickname) {
  return node('div', {}, [node('div', {}, [node('img', { width: 40, attrs: { src: AVATAR } })]), span(nickname), span('补贴团快结束'), span('10:01:19.6'), span('去拼单')]);
}

/** One review preview: the avatar and the name share a small block; the text sits beside it. */
function review(name, text) {
  return node('div', {}, [node('div', {}, [node('img', { width: 49, attrs: { src: AVATAR } }), node('div', {}, [div(name)])]), span(text)]);
}

function specOption(label, badge = null) {
  return node('div', {}, [node('span', {}, [...(badge ? [div(badge)] : []), span(label)])]);
}

/**
 * Body of a product page shaped like the 2026-10-27 probes: the full page a search card opened, or with `hidden` the
 * reduced page whose price reads "7?.??" with 前往APP查看价格 and which has no reviews, shop, bar or spec panel. Without
 * `shopReviews` the shop has no 该商品所属店铺评价 heading; `selection` is the panel's 已选 or 请选择 line; `onAllReviews` runs when
 * 查看全部 is clicked; `reviewHeading` is the 商品评价(N) line.
 * @param {{hidden?: boolean, title?: string, shopReviews?: boolean, selection?: string, onAllReviews?: Function, reviewHeading?: string}} options @returns {object} The body node.
 */
export function pddProductBody({ hidden = false, title = PDD_PRODUCT_TITLE, shopReviews = true, selection = '已选：黑色常规款 S 80-100斤', onAllReviews = null,
  reviewHeading = '商品评价(572)' } = {}) {
  const gallery = node('div', {}, [node('video', { text: '您的浏览器可能不支持视频播放' }), span(hidden ? '1/1' : '1/3'),
    ...(hidden ? ['g1'] : ['g1', 'g2', 'g3', 'g1', 'g2']).map(name => node('img', { width: 768, attrs: { src: IMAGE(name) } }))]);
  const price = hidden ? node('div', {}, [span('券后'), span('¥'), span('7?.??'), span('前往APP查看价格')])
    : node('div', {}, [span('补贴价'), span('¥'), span('89'), span('.'), span('9'), div('官方补贴10元'), span('优惠前 ¥99.9')]);
  const detail = [node('p', { text: '商品详情' }),
    node('div', {}, [node('div', {}, [div('品牌'), div('思蜜妲')]), node('div', {}, [div('发货地'), div('湖北省')])]),
    node('img', { width: 768, attrs: { src: IMAGE('d1') } }),
    node('img', { width: 768, attrs: { src: 'https://mobile.pinduoduo.com/placeholder.png', 'data-src': IMAGE('d2') } }),
    node('img', { width: 61, attrs: { src: AVATAR } }),
    div('消费提醒'), div('服饰类商品如出现已洗涤，不支持七天无理由退换。'), span('点击查看商品价格说明')];
  if (hidden) return node('body', {}, [gallery, price, span(title), ...detail, div('用手机浏览器扫码在拼多多App打开')]);
  return node('body', {}, [
    gallery, price, node('div', {}, [span('退货包运费'), span('|'), span('不满意包退货运费，退换货运费无忧')]), span(title),
    span('近90天12万人看过'), span('156人在拼'), node('div', {}, [buyerRow('PRIVATE_BUYER_ONE'), buyerRow('PRIVATE_BUYER_TWO')]),
    span('预计6小时内发货'), span(''), span('承诺48小时内发货，超时必赔'), node('div', {}, [span('退货包运费'), span('7天无理由退货')]),
    div(reviewHeading), node('span', { text: '查看全部', onClick: onAllReviews }), review('PRIVATE_REVIEWER', '料子舒服，上身效果很显身材'), review('拼多多用户', '颜色很正'),
    ...(shopReviews ? [span('该商品所属店铺评价'), span(''), span('回头客(687)'), span('好看(610)')] : []),
    node('div', {}, [div('思蜜妲旗舰店'), span('官方运营'), span('进店逛逛')]),
    ...detail,
    span('相似商品'), node('div', {}, [node('img', { width: 300, attrs: { src: IMAGE('other') } }), span('OTHER_PRODUCT'), span('¥'), span('10')]),
    node('div', {}, [span('更多'), span('收藏'), span('客服'), span('补贴价'), span('¥'), span('89'), span('品牌正品 免拼购买')]),
    node('div', {}, [
      node('div', {}, [node('img', { width: 0, attrs: { src: IMAGE('g1') } }), node('div', {}, [div('¥89.9'), span(selection)])]),
      node('div', {}, [
        node('div', {}, [span('颜色分类'), node('div', {}, [specOption('黑色常规款'), specOption('咖色常规款', '最后9件')])]),
        node('div', {}, [node('span', { ownText: '尺码' }, [span('尺码详情')]), node('div', {}, [specOption('S 80-100斤'), specOption('M 100-115斤')])]),
      ]),
      div('确定'),
    ]),
    div('用手机浏览器扫码在拼多多App打开'),
  ]);
}

/**
 * A page context for serialized PDD scripts. `page.body` can be swapped to model a same-tab navigation.
 * @param {{href: string, body: object, readyState?: string}} options
 * @returns {{context: object, evaluate: Function, setPage: Function}}
 */
export function pddPage({ href, body, readyState = 'complete' }) {
  const document = { title: '拼多多', body, readyState,
    querySelectorAll: selector => selector === 'body *' ? document.body.querySelectorAll('*') : document.body.querySelectorAll(selector) };
  const context = { URL, location: { href }, document, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) };
  return {
    context,
    // Results cross the bridge as JSON, so they are returned as plain Node values.
    evaluate: script => JSON.parse(JSON.stringify(vm.runInNewContext(script, context) ?? null)),
    setPage(nextHref, nextBody) { context.location.href = nextHref; document.body = nextBody; },
  };
}

export const pddProductUrl = (id = PDD_GOODS_ID) => `https://mobile.pinduoduo.com/goods.html?goods_id=${id}&_oak_rcto=PRIVATE_TOKEN&refer_page_name=search_result`;

/**
 * One review card of the 查看全部 page, shaped like the 2026-10-27 probe: avatar and name, spec, text (with 展开 when long),
 * optional images, then 赞 and 评论. `extra` adds blocks before the buttons; `avatar: false` drops the avatar; `actions` are
 * the button lines, such as ['1', '评论'] when a like count replaces 赞 (2026-10-27).
 */
export function pddReviewCard({ name = 'PRIVATE_REVIEWER', spec = '型号：M330黑色【全新】', text, expand = false, images = 0, extra = [], avatar = true,
  actions = ['赞', '评论'] }) {
  return node('div', {}, [
    node('div', {}, [...(avatar ? [node('div', {}, [node('img', { width: 49, attrs: { src: AVATAR } })])] : []), div(name)]),
    ...(spec ? [div(spec)] : []),
    node('div', {}, [span(text), ...(expand ? [span('展开')] : [])]),
    ...(images ? [node('div', {}, Array.from({ length: images }, (_, index) => node('img', { width: 236, attrs: { 'data-src': IMAGE(`r${index}`) } })))] : []),
    ...extra.map(lines => node('div', {}, lines.map(span))),
    node('div', {}, actions.map(span)),
  ]);
}

/**
 * The 查看全部 page: category labels, the review list, `notes` under it, then the product bottom bar (with small icons)
 * and the hidden spec panel it also holds.
 */
export function pddReviewsBody({ tabs = ['全部(572)'], cards = [], notes = [] } = {}) {
  return node('body', {}, [
    node('div', {}, tabs.map(span)),
    node('div', {}, cards),
    ...notes.map(div),
    node('div', {}, [node('img', { width: 24, attrs: { src: IMAGE('icon') } }), span('更多'), span('收藏'), span('客服'), span('补贴价'), span('¥'), span('89'), span('免拼购买')]),
    node('div', {}, [node('div', {}, [div('¥89.9'), span('已选：黑色常规款')]), node('div', {}, [span('颜色分类'), node('div', {}, [specOption('黑色常规款')])]), div('确定')]),
    div('用手机浏览器扫码在拼多多App打开'),
  ]);
}

export const pddReviewsUrl = (id = PDD_GOODS_ID) => `https://mobile.pinduoduo.com/goods_comments.html?goods_id=${id}&_oak_rcto=PRIVATE_TOKEN&uin=PRIVATE_UIN`;
