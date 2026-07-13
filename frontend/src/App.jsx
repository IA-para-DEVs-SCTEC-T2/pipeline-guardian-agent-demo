import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import { filterStickers, buildReportText } from './utils.js';
import { shareText, copyText } from './share.js';

import Header from './components/Header.jsx';
import Indicators from './components/Indicators.jsx';
import Filters from './components/Filters.jsx';
import StickerForm from './components/StickerForm.jsx';
import StickerGrid from './components/StickerGrid.jsx';
import Report from './components/Report.jsx';

export default function App() {
  const [stickers, setStickers] = useState([]);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [filters, setFilters] = useState({ search: '', country: '', status: 'all' });

  const notify = useCallback((message) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 2600);
  }, []);

  const refresh = useCallback(async () => {
    const [list, rep] = await Promise.all([api.listStickers(), api.getReport()]);
    setStickers(list);
    setReport(rep);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await refresh();
      } catch (err) {
        setError(err.message || 'Não foi possível conectar ao backend.');
      } finally {
        setLoading(false);
      }
    })();
  }, [refresh]);

  const countries = useMemo(
    () => [...new Set(stickers.map((s) => s.country))].sort((a, b) => a.localeCompare(b)),
    [stickers],
  );

  const visible = useMemo(() => filterStickers(stickers, filters), [stickers, filters]);

  async function handleCreate(payload) {
    setSubmitting(true);
    try {
      await api.createSticker(payload);
      await refresh();
      notify('Figurinha adicionada.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleQuantity(sticker, operation) {
    try {
      await api.changeQuantity(sticker.id, operation);
      await refresh();
    } catch (err) {
      notify(err.message);
    }
  }

  async function handleDelete(sticker) {
    if (!window.confirm(`Excluir a figurinha #${sticker.albumNumber} de ${sticker.playerName}?`)) return;
    try {
      await api.deleteSticker(sticker.id);
      await refresh();
      notify('Figurinha excluída.');
    } catch (err) {
      notify(err.message);
    }
  }

  async function handleShareReport() {
    const text = buildReportText(report);
    const result = await shareText({ text });
    if (result === 'copied') notify('Relatório copiado para a área de transferência.');
    else if (result === 'shared') notify('Relatório compartilhado.');
    else notify('Compartilhamento não suportado neste navegador.');
  }

  async function handleCopyReport() {
    const ok = await copyText(buildReportText(report));
    notify(ok ? 'Relatório copiado.' : 'Cópia não suportada.');
  }

  return (
    <div className="app">
      <div className="container">
        <Header onShareReport={handleShareReport} />

        {error && <div className="banner banner--error" role="alert">{error}</div>}
        {loading && <p className="muted">Carregando…</p>}

        {!loading && !error && (
          <>
            <Indicators report={report} />

            <div className="layout">
              <div className="layout__main">
                <Filters filters={filters} countries={countries} onChange={setFilters} />
                <StickerGrid
                  stickers={visible}
                  onIncrement={(s) => handleQuantity(s, 'increment')}
                  onDecrement={(s) => handleQuantity(s, 'decrement')}
                  onDelete={handleDelete}
                />
              </div>

              <aside className="layout__side">
                <StickerForm onCreate={handleCreate} submitting={submitting} />
              </aside>
            </div>

            <Report report={report} onCopy={handleCopyReport} onShare={handleShareReport} />
          </>
        )}
      </div>

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
