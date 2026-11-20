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

import { SettingsPage, settingsTitles } from './SettingsPage.tsx';

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
document.title = `${settingsTitles[view]} — RAILFLOW | Science Tokyo`;

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SettingsPage view={view} />
    </QueryClientProvider>
  </StrictMode>,
);
