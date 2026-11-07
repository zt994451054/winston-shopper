// Synthetic JD 全部评价 overlay shaped like the 2026-10-15 probes. No browser or platform is accessed.
import vm from 'node:vm';
import { element } from './jd-product-fixture.mjs';
import { parseJdProductUrl } from '../lib/jd/targets.mjs';

const sampleCard = (body, extra = {}) => ({ date: '09-23', spec: '38 深褐色 L', body, images: 0, videos: 0, followup: null, ...extra });

/** Cards and tags used when a test does not supply its own. Nicknames and media addresses are planted so a reader that touches them fails. */
export function defaultReviewCategories() {
  return [
    { name: '全部', count: '100+', cards: [
      sampleCard('合成评价正文一', { images: 1, videos: 1, followup: { interval: '购后2天追评', body: '合成追评正文' } }),
      sampleCard('合成评价正文二', { date: '09-24', spec: '红色' }),
    ] },
    { name: '好评', count: '99%好评', cards: [sampleCard('合成好评正文', { spec: '黑色' })] },
    { name: '差评', count: '5', cards: [sampleCard('合成差评正文', { spec: '黑色' })] },
  ];
}

function reviewCard(data, index) {
  const media = [
    ...Array.from({ length: data.images ?? 0 }, () => element('div', { cls: 'jd-content-pc-media-list-item' }, [
      element('img', { attrs: { src: 'https://img14.360buyimg.com/n0/synthetic-review.jpg' } })])),
    ...Array.from({ length: data.videos ?? 0 }, () => element('div', { cls: 'jd-content-pc-media-list-item' }, [
      element('img', { attrs: { src: 'https://img14.360buyimg.com/n0/synthetic-review.jpg' } }),
      element('div', { cls: 'jd-content-pc-media-list-play' })])),
  ];
  return element('div', { attrs: { 'data-index': String(data.index ?? index) } }, [
    element('div', { cls: '_listItem_1ygkr_73' }, [
      element('div', { cls: 'jdc-pc-rate-card' }, [
        // Present on purpose: the reader must not walk this block. A star class here would win if it did.
        element('div', { cls: 'jdc-pc-rate-card-user star-user-decoy' }, [
          element('img', { attrs: { src: 'https://img14.360buyimg.com/n0/synthetic-avatar.jpg' } }),
          element('span', { cls: 'jdc-pc-rate-card-nick', text: 'Synthetic buyer' }),
          element('span', { text: '会员标记' }),
        ]),
        element('div', { cls: 'jdc-pc-rate-card-content' }, [
          element('div', { cls: 'jdc-pc-rate-card-info top' }, [
            element('div', { cls: 'jdc-pc-rate-card-info-left' }, [
              element('div', { cls: 'jdc-pc-icon-star-good mr star-good-1' }),
              element('img', { attrs: { src: 'https://img14.360buyimg.com/n0/synthetic-star.jpg' } }),
              element('span', { cls: 'date list', text: data.date }),
              element('span', { cls: 'info', text: data.spec }),
            ]),
          ]),
          element('div', { cls: 'jdc-pc-rate-card-main' }, [
            element('span', { cls: 'jdc-pc-rate-card-main-desc', text: data.body }),
          ]),
          element('div', { cls: 'jdc-pc-rate-card-images' }, [
            element('div', { cls: 'jd-content-pc-media-list' }, media),
          ]),
          ...(data.followup ? [element('div', { cls: 'jdc-pc-rate-card-after' }, [
            element('span', { cls: 'jdc-pc-rate-card-after-icon', text: data.followup.interval }),
            element('span', { text: data.followup.body }),
          ])] : []),
          element('div', { cls: 'jdc-pc-rate-card-info' }, [
            element('div', { cls: 'jdc-pc-rate-card-info-right-item', text: '有用' }),
          ]),
        ]),
      ]),
    ]),
  ]);
}

/**
 * A JD product page whose 全部评价 overlay appears only after the entry is clicked.
 * Counts on the page record clicks. Options flip the branches the click scripts must refuse.
 * @param {{productId?: string, visibility?: 'visible'|'hidden', initiallyOpen?: boolean, categories?: object[], openWorks?: boolean,
 *   closeWorks?: boolean, showEntry?: boolean, extraEntry?: boolean, hideOnOpen?: boolean, hideOnClose?: boolean, sameCards?: boolean,
 *   paintWhenHidden?: boolean, unpainted?: string|null, entryUnpainted?: boolean, closeUnpainted?: boolean, extraClose?: boolean,
 *   closeHidden?: boolean, href?: string, limited?: boolean, entryText?: string, hiddenCategory?: string|null, flatEntry?: boolean}} options
 *   hiddenCategory is a tag name kept in the DOM with display:none, so the read omits it and the click treats it as absent.
 *   paintWhenHidden keeps card nodes in the DOM while visibility is hidden, so a reader that ignores visibility is caught.
 *   unpainted is a tag name whose name span stays in the DOM but has no client rects. closeUnpainted does the same for the close control.
 *   flatEntry puts the 全部评价 text on .all-btn itself; otherwise the text sits on an inner div beside an icon, as on the 2026-10-15 page.
 * @returns {object} Synthetic page with evaluate(), click counts and the canonical target.
 */
