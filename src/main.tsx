import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { DeepLinkHost } from './app/DeepLinkHost';
import { primeDeepLinks } from './app/deepLinks';
import { RootBoundary } from './app/Contained';
import { installErrorReporting, reportCaughtError } from './lib/diagnostics';
import './styles/index.css';

// M53.24: before the first render, so an error it throws reaches the
// diagnostic log. Prime app links before rendering so startup restoration
// yields while the OS inbox is being taken.
installErrorReporting();
void primeDeepLinks();

// M93.12: a boundary's catch reaches React only, never `window`. Logged as
// React's default does, and sent to the diagnostic log under its bounds.
ReactDOM.createRoot(document.getElementById('root')!, {
  onCaughtError: (error, info) => {
    console.error(error);
    reportCaughtError(error, info.componentStack);
  },
}).render(
  <React.StrictMode>
    <RootBoundary>
      <App />
    </RootBoundary>
    <DeepLinkHost />
  </React.StrictMode>,
);
