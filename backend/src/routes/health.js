import { Router } from 'express';

const router = Router();

// GET /api/health
router.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'copa-figurinhas-backend',
    time: new Date().toISOString(),
    requestId: req.id,
  });
});

export default router;
