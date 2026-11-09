import { Router } from 'express';
import employees from './hrEmployees.js';
import attendance from './hrAttendance.js';
import settings from './hrSettings.js';

const router = Router();
router.use('/employees', employees);
router.use('/', attendance);
router.use('/', settings);
export default router;
