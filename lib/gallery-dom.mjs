/**
 * Collect up to twenty mounted thumbnail image elements from an identified product gallery.
 * @param {Element|null} root Unique gallery root. @param {object} dom Page-local DOM helpers.
 * @returns {object} Raw URLs, natural dimensions and loading flags; no main-image or video source reads.
 * @throws {Error} An ancestor chain exceeds the bounded visibility check.
 * @example collectGalleryImages(galleryRoot, pageDom());
 */
export function collectGalleryImages(root, dom) {
  const included = node => {
    let depth = 0;
    for (let parent = node; parent; parent = parent.parentElement) {
      if (++depth > 64) throw new Error('Gallery ancestor scan limit reached');
      if (!dom.visible(parent) || parent.hidden || parent.getAttribute('aria-hidden') === 'true') return false;
      if (parent.tagName === 'VIDEO' || ['mainPicVideo', 'videoPicWrap', 'videoPic'].some(prefix => parent.matches(dom.selector(prefix)))) return false;
    }
    return true;
  };
  const observed = root !== null && included(root);
  const nodes = observed ? dom.all(root, dom.selector('thumbnailPic')).filter(node => node.tagName === 'IMG' && included(node)) : [];
  return { observed, elements_seen: nodes.length,
    items: nodes.slice(0, 20).map(node => ({ url: node.currentSrc || node.getAttribute('src') || '',
      loaded: node.complete === true && node.naturalWidth > 0 && node.naturalHeight > 0,
      width: node.naturalWidth, height: node.naturalHeight })) };
}
