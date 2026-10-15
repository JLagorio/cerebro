import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { DeepLinkHost } from './app/DeepLinkHost';
import { primeDeepLinks } from './app/deepLinks';
import { installErrorReporting } from './lib/diagnostics';
import './styles/index.css';

// M53.24: before the first render, so an error it throws reaches the
// diagnostic log. Prime app links before rendering so startup restoration
// yields while the OS inbox is being taken.
installErrorReporting();
void primeDeepLinks();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
    <DeepLinkHost />
  </React.StrictMode>,
);
