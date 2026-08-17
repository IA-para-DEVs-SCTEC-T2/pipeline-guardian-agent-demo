import { datadogLogs } from '@datadog/browser-logs';

// `service` e `env` vão no init, não no contexto de cada log: assim TODO evento
// enviado pela aplicação — inclusive os botões do /lab — é pesquisável por
// `service:copa-figurinhas`. Só o client token (público) vive no frontend.
datadogLogs.init({
  clientToken: import.meta.env.VITE_DATADOG_CLIENT_TOKEN,
  site: 'us3.datadoghq.com',
  service: 'copa-figurinhas',
  env: 'lab',
  forwardErrorsToLogs: true,
  sessionSampleRate: 100,
});

datadogLogs.logger.info('copa_figurinhas_started', {
  service: 'copa-figurinhas',
  env: 'lab',
  event_type: 'health_check',
});