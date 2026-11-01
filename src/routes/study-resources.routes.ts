import { Router } from 'express';
import {
  createStudyResource,
  deleteStudyResource,
  getStudyResource,
  listStudyAreas,
  listStudyResources,
  updateStudyResource,
} from '../controllers/study-resources.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.use(requireAuth);
router.get('/areas', listStudyAreas);
router.get('/', listStudyResources);
router.post('/', createStudyResource);
router.get('/:id', getStudyResource);
router.patch('/:id', updateStudyResource);
router.delete('/:id', deleteStudyResource);

export default router;
