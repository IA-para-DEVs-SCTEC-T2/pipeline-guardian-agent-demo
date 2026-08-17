import React from 'react';
import { createRoot } from 'react-dom/client';

// Inicializa o Datadog Browser Logs antes de qualquer componente montar.
import './datadog.js';

import App from './App.jsx';
import Lab from './pages/Lab.jsx';
import './styles.css';

/**
 * Roteamento mínimo — sem React Router.
 *
 * A escolha da página acontece AQUI, no escopo do módulo, antes do render:
 * nenhum hook é executado condicionalmente e o `App.jsx` continua sendo o
 * componente da aplicação original, sem saber que o laboratório existe.
 */
const path = window.location.pathname;
const isLab = path === '/lab' || path === '/lab/';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isLab ? <Lab /> : <App />}
  </React.StrictMode>,
);
