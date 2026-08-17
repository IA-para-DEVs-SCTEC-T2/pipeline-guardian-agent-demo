import { useState } from 'react';
import { datadogLogs } from '@datadog/browser-logs';

export default function Lab() {
  const [ultimoEvento, setUltimoEvento] = useState('—');
  const [status, setStatus] = useState('Aguardando');
  const [simulando, setSimulando] = useState(false);

  function registrarEvento(nome) {
    setUltimoEvento(nome);
    setStatus('Enviado para observabilidade');
  }

  function gerarEventoSaudavel() {
    datadogLogs.logger.info('health_check', {
      event_type: 'health_check',
      route: '/lab',
    });

    registrarEvento('health_check');
  }

  function simularErro() {
    datadogLogs.logger.error('lab_error', {
      event_type: 'lab_error',
      status_code: 500,
      error_type: 'SimulatedError',
      route: '/lab',
    });

    registrarEvento('lab_error');
  }

  async function simularLatencia() {
    setSimulando(true);
    setStatus('Simulando latência…');

    await new Promise((resolve) => setTimeout(resolve, 2500));

    datadogLogs.logger.warn('lab_slow', {
      event_type: 'lab_slow',
      status_code: 200,
      duration_ms: 2500,
      route: '/lab',
    });

    registrarEvento('lab_slow');
    setSimulando(false);
  }

  return (
    <main>
      <h1>CopaFigurinhas Lab</h1>

      <p>Laboratório controlado para demonstrações de SRE.</p>

      <div>
        <button onClick={gerarEventoSaudavel}>
          Gerar evento saudável
        </button>

        <button onClick={simularErro}>
          Simular erro
        </button>

        <button onClick={simularLatencia} disabled={simulando}>
          Simular latência
        </button>
      </div>

      <section>
        <p>
          <strong>Último evento:</strong> {ultimoEvento}
        </p>

        <p>
          <strong>Status:</strong> {status}
        </p>
      </section>
    </main>
  );
}