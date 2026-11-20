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

import { WorkflowPage } from './WorkflowPage.tsx';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element #root not found');
}

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <WorkflowPage />
    </QueryClientProvider>
  </StrictMode>,
);
