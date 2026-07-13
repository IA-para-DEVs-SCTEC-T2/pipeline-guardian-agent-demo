import { useState } from 'react';
import { POSITIONS, POSITION_LABELS } from '../utils.js';

const EMPTY = {
  albumNumber: '',
  playerName: '',
  country: '',
  countryCode: '',
  position: 'goalkeeper',
  quantity: '0',
};

export default function StickerForm({ onCreate, submitting }) {
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState('');

  const set = (key) => (event) => setForm((f) => ({ ...f, [key]: event.target.value }));

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');

    const payload = {
      albumNumber: Number(form.albumNumber),
      playerName: form.playerName.trim(),
      country: form.country.trim(),
      countryCode: form.countryCode.trim(),
      position: form.position,
      quantity: Number(form.quantity),
    };

    try {
      await onCreate(payload);
      setForm(EMPTY);
    } catch (err) {
      const detail = err.details?.[0]?.message;
      setError(detail || err.message);
    }
  }

  return (
    <section className="card form-card">
      <h2 className="section-title">Adicionar figurinha</h2>
      <form className="sticker-form" onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="albumNumber">Número no álbum</label>
          <input id="albumNumber" type="number" min="1" required value={form.albumNumber} onChange={set('albumNumber')} />
        </div>

        <div className="field field--wide">
          <label htmlFor="playerName">Nome do jogador</label>
          <input id="playerName" type="text" minLength={3} maxLength={80} required value={form.playerName} onChange={set('playerName')} />
        </div>

        <div className="field">
          <label htmlFor="country">País</label>
          <input id="country" type="text" required value={form.country} onChange={set('country')} />
        </div>

        <div className="field">
          <label htmlFor="countryCode">Código do país</label>
          <input id="countryCode" type="text" maxLength={2} placeholder="BR" required value={form.countryCode} onChange={set('countryCode')} />
        </div>

        <div className="field">
          <label htmlFor="position">Posição</label>
          <select id="position" value={form.position} onChange={set('position')}>
            {POSITIONS.map((p) => (
              <option key={p} value={p}>{POSITION_LABELS[p]}</option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="quantity">Quantidade inicial</label>
          <input id="quantity" type="number" min="0" value={form.quantity} onChange={set('quantity')} />
        </div>

        {error && <p className="form-error" role="alert">{error}</p>}

        <div className="form-actions">
          <button type="submit" className="btn btn--green" disabled={submitting}>
            {submitting ? 'Salvando…' : 'Adicionar'}
          </button>
        </div>
      </form>
    </section>
  );
}