export function jdReviewPage({ productId = '3290995', visibility = 'visible', initiallyOpen = false, categories, openWorks = true, closeWorks = true,
  showEntry = true, extraEntry = false, hideOnOpen = false, hideOnClose = false, sameCards = false, paintWhenHidden = false, unpainted = null,
  entryUnpainted = false, closeUnpainted = false, extraClose = false, closeHidden = false, href, limited = false, entryText = '全部评价',
  hiddenCategory = null, flatEntry = false } = {}) {
  const target = parseJdProductUrl(`https://item.jd.com/${productId}.html`);
  const page = {
    target, visibility, open: initiallyOpen, openWorks, closeWorks, showEntry, extraEntry, hideOnOpen, hideOnClose, paintWhenHidden,
    unpainted, entryUnpainted, closeUnpainted, extraClose, closeHidden, href, limited, entryText, hiddenCategory, flatEntry,
    openClicks: 0, categoryClicks: 0, closeClicks: 0, lastClicked: null, clicks: [],
    categories: structuredClone(categories ?? defaultReviewCategories()),
    selected: (categories ?? defaultReviewCategories())[0]?.name ?? '全部',
  };
  if (sameCards) {
    const current = page.categories.find(category => category.name === '全部');
    const positive = page.categories.find(category => category.name === '好评');
    if (current && positive) positive.cards = structuredClone(current.cards);
  }
  const build = () => {
    const note = record => { page.lastClicked = record; page.clicks.push(record); };
    const activateEntry = () => {
      page.openClicks += 1;
      note({ role: page.flatEntry ? 'entry' : 'entry-label' });
      if (page.hideOnOpen) page.visibility = 'hidden';
      if (page.openWorks) page.open = true;
      page.body = build();
    };
    let entry;
    if (page.flatEntry) {
      entry = element('div', { cls: 'all-btn', text: page.entryText, onClick: activateEntry });
      if (page.entryUnpainted) entry.getClientRects = () => [];
    } else {
      const label = element('div', { text: page.entryText, onClick: activateEntry });
      entry = element('div', { cls: 'all-btn' }, [label, element('span', { cls: 'all-btn-icon' })]);
      // Both layers lose their rects: the read looks at .all-btn, the click looks at the inner label.
      if (page.entryUnpainted) { entry.getClientRects = () => []; label.getClientRects = () => []; }
    }
    const buttons = [...page.rootClose?.() ?? []];
    const closeButtons = [0, ...(page.extraClose ? [1] : [])].map(() => {
      const button = element('div', { cls: '_closeIcon_1ygkr_39', hidden: page.closeHidden, onClick: () => {
        page.closeClicks += 1;
        note({ role: 'close-icon' });
        if (page.hideOnClose) page.visibility = 'hidden';
        if (page.closeWorks) page.open = false;
        page.body = build();
      } });
      if (page.closeUnpainted) button.getClientRects = () => [];
      return button;
    });
    const selected = page.categories.find(category => category.name === page.selected) ?? page.categories[0];
    const tags = page.categories.map(category => {
      const nameNode = element('span', { cls: '_tag-name_rgt47_38', text: category.name, onClick: () => {
        page.categoryClicks += 1;
        note({ role: 'tag-name', name: category.name });
        page.selected = category.name;
        page.body = build();
      } });
      if (page.unpainted === category.name) nameNode.getClientRects = () => [];
      const chip = element('div', {
        cls: `_tag_rgt47_12${category.name === page.selected ? ' _tag-active_rgt47_31' : ''}`,
      }, [
        nameNode,
        element('span', { cls: '_tag-comment_rgt47_35', text: category.count }),
      ]);
      if (page.hiddenCategory === category.name) chip.hidden = true;
      return chip;
    });
    page.paintedVisibility = page.visibility;
    const paintCards = page.visibility === 'visible' || page.paintWhenHidden;
    const overlay = element('div', { attrs: { id: 'rateList' } }, [
      element('div', { cls: '_title_1ygkr_22' }, [
        element('div', { cls: '_titleName_1ygkr_31', text: '商品评价' }),
        ...closeButtons,
      ]),
      element('div', { cls: '_tags_rgt47_12' }, tags),
      element('div', { cls: '_sort_19gj1_22', text: '最新' }),
      element('div', { cls: '_skuSelect_19gj1_28', text: '当前商品' }),
      element('div', { cls: '_list_1ygkr_67' }, paintCards && selected ? selected.cards.map((card, index) => reviewCard(card, index)) : []),
    ]);
    return element('body', {}, [
      element('div', { attrs: { id: 'comment-root' }, cls: 'comment-root' }, page.showEntry ? [entry, ...(page.extraEntry ? [element('div', { cls: 'all-btn', text: page.entryText })] : [])] : []),
      ...(page.open ? [overlay] : []),
      ...(page.limited ? [element('div', { text: '访问频繁，请稍后再试' })] : []),
      ...buttons,
    ]);
  };
  page.rebuild = build;
  page.body = build();
  page.evaluate = script => {
    // Like the live virtual list, cards are painted again once the window becomes visible.
    if (page.paintedVisibility !== page.visibility) page.body = build();
    const context = {
      URL, location: { href: page.href ?? target.url },
      document: {
        title: 'JD product', readyState: 'complete',
        get visibilityState() { return page.visibility; },
        get body() { return page.body; },
        querySelector: selector => page.body.querySelectorAll(selector)[0] ?? null,
        querySelectorAll: selector => page.body.querySelectorAll(selector),
      },
      getComputedStyle: node => ({ display: node.hidden ? 'none' : 'block', visibility: 'visible', backgroundImage: 'none' }),
    };
    context.globalThis = context;
    return JSON.parse(JSON.stringify(vm.runInNewContext(script, context)));
  };
  return page;
}
