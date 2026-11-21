let installed = false;
let navigateTimer: number | undefined;
let recoveryTimer: number | undefined;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function clearNavigationTimers() {
  if (navigateTimer !== undefined) {
    window.clearTimeout(navigateTimer);
    navigateTimer = undefined;
  }
  if (recoveryTimer !== undefined) {
    window.clearTimeout(recoveryTimer);
    recoveryTimer = undefined;
  }
}

export function clearNavigationTransition() {
  clearNavigationTimers();
  if (typeof document !== 'undefined') {
    document.documentElement.classList.remove('is-navigating');
  }
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
  clearNavigationTimers();
  document.documentElement.classList.add('is-navigating');
  navigateTimer = window.setTimeout(() => {
    navigateTimer = undefined;
    go();
    // If navigation is cancelled (e.g. beforeunload prompt) or handled as an attachment download,
    // restore visibility instead of leaving the page faded out.
    recoveryTimer = window.setTimeout(() => {
      clearNavigationTransition();
    }, 900);
  }, 150);
}

/** Installs global click interception for same-origin MPA links to animate page exits. */
export function installPageTransitions() {
  if (installed || typeof window === 'undefined' || typeof document === 'undefined') return;
  installed = true;

  // Clear exit state when restored from bfcache or when unloading succeeds.
  window.addEventListener('pageshow', clearNavigationTransition);
  window.addEventListener('pagehide', clearNavigationTimers);

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
    if (url.pathname.startsWith('/api/')) return;
    if (url.pathname === window.location.pathname && url.search === window.location.search) return;
    if (prefersReducedMotion()) return;
    event.preventDefault();
    navigateWithTransition(url.href);
  });
}
