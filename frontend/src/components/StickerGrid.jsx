import StickerCard from './StickerCard.jsx';

export default function StickerGrid({ stickers, onIncrement, onDecrement, onDelete }) {
  if (stickers.length === 0) {
    return <p className="empty-state">Nenhuma figurinha corresponde aos filtros.</p>;
  }

  return (
    <div className="grid">
      {stickers.map((sticker) => (
        <StickerCard
          key={sticker.id}
          sticker={sticker}
          onIncrement={onIncrement}
          onDecrement={onDecrement}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}
