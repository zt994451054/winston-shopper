/** @param {object} target @param {string} thumbnail @param {object} [changes] @returns {object} Synthetic main-image observation; no browser access. */
export function mainImageObservation(target, thumbnail, changes = {}) {
  return { state: 'observed', product_id: target.product_id, url: target.url,
    observed_at: '2026-09-24T02:00:00.000Z', thumbnail_url: thumbnail, selected: true,
    image: { url: 'https://img.alicdn.com/displayed.jpg', width: 1280, height: 1280,
      displayed_width: 615, displayed_height: 615, loaded: true, uncovered: true },
    nodes_scanned: 6, excluded_video_regions: 0, ...changes };
}
