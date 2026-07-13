import { getInitials, stickerStatus, POSITION_LABELS } from '../utils.js';

const STATUS_LABELS = {
  missing: 'Faltante',
  obtained: 'Obtida',
  duplicate: 'Repetida',
};

export default function StickerCard({ sticker, onIncrement, onDecrement, onDelete }) {
  const status = stickerStatus(sticker);

  return (
    <article className={`sticker sticker--${status}`}>
      <div className="sticker__top">
        <span className="sticker__number">#{sticker.albumNumber}</span>
        <span className={`badge badge--${status}`}>{STATUS_LABELS[status]}</span>
      </div>

      <div className="sticker__body">
        <div className="sticker__initials" aria-hidden="true">
          {getInitials(sticker.playerName)}
        </div>
        <div className="sticker__info">
          <h3 className="sticker__name">{sticker.playerName}</h3>
          <p className="sticker__meta">
            <span className="chip chip--country">{sticker.countryCode}</span>
            {sticker.country}
          </p>
          <p className="sticker__position">{POSITION_LABELS[sticker.position]}</p>
        </div>
      </div>

      <div className="sticker__counts">
        <span>Quantidade: <strong>{sticker.quantity}</strong></span>
        <span>Repetidas: <strong>{sticker.duplicateCopies}</strong></span>
      </div>

      <div className="sticker__actions">
        <button type="button" className="btn btn--icon btn--green" aria-label="Incrementar" onClick={() => onIncrement(sticker)}>+</button>
        <button type="button" className="btn btn--icon btn--muted" aria-label="Decrementar" disabled={sticker.quantity === 0} onClick={() => onDecrement(sticker)}>−</button>
        <button type="button" className="btn btn--icon btn--red" aria-label="Excluir" onClick={() => onDelete(sticker)}>✕</button>
      </div>
    </article>
  );
}
