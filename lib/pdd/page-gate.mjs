/**
 * Page-local PDD gate check, serialized into PDD page scripts as `(${pddPageGate})()`. Returns a code only, never page text.
 * None of these pages has been seen yet (the 2026-10-27 probe met none); the paths and phrases are PDD's known ones and
 * need confirming live. The side panel "用手机浏览器扫码在拼多多App打开" is on every desktop page and is not a gate.
 * @returns {'login_required'|'rate_limited'|'verification_required'|null}
 */
export function pddPageGate() {
  const visible = element => {
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  };
  const current = new URL(location.href);
  if (current.hostname === 'mobile.pinduoduo.com' && current.pathname === '/login.html') return 'login_required';
  if (current.hostname === 'mobile.pinduoduo.com' && ['/psnl_verification.html', '/verification.html'].includes(current.pathname)) {
    return 'verification_required';
  }
  // Gate pages are short, so their message is within the first visible text; a normal page's header never carries these phrases.
  const pageText = `${String(document.title).slice(0, 300)}\n${String(document.body?.innerText ?? '').slice(0, 2000)}`;
  if (/安全验证|拖动滑块|向右滑动|请完成验证|点击完成验证/.test(pageText)) return 'verification_required';
  if (/访问频繁|操作过于频繁|请求过于频繁|操作太频繁|网络繁忙/.test(pageText)) return 'rate_limited';
  const frames = [...document.querySelectorAll('iframe')].filter(visible).map(frame => {
    try { return new URL(frame.getAttribute('src'), location.href).pathname; } catch { return ''; }
  });
  if (frames.includes('/login.html')) return 'login_required';
  return null;
}
