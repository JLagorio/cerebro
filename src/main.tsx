import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { installErrorReporting } from './lib/diagnostics';
import './styles/index.css';

// M53.24: before the first render, so an error it throws reaches the
// diagnostic log.
installErrorReporting();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
