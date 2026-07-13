import { Router } from 'express';
import { buildReport } from '../services/report.js';
import { listStickers } from '../store/store.js';

const router = Router();

// GET /api/report
router.get('/', (req, res) => {
  res.json(buildReport(listStickers()));
});

export default router;
