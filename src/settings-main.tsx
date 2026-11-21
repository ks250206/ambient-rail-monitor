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

import { SettingsPage, getSettingsTitle } from './SettingsPage.tsx';
import { DialogHost } from './components/DialogHost.tsx';
import { getLocale } from './i18n.ts';
import { installPageTransitions } from './utils/navigation.ts';

installPageTransitions();

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element #root not found');
}

const params = new URLSearchParams(window.location.search);
const view =
  container.dataset.page === 'workflow'
    ? 'workflow'
    : params.has('new')
      ? 'new'
      : params.get('project')
        ? 'projects'
        : 'list';
document.title = `${getSettingsTitle(view, getLocale())} — RAILFLOW | Science Tokyo`;

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <div className="page-transition-bar" aria-hidden="true" />
      <SettingsPage view={view} />
      <DialogHost />
    </QueryClientProvider>
  </StrictMode>,
);
