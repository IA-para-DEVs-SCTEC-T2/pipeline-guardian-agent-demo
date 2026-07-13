import { z } from 'zod';

export const POSITIONS = ['goalkeeper', 'defender', 'midfielder', 'forward'];

/**
 * Schema para criação de uma figurinha (POST /api/stickers).
 * A unicidade de albumNumber é validada na camada de store.
 */
export const createStickerSchema = z.object({
  albumNumber: z
    .number({ invalid_type_error: 'albumNumber deve ser um número' })
    .int('albumNumber deve ser inteiro')
    .positive('albumNumber deve ser positivo'),
  playerName: z
    .string({ invalid_type_error: 'playerName deve ser texto' })
    .trim()
    .min(3, 'playerName deve ter no mínimo 3 caracteres')
    .max(80, 'playerName deve ter no máximo 80 caracteres'),
  country: z
    .string({ invalid_type_error: 'country deve ser texto' })
    .trim()
    .min(1, 'country é obrigatório'),
  countryCode: z
    .string({ invalid_type_error: 'countryCode deve ser texto' })
    .trim()
    .length(2, 'countryCode deve possuir exatamente duas letras')
    .regex(/^[A-Za-z]{2}$/, 'countryCode deve conter apenas letras')
    .transform((value) => value.toUpperCase()),
  position: z.enum(POSITIONS, {
    errorMap: () => ({ message: `position deve ser: ${POSITIONS.join(', ')}` }),
  }),
  quantity: z
    .number({ invalid_type_error: 'quantity deve ser um número' })
    .int('quantity deve ser inteiro')
    .min(0, 'quantity deve ser maior ou igual a zero')
    .optional()
    .default(0),
});

/**
 * Schema para o PATCH de quantidade (PATCH /api/stickers/:id/quantity).
 */
export const quantityOperationSchema = z.object({
  operation: z.enum(['increment', 'decrement'], {
    errorMap: () => ({ message: 'operation deve ser increment ou decrement' }),
  }),
});
