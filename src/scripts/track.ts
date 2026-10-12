/**
 * First-party analytics beacon. No cookies, no ids, no third party: events queue here and go to
 * /api/hit every 10 seconds and when the page is hidden. The server adds the day, the country and
 * a day-salted visitor hash. Opting out: Do Not Track, or localStorage 'notrack' (the back office
 * sets it, so the owner's own visits are not counted).
 */
type Data = Record<string, string | number>;

const warn = (error: unknown) => {
  if (import.meta.env.DEV) console.warn('[track]', error);
};

function optedOut(): boolean {
  if (navigator.doNotTrack === '1') return true;
  try {
    return localStorage.getItem('notrack') !== null;
  } catch (error) {
    warn(error);
    return false;
  }
}

function init(): void {
  if (optedOut()) return;
  const queue: { name: string; data: Data }[] = [];

  const flush = () => {
    while (queue.length) {
      const body = JSON.stringify(queue.splice(0, 50));
      if (navigator.sendBeacon?.('/api/hit', new Blob([body], { type: 'application/json' }))) continue;
      fetch('/api/hit', {
        method: 'POST',
        body,
        keepalive: true,
        headers: { 'content-type': 'application/json' },
      }).catch(warn);
    }
  };

  const track = (name: string, data: Data = {}) => {
    queue.push({ name, data: { path: location.pathname, ...data } });
    if (queue.length >= 50) flush();
  };
  window.track = track;

  const from = document.referrer ? new URL(document.referrer).host.toLowerCase() : '';
  track('view', { path: location.pathname, ref: from === location.host ? 'internal' : from });

  // A section counts when it crosses the middle of the screen: a tall one can never be half visible.
  const sections = document.querySelectorAll('main > section[id]');
  if (sections.length) {
    const reached = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          reached.unobserve(entry.target);
          track('section', { id: entry.target.id });
        }
      },
      { rootMargin: '-50% 0px -50% 0px' },
    );
    sections.forEach((section) => reached.observe(section));
  }

  const onClick = (event: MouseEvent) => {
    if (event.button === 2) return;
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!(link instanceof HTMLAnchorElement)) return;
    const url = new URL(link.href);
    const own = url.origin === location.origin;
    const cv = /\.pdf$/i.test(url.pathname);
    const drive = own && url.pathname.startsWith('/drive');
    if (own && !cv && !drive) return;
    const mail = url.protocol === 'mailto:' || url.protocol === 'tel:';
    const kind = cv
      ? 'cv'
      : mail || link.closest('#contact')
        ? 'contact'
        : drive
          ? 'drive'
          : link.closest('#sites, [data-lightbox]')
            ? 'site'
            : 'out';
    const target = own || mail ? url.pathname : url.host.replace(/^www\./, '') + url.pathname;
    const label = (link.textContent || link.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    track('click', { href: target.replace(/(.)\/$/, '$1').slice(0, 100), label: label.slice(0, 40), kind });
  };
  document.addEventListener('click', onClick);
  document.addEventListener('auxclick', onClick);

  // One 'leave' per page load, at the first moment the page is hidden or unloaded: on phones
  // 'pagehide' often never fires for a tab that was only switched away from.
  let shownAt = document.hidden ? 0 : performance.now();
  let visibleMs = 0;
  let deepest = 0;
  let left = false;
  addEventListener('scroll', () => (deepest = Math.max(deepest, scrollY)), { passive: true });
  const pause = () => {
    if (shownAt) visibleMs += performance.now() - shownAt;
    shownAt = 0;
    if (!left) {
      left = true;
      const page = document.documentElement.scrollHeight || 1;
      track('leave', {
        secs: Math.round(visibleMs / 1000),
        depth: Math.min(100, Math.round(((deepest + innerHeight) / page) * 100)),
      });
    }
    flush();
  };
  document.addEventListener('visibilitychange', () => (document.hidden ? pause() : (shownAt = performance.now())));
  addEventListener('pagehide', pause);

  setInterval(flush, 10_000);
}

try {
  init();
} catch (error) {
  warn(error);
}

export {};
