import { rawDetails } from './detail-fixture.mjs';

/** @param {object} options Synthetic image/source state. @returns {object} Raw same-read packet without platform access. @example rawDescriptionImage({normal: true}); */
export function rawDescriptionImage({ normal = false, loaded = true, inView = false, owned = true, count = 1, position = 1,
  url = normal ? 'https://img.alicdn.com/normal.jpg' : 'https://img.alicdn.com/tiny.png' } = {}) {
  const snapshot = rawDetails();
  const image = { url, loaded, width: loaded ? normal ? 800 : 1 : 0, height: loaded ? normal ? 800 : 1 : 0 };
  snapshot.details.description = { ...snapshot.details.description, elements_seen: count, items: Array.from({ length: Math.min(count, 60) }, () => ({ ...image })),
    image_readiness_observed: true };
  return { snapshot, scope: { schema_version: 1, position, region_observed: true, containers_seen: 1, images_seen: count,
    images_scanned: Math.min(count, 60), owned, geometry: owned ? {
      image_box: { x: 20, y: inView ? 20 : 1200, width: 500, height: 500 }, viewport: { width: 1000, height: 800 },
      clip_ancestors: 0, intersection: { width: 500, height: inView ? 500 : 0 }, fully_in_view: inView } : null } };
}
