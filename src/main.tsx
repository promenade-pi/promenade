import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { startTheme } from './ui/theme';
// dockview's theme sets layout variables (tab-strip height among them) that
// our rules below are meant to override; imported first so the cascade's
// source-order tie-break goes to us, not to dockview's defaults.
import 'dockview-react/dist/styles/dockview.css';
import './styles.css';

// Caches the Pyodide runtime and its wheels in Cache Storage so a page
// reload does not re-download tens of MB from jsdelivr/PyPI every time. See
// public/pyodide-sw.js for what's cached and why.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/pyodide-sw.js').catch(() => {});
}

// Before the first render, so the resolved scheme and the dockview body
// class are already in place rather than arriving a frame late.
startTheme();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
