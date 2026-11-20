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
import { AppHeader } from './components/AppHeader.tsx';

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
      <AppHeader currentPage="home" />
      <LandingPage />
    </StrictMode>,
  );
} else {
  if (page === 'monitor') document.title = '実行モニター — RAILFLOW | Science Tokyo';
  const { App } = await import('./App.tsx');
  createRoot(container).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App page={page} />
      </QueryClientProvider>
    </StrictMode>,
  );
}
