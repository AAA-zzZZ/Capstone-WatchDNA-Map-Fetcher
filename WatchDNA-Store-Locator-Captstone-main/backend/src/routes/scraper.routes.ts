import { Router } from 'express';
import { scraperController } from '../controllers/scraper.controller';

const router = Router();

// Brand config routes
router.get('/brands', scraperController.getBrands);

// Job management routes
router.post('/jobs', scraperController.createJob);
router.get('/jobs', scraperController.listJobs);
router.get('/jobs/:id', scraperController.getJob);
router.get('/jobs/:id/logs', scraperController.getJobLogs);
router.get('/jobs/:id/records', scraperController.getJobRecords);
router.patch('/jobs/:id/records', scraperController.saveJobRecords);
router.get('/jobs/:id/dropped-records', scraperController.getJobDroppedRecords);
router.post('/jobs/:id/cancel', scraperController.cancelJob);
router.delete('/jobs/:id', scraperController.deleteJob);

// Master CSV - distinct countries (optional brand / premium), records, update, remove
router.get('/master-csv/countries', scraperController.getMasterCsvCountries);
router.get('/master-csv/records', scraperController.getMasterCsvRecords);
router.patch('/master-csv', scraperController.updateMasterCsvRows);
router.delete('/master-csv/records', scraperController.deleteMasterRecord);

// Geo-verify + dedup pipeline for a brand
router.post('/verify-coordinates', scraperController.startVerifyCoordinates);
router.get('/verify-coordinates/:taskId', scraperController.getVerifyCoordinatesStatus);

// Statistics
router.get('/stats', scraperController.getStats);

// Endpoint discovery
router.post('/discover', scraperController.discoverEndpoints);
router.post('/probe-endpoint', scraperController.probeEndpoint);

// Brand configuration routes
router.get('/brands/:id', scraperController.getBrandConfig);
router.post('/brands', scraperController.saveBrandConfig);

export default router;
