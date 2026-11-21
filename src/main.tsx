import '@fontsource/noto-sans-jp/400.css';
import '@fontsource/noto-sans-jp/500.css';
import '@fontsource/noto-sans-jp/700.css';
import '@fontsource/hind/400.css';
import '@fontsource/hind/500.css';
import '@fontsource/hind/600.css';
import '@fontsource/hind/700.css';
import './index.css';

import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './api.ts';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { pageHref, readInitialProjectId } from './utils/workflow.ts';
import { installPageTransitions } from './utils/navigation.ts';
import { getLocale, pickText } from './i18n.ts';
import { AppHeader } from './components/AppHeader.tsx';
import { DialogHost } from './components/DialogHost.tsx';

installPageTransitions();

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element #root not found');
}

const page = container.dataset.page === 'jobs' ? 'jobs' : 'monitor';
const legacyPath = { '#board': '/jobs', '#workflow': '/workflow' } as const;
const legacyHash = window.location.hash;
if (page === 'monitor' && (legacyHash === '#board' || legacyHash === '#workflow')) {
  window.location.replace(pageHref(legacyPath[legacyHash], readInitialProjectId()));
} else if (page === 'monitor' && !window.location.search && !window.location.hash) {
  const { LandingPage } = await import('./LandingPage.tsx');
  createRoot(container).render(
    <StrictMode>
      <div className="page-transition-bar" aria-hidden="true" />
      <AppHeader currentPage="home" />
      <LandingPage />
      <DialogHost />
    </StrictMode>,
  );
} else {
  const locale = getLocale();
  document.title =
    page === 'monitor'
      ? `${pickText(locale, '実行モニター', 'Execution Monitor')} — RAILFLOW | Science Tokyo`
      : `${pickText(locale, 'ジョブ一覧', 'Jobs')} — RAILFLOW | Science Tokyo`;
  const { App } = await import('./App.tsx');
  createRoot(container).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <div className="page-transition-bar" aria-hidden="true" />
        <App page={page} />
        <DialogHost />
      </QueryClientProvider>
    </StrictMode>,
  );
}
