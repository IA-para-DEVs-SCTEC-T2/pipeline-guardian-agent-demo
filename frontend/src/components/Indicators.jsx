export default function Indicators({ report }) {
  const pct = report?.completionPercentage ?? 0;

  const cards = [
    { key: 'obtained', label: 'Obtidas', value: report?.obtained ?? 0, tone: 'green' },
    { key: 'missing', label: 'Faltantes', value: report?.missing ?? 0, tone: 'red' },
    { key: 'duplicates', label: 'Repetidas', value: report?.duplicateCopies ?? 0, tone: 'gold' },
  ];

  return (
    <section className="indicators" aria-label="Indicadores do álbum">
      <div className="indicator indicator--completion">
        <div className="indicator__label">Conclusão</div>
        <div className="indicator__value">{pct}%</div>
        <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="progress__bar" style={{ width: `${pct}%` }} />
        </div>
      </div>
      {cards.map((card) => (
        <div key={card.key} className={`indicator indicator--${card.tone}`}>
          <div className="indicator__label">{card.label}</div>
          <div className="indicator__value">{card.value}</div>
        </div>
      ))}
    </section>
  );
}
