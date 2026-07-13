import { Router } from 'express';
import { createStickerSchema, quantityOperationSchema } from '../schemas.js';
import { HttpError } from '../middleware/errorHandler.js';
import { duplicateCopies } from '../services/report.js';
import {
  albumNumberExists,
  changeQuantity,
  createSticker,
  deleteSticker,
  getSticker,
  listStickers,
} from '../store/store.js';

const router = Router();

/**
 * Enriquece a figurinha com o campo derivado duplicateCopies.
 */
function present(sticker) {
  return { ...sticker, duplicateCopies: duplicateCopies(sticker.quantity) };
}

// GET /api/stickers
router.get('/', (req, res) => {
  res.json(listStickers().map(present));
});

// GET /api/stickers/:id
router.get('/:id', (req, res) => {
  const sticker = getSticker(req.params.id);
  if (!sticker) throw new HttpError(404, 'NOT_FOUND', 'Figurinha não encontrada');
  res.json(present(sticker));
});

// POST /api/stickers
router.post('/', (req, res) => {
  const data = createStickerSchema.parse(req.body);

  if (albumNumberExists(data.albumNumber)) {
    throw new HttpError(
      400,
      'DUPLICATE_ALBUM_NUMBER',
      `Já existe uma figurinha com albumNumber ${data.albumNumber}`,
    );
  }

  const created = createSticker(data);
  res.status(201).json(present(created));
});

// PATCH /api/stickers/:id/quantity
router.patch('/:id/quantity', (req, res) => {
  const { operation } = quantityOperationSchema.parse(req.body);
  const updated = changeQuantity(req.params.id, operation);
  if (!updated) throw new HttpError(404, 'NOT_FOUND', 'Figurinha não encontrada');
  res.json(present(updated));
});

// DELETE /api/stickers/:id
router.delete('/:id', (req, res) => {
  const removed = deleteSticker(req.params.id);
  if (!removed) throw new HttpError(404, 'NOT_FOUND', 'Figurinha não encontrada');
  res.status(204).end();
});

export default router;
