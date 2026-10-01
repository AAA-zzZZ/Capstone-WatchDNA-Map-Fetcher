import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import type { AuthRequest } from '../middleware/auth.middleware';
import uploadService from '../services/upload.service';
import { masterExportFiltersFromQuery } from '../utils/parse-master-export-query';

export class UploadController {

  /**
   * POST /api/uploads/manual-store — JSON body; same pipeline as CSV upload (validate_csv + importFromCSV).
   */
  async createManualStore(req: AuthRequest, res: Response): Promise<void> {
    try {
      const result = await uploadService.submitManualStoreLocation(req.body, req.user?.username);

      if (!result.ok && result.reason === 'bad_input') {
        res.status(400).json({ success: false, error: result.message });
        return;
      }

      if (!result.ok && result.reason === 'validation_failed') {
        res.status(422).json({
          success: false,
          error: 'validation_failed',
          uploadId: result.uploadId,
          errors: result.errors,
          warnings: result.warnings,
        });
        return;
      }

      if (!result.ok && result.reason === 'import_failed') {
        res.status(422).json({
          success: false,
          error: 'import_failed',
          uploadId: result.uploadId,
          message: result.message,
          importResult: result.importResult,
        });
        return;
      }

      res.status(201).json({
        success: true,
        uploadId: result.uploadId,
        store: result.store,
        importResult: result.importResult,
        warnings: result.warnings,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Manual store error:', error);
      res.status(500).json({ success: false, error: message });
    }
  }

  /**
   * POST /api/uploads/geocode-address — forward-geocode for manual add-store form (admin).
   */
  async geocodeAddress(req: AuthRequest, res: Response): Promise<void> {
    try {
      const result = await uploadService.geocodeManualFormAddress(req.body);
      if (!result.ok) {
        const status =
          result.code === 'bad_input'
            ? 400
            : result.code === 'unconfigured'
              ? 503
              : result.code === 'not_found'
                ? 404
                : 502;
        res.status(status).json({
          success: false,
          error: result.code,
          message: result.message,
        });
        return;
      }
      res.status(200).json({
        success: true,
        latitude: result.latitude,
        longitude: result.longitude,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Geocode address error:', error);
      res.status(500).json({ success: false, error: message });
    }
  }

  async uploadCSV(req: Request, res: Response) {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const file = req.file;

      // Create upload record
      const upload = await uploadService.createUpload({
        filename: file.filename,
        originalFilename: file.originalname,
        fileSize: file.size,
        uploadedBy: req.body.uploadedBy || 'admin'
      });

      // Start validation asynchronously
      uploadService.processUpload(upload.id, file.path)
        .catch(err => {
          console.error('Background validation error:', err);
        });

      res.status(201).json({
        success: true,
        upload: {
          id: upload.id,
          filename: upload.originalFilename,
          status: upload.status,
          uploadedAt: upload.uploadedAt
        },
        message: 'File uploaded successfully. Validation in progress.'
      });

    } catch (error: any) {
      console.error('Upload error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  async getUpload(req: Request, res: Response) {
    try {
      const { id } = req.params;

      const upload = await uploadService.getUpload(id);

      if (!upload) {
        return res.status(404).json({ error: 'Upload not found' });
      }

      // Parse JSON fields
      const response = {
        ...upload,
        validationErrors: upload.validationErrors ? JSON.parse(upload.validationErrors) : [],
        validationWarnings: upload.validationWarnings ? JSON.parse(upload.validationWarnings) : []
      };

      res.json(response);

    } catch (error: any) {
      console.error('Get upload error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  async listUploads(req: Request, res: Response) {
    try {
      const { page, limit, status } = req.query;

      const result = await uploadService.listUploads({
        page: page ? parseInt(page as string) : undefined,
        limit: limit ? parseInt(limit as string) : undefined,
        status: status as string
      });

      // Parse JSON fields so frontend gets arrays, not string lengths
      result.uploads = result.uploads.map((u: any) => ({
        ...u,
        validationErrors: u.validationErrors ? JSON.parse(u.validationErrors) : [],
        validationWarnings: u.validationWarnings ? JSON.parse(u.validationWarnings) : []
      }));

      res.json(result);

    } catch (error: any) {
      console.error('List uploads error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  async getValidationLogs(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { logType, page, limit } = req.query;

      const result = await uploadService.getValidationLogs(id, {
        logType: logType as string,
        page: page ? parseInt(page as string) : undefined,
        limit: limit ? parseInt(limit as string) : undefined
      });

      res.json(result);

    } catch (error: any) {
      console.error('Get validation logs error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  async deleteUpload(req: Request, res: Response) {
    try {
      const { id } = req.params;

      await uploadService.deleteUpload(id);

      res.json({ success: true, message: 'Upload deleted successfully' });

    } catch (error: any) {
      console.error('Delete upload error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  async getStats(req: Request, res: Response) {
    try {
      const stats = await uploadService.getStats();
      res.json(stats);
    } catch (error: any) {
      console.error('Get stats error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  async downloadUpload(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const upload = await uploadService.getUpload(id);

      if (!upload) {
        return res.status(404).json({ error: 'Upload not found' });
      }

      const filePath = await uploadService.getFilePath(upload.filename);
      
      if (!filePath) {
        return res.status(404).json({ error: 'File path could not be resolved' });
      }

      if (!fs.existsSync(filePath)) {
        console.error(`File not found at path: ${filePath}`);
        return res.status(404).json({ error: 'File not found on server' });
      }

      // Get file stats for Content-Length header
      const stats = fs.statSync(filePath);
      
      // Set headers for file download
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${upload.originalFilename}"`);
      res.setHeader('Content-Length', stats.size.toString());
      
      // Send file with error handling (filePath is already absolute from service)
      res.sendFile(filePath, (err) => {
        if (err) {
          console.error('Error sending file:', err);
          if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to send file' });
          }
        }
      });
    } catch (error: any) {
      console.error('Download upload error:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: error.message });
      }
    }
  }

  async downloadMasterCSV(req: Request, res: Response) {
    try {
      const { storeService } = await import('../services/store.service.js');
      const filters = masterExportFiltersFromQuery(req);
      const csvContent = await storeService.generateDownloadCSV(filters);

      const contentLength = Buffer.byteLength(csvContent, 'utf-8');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="master_stores.csv"');
      res.setHeader('Content-Length', contentLength.toString());
      res.send(csvContent);
    } catch (error: any) {
      console.error('Download master CSV error:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: error.message });
      }
    }
  }

  async revalidateUpload(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { autoFix, checkUrls } = req.body;

      const result = await uploadService.revalidateUpload(id, {
        autoFix: autoFix !== undefined ? Boolean(autoFix) : true,
        checkUrls: checkUrls !== undefined ? Boolean(checkUrls) : false
      });

      res.json({
        ...result,
        message: 'Re-validation completed'
      });

    } catch (error: any) {
      console.error('Re-validate upload error:', error);
      res.status(500).json({ error: error.message });
    }
  }
}

export default new UploadController();
