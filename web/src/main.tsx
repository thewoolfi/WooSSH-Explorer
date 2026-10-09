import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/shell.css';
import './styles/files.css';
import './styles/overlays.css';
import { AppShell } from './components/shell/AppShell';
import { initLocale } from './i18n';

// Applies the stored language (or the browser's) before the first paint, so the
// interface never flashes the wrong language.
initLocale();

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <AppShell />
  </StrictMode>,
);
