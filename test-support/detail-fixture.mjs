import { rawProduct } from './product-fixture.mjs';

/** Build synthetic product details without customer information or live platform access. */
export function rawDetails() {
  const image = { url: 'https://img.alicdn.com/example.jpg', loaded: true, width: 800, height: 800 };
  return { ...rawProduct(), details: {
    shop: { name: 'Synthetic shop', url: 'https://shop123.taobao.com/category.htm?tracking=DO_NOT_KEEP' },
    attributes: { observed: true, rows_seen: 2, items: [
      { name: '连接方式', value: '无线', source: 'emphasis_parameters' },
      { name: '品牌', value: 'Synthetic brand', source: 'general_parameters' },
    ] },
    gallery: { observed: true, elements_seen: 4, items: [image, image,
      { ...image, url: 'https://example.test/private?token=DO_NOT_KEEP' }, { ...image, url: 'https://gw.alicdn.com/second.webp' }] },
    description: { observed: true, elements_seen: 1, items: [image], text: '', videos_seen: 0 },
    services: { observed: true, labels: ['7天无理由退换'] },
    shipping: { observed: true, freight_labels: ['快递: 免运费'] },
  } };
}
