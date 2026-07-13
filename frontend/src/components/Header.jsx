export default function Header({ onShareReport }) {
  return (
    <header className="header">
      <div className="header__brand">
        <span className="header__logo" aria-hidden="true">⚽</span>
        <div>
          <h1 className="header__title">CopaFigurinhas</h1>
          <p className="header__subtitle">
            Gestão do seu álbum: acompanhe obtidas, faltantes e repetidas.
          </p>
        </div>
      </div>
      <button type="button" className="btn btn--gold" onClick={onShareReport}>
        Compartilhar relatório
      </button>
    </header>
  );
}
