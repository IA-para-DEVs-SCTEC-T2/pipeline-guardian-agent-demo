export default function Filters({ filters, countries, onChange }) {
  const set = (key) => (event) => onChange({ ...filters, [key]: event.target.value });

  return (
    <section className="filters" aria-label="Filtros">
      <div className="field">
        <label htmlFor="filter-search">Buscar jogador</label>
        <input
          id="filter-search"
          type="search"
          placeholder="Nome do jogador"
          value={filters.search}
          onChange={set('search')}
        />
      </div>

      <div className="field">
        <label htmlFor="filter-country">País</label>
        <select id="filter-country" value={filters.country} onChange={set('country')}>
          <option value="">Todos</option>
          {countries.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="filter-status">Situação</label>
        <select id="filter-status" value={filters.status} onChange={set('status')}>
          <option value="all">Todas</option>
          <option value="obtained">Obtidas</option>
          <option value="missing">Faltantes</option>
          <option value="duplicate">Repetidas</option>
        </select>
      </div>
    </section>
  );
}
