/** @returns {object} Synthetic page response containing two options sharing one asset; no live data. */
export function rawSpecificationImages() {
  const option = (position, label) => ({ position, label, selected: null, disabled: null,
    image_regions_seen: 1, image_elements_seen: 1,
    image: { url: 'https://img.alicdn.com/option.jpg', loaded: true, width: 80, height: 80 } });
  return { state: 'observed', product_id: '123', url: 'https://detail.tmall.com/item.htm?id=123',
    observed_at: '2026-09-28T10:00:00.000Z', groups_seen: 2,
    groups: [{ name: '颜色', options_seen: 3, options_scanned: 3, image_options_seen: 2,
      options: [option(1, '黑色'), option(3, '白色')] },
    { name: '容量', options_seen: 2, options_scanned: 2, image_options_seen: 0, options: [] }] };
}
