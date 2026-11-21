let installed = false;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** Smooth exit transition before full-page navigation when motion is enabled. */
export function navigateWithTransition(href: string, options: { replace?: boolean } = {}) {
  if (typeof window === 'undefined') return;
  const go = () => {
    if (options.replace) window.location.replace(href);
    else window.location.assign(href);
  };
  if (prefersReducedMotion() || typeof document === 'undefined') {
    go();
    return;
  }
  document.documentElement.classList.add('is-navigating');
  window.setTimeout(go, 150);
}

/** Installs global click interception for same-origin MPA links to animate page exits. */
export function installPageTransitions() {
  if (installed || typeof window === 'undefined' || typeof document === 'undefined') return;
  installed = true;

  // Clear exit state when restored from bfcache.
  window.addEventListener('pageshow', () => {
    document.documentElement.classList.remove('is-navigating');
  });

  document.addEventListener('click', (event) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const anchor = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[href]');
    if (!anchor) return;
    if (anchor.target && anchor.target !== '_self') return;
    if (anchor.hasAttribute('download')) return;
    const rawHref = anchor.getAttribute('href');
    if (!rawHref || rawHref.startsWith('#')) return;
    let url: URL;
    try {
      url = new URL(anchor.href, window.location.href);
    } catch {
      return;
    }
    if (url.origin !== window.location.origin) return;
    if (url.pathname === window.location.pathname && url.search === window.location.search) return;
    if (prefersReducedMotion()) return;
    event.preventDefault();
    navigateWithTransition(url.href);
  });
}
