/**
 * Page-local JD gate check, serialized into JD page scripts as `(${jdPageGate})()`. Returns a code only, never page text.
 * The rate-limit texts and the pc-frequent-pro redirect were seen live on 2026-09-15; the login host, risk handler and
 * slider markers are JD's known ones and still need confirming by the read-only structure probes.
 * @returns {'login_required'|'rate_limited'|'verification_required'|null}
 */
export function jdPageGate() {
  const visible = element => {
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  };
  const current = new URL(location.href);
  if (current.hostname === 'passport.jd.com') return 'login_required';
  if (current.hostname === 'pc-frequent-pro.pf.jd.com' || current.hostname === 'cfe.m.jd.com' && current.pathname.includes('/risk_handler')) {
    return 'rate_limited';
  }
  const slider = [...document.querySelectorAll('[class*="JDJRV-"], [id^="JDJRV-"], #captcha_modal, [class*="captcha_"]')].filter(visible);
  // Gate pages are short, so their message is within the first visible text; a normal page's header never carries these phrases.
  const pageText = `${String(document.title).slice(0, 300)}\n${String(document.body?.innerText ?? '').slice(0, 2000)}`;
  if (slider.length || /安全验证|拖动滑块|向右滑动|验证一下/.test(pageText)) return 'verification_required';
  if (/访问频繁|内容太火爆|当前页面异常|请求过于频繁|操作过于频繁/.test(pageText)) return 'rate_limited';
  const frames = [...document.querySelectorAll('iframe')].filter(visible).map(frame => {
    try { return new URL(frame.getAttribute('src'), location.href).hostname; } catch { return ''; }
  });
  if (frames.includes('passport.jd.com')) return 'login_required';
  return null;
}
