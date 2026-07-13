export default function Report({ report, onCopy, onShare }) {
  if (!report) return null;

  return (
    <section className="card report">
      <div className="report__header">
        <h2 className="section-title">Relatório</h2>
        <div className="report__actions">
          <button type="button" className="btn btn--muted" onClick={onCopy}>Copiar</button>
          <button type="button" className="btn btn--gold" onClick={onShare}>Compartilhar</button>
        </div>
      </div>

      <div className="report__summary">
        <div><span className="report__num">{report.completionPercentage}%</span><small>conclusão</small></div>
        <div><span className="report__num">{report.obtained}</span><small>obtidas</small></div>
        <div><span className="report__num">{report.missing}</span><small>faltantes</small></div>
        <div><span className="report__num">{report.duplicateCopies}</span><small>repetidas</small></div>
      </div>

      <div className="report__columns">
        <div>
          <h3 className="report__subtitle">Faltantes ({report.missingStickers.length})</h3>
          {report.missingStickers.length === 0 ? (
            <p className="muted">Nenhuma faltante. 🎉</p>
          ) : (
            <ul className="report__list">
              {report.missingStickers.map((s) => (
                <li key={s.id}>
                  <span className="chip chip--country">{s.countryCode}</span>
                  #{s.albumNumber} {s.playerName}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h3 className="report__subtitle">Repetidas ({report.duplicateStickers.length})</h3>
          {report.duplicateStickers.length === 0 ? (
            <p className="muted">Nenhuma repetida.</p>
          ) : (
            <ul className="report__list">
              {report.duplicateStickers.map((s) => (
                <li key={s.id}>
                  <span className="chip chip--country">{s.countryCode}</span>
                  #{s.albumNumber} {s.playerName}
                  <strong className="report__dupes"> ×{s.duplicateCopies}</strong>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
