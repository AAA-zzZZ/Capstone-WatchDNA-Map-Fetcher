import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import Papa from 'papaparse';
import validationService from './validation.service';
import locationService, { type ImportResult } from './location.service';
import prisma from '../lib/prisma';
import { logger } from '../utils/logger';
import { locationToCSVRow } from '../utils/csv-to-location';
import { normalizeScraperRowsForCsv } from '../utils/stable-handle';
import {
  VALIDATION_MANUAL_UPLOAD,
  VALIDATION_REVALIDATE_DEFAULT,
} from '../config/validation-policy';
import type { Prisma } from '@prisma/client';
import { readGeoVerifyConfig } from '../config/geo-verify';
import type { GeocodeAddressInput } from '../utils/geocode-address-format';
import { geocodeAddressNominatim } from '../utils/nominatim-geocode';
import { geocodeAddressPhoton } from '../utils/photon-geocode';

export type ManualLocationPayload = {
  name: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  stateProvinceRegion: string;
  postalCode: string;
  country: string;
  phone: string;
  email: string;
  website: string;
  latitude: number;
  longitude: number;
  brands: string;
  tags: string;
  pageTitle: string;
  pageDescription: string;
  status: boolean;
  handle: string;
};

const GEOCODE_REQUEST_TIMEOUT_MS = 25_000;

function parseGeocodeManualBody(
  body: unknown
): { ok: true; input: GeocodeAddressInput } | { ok: false; message: string } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: 'Request body must be a JSON object' };
  }
  const o = body as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string).trim() : '');
  const country = str('country');
  if (!country) {
    return { ok: false, message: 'country is required' };
  }

  const fullAddress = str('fullAddress');
  const addressLine1 = str('addressLine1');
  const addressLine2 = str('addressLine2');
  const city = str('city');

  if (fullAddress) {
    return {
      ok: true,
      input: {
        addressLine1: fullAddress,
        addressLine2: null,
        city,
        stateProvinceRegion: str('stateProvinceRegion') || null,
        postalCode: str('postalCode') || null,
        country,
      },
    };
  }

  if (!city) {
    return { ok: false, message: 'city is required (or provide a one-line address in fullAddress)' };
  }
  if (!addressLine1 && !addressLine2) {
    return {
      ok: false,
      message: 'Enter address line 1 and/or 2, or paste a full address in fullAddress',
    };
  }

  const line1 = addressLine1 || addressLine2;
  const line2 = addressLine1 ? (addressLine2 || null) : null;

  return {
    ok: true,
    input: {
      addressLine1: line1,
      addressLine2: line2,
      city,
      stateProvinceRegion: str('stateProvinceRegion') || null,
      postalCode: str('postalCode') || null,
      country,
    },
  };
}

function parseManualLocationBody(
  body: unknown
): { ok: true; data: ManualLocationPayload } | { ok: false; message: string } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: 'Request body must be a JSON object' };
  }
  const o = body as Record<string, unknown>;

  const name = typeof o.name === 'string' ? o.name.trim() : '';
  const city = typeof o.city === 'string' ? o.city.trim() : '';
  const country = typeof o.country === 'string' ? o.country.trim() : '';
  if (!name) return { ok: false, message: 'name is required' };
  if (!city) return { ok: false, message: 'city is required' };
  if (!country) return { ok: false, message: 'country is required' };

  const latRaw = o.latitude;
  const lonRaw = o.longitude;
  const latitude =
    typeof latRaw === 'number' ? latRaw : latRaw != null ? parseFloat(String(latRaw)) : NaN;
  const longitude =
    typeof lonRaw === 'number' ? lonRaw : lonRaw != null ? parseFloat(String(lonRaw)) : NaN;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { ok: false, message: 'latitude and longitude must be valid numbers' };
  }

  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string).trim() : '');
  const addressLine1 = str('addressLine1');
  const addressLine2 = str('addressLine2');
  if (!addressLine1 && !addressLine2) {
    return { ok: false, message: 'At least one of addressLine1 or addressLine2 is required' };
  }

  let brandsField = '';
  if (Array.isArray(o.brands)) {
    brandsField = o.brands.map((x) => String(x).trim()).filter(Boolean).join(', ');
  } else {
    brandsField = str('brands');
  }

  const status =
    o.status === false || o.status === 'false' || o.status === 0 ? false : true;

  return {
    ok: true,
    data: {
      name,
      addressLine1,
      addressLine2,
      city,
      stateProvinceRegion: str('stateProvinceRegion'),
      postalCode: str('postalCode'),
      country,
      phone: o.phone === null || o.phone === undefined ? '' : String(o.phone).trim(),
      email: str('email'),
      website: str('website'),
      latitude,
      longitude,
      brands: brandsField,
      tags: str('tags'),
      pageTitle: str('pageTitle'),
      pageDescription: str('pageDescription'),
      status,
      handle: str('handle'),
    },
  };
}

function manualPayloadToCsvRow(data: ManualLocationPayload): Record<string, string> {
  const base = locationToCSVRow({});
  const handle =
    data.handle ||
    `manual_pending_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  return {
    ...base,
    Handle: handle,
    Name: data.name,
    Status: data.status ? 'true' : 'false',
    'Address Line 1': data.addressLine1,
    'Address Line 2': data.addressLine2,
    City: data.city,
    'State/Province/Region': data.stateProvinceRegion,
    'Postal/ZIP Code': data.postalCode,
    Country: data.country,
    Phone: data.phone,
    Email: data.email,
    Website: data.website,
    Latitude: String(data.latitude),
    Longitude: String(data.longitude),
    Brands: data.brands,
    Tags: data.tags,
    'Page Title': data.pageTitle,
    'Page Description': data.pageDescription,
  };
}

/** Bootstrap / legacy rows — master data lives in DB; hide from lists and stats. */
const EXCLUDE_FROM_LISTING: Prisma.UploadWhereInput = {
  NOT: {
    originalFilename: { equals: 'master_stores.csv', mode: 'insensitive' },
  },
};

/**
 * Pre-normalize an uploaded CSV in-place before validation:
 * - Normalize Country to canonical name and Phone to E.164
 * - Generate stable loc_* handles for complete rows (same rules as scraper pipeline)
 * - Rows missing required fields (Name, coords, address) keep their original Handle so
 *   validation can still flag them with a useful row number and field name.
 *
 * This mirrors what scraperService does with normalizeScraperRowsForCsv before calling
 * validationService.validateCSV. Without this step, rows without Handle fail validation
 * immediately because Handle is a required field in DEFAULT_REQUIRED_DB_IMPORT.
 */
async function preNormalizeCsvFile(filePath: string): Promise<void> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return;
  }
  const parsed = Papa.parse(content, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h: string) => h.trim(),
  });
  if (!parsed.data || (parsed.data as unknown[]).length === 0) return;
  const rows = parsed.data as Record<string, string>[];
  const normalized = normalizeScraperRowsForCsv(rows);
  const output = Papa.unparse(normalized, { header: true });
  await fs.writeFile(filePath, output, 'utf-8');
}

export class UploadService {

  async createUpload(fileInfo: {
    filename: string;
    originalFilename: string;
    fileSize: number;
    uploadedBy?: string;
    scraperType?: string | null;
  }) {
    return prisma.upload.create({
      data: {
        filename: fileInfo.filename,
        originalFilename: fileInfo.originalFilename,
        fileSize: fileInfo.fileSize,
        uploadedBy: fileInfo.uploadedBy || 'admin',
        status: 'pending',
        ...(fileInfo.scraperType ? { scraperType: fileInfo.scraperType } : {}),
      }
    });
  }

  /**
   * One-row CSV → same path as admin CSV upload: Python validate_csv (--fix, --db-import-parity),
   * then locationService.importFromCSV → storeService.batchUpsertLocations (manual merge, dedupe, premium reapply).
   */
  async submitManualStoreLocation(
    body: unknown,
    uploadedBy?: string
  ): Promise<
    | {
        ok: true;
        uploadId: string;
        store: { handle: string; name: string } | null;
        importResult: ImportResult;
        warnings: { type?: string; message: string; row?: number }[];
      }
    | {
        ok: false;
        reason: 'bad_input';
        message: string;
      }
    | {
        ok: false;
        reason: 'validation_failed';
        uploadId: string;
        errors: { row: number; field: string; issue: string; value?: string }[];
        warnings: { type?: string; message: string }[];
      }
    | {
        ok: false;
        reason: 'import_failed';
        uploadId: string;
        message: string;
        importResult: ImportResult;
      }
  > {
    const parsed = parseManualLocationBody(body);
    if (!parsed.ok) {
      return { ok: false, reason: 'bad_input', message: parsed.message };
    }

    const row = manualPayloadToCsvRow(parsed.data);
    const csvContent = Papa.unparse([row], { header: true });
    const uploadDir = path.join(__dirname, '..', '..', process.env.UPLOAD_DIR || 'uploads');
    await fs.mkdir(uploadDir, { recursive: true });
    const filename = `manual-${randomUUID()}.csv`;
    const absPath = path.resolve(path.join(uploadDir, filename));
    if (!absPath.startsWith(path.resolve(uploadDir))) {
      return { ok: false, reason: 'bad_input', message: 'Invalid upload path' };
    }

    const upload = await this.createUpload({
      filename,
      originalFilename: `manual_store_${parsed.data.name.slice(0, 60).replace(/[^\w\- ]+/g, '_')}.csv`,
      fileSize: Buffer.byteLength(csvContent, 'utf8'),
      uploadedBy,
      scraperType: 'manual_form',
    });

    try {
      await fs.writeFile(absPath, csvContent, 'utf8');

      await prisma.upload.update({
        where: { id: upload.id },
        data: { status: 'validating' },
      });

      logger.info(`[Upload ${upload.id}] Manual store — validating...`);
      const validationResult = await validationService.validateCSV(absPath, VALIDATION_MANUAL_UPLOAD);
      logger.info(
        `[Upload ${upload.id}] Manual store validation ${validationResult.valid ? 'passed' : 'failed'} — ` +
          `errors: ${validationResult.errors.length}`
      );

      const updateData = validationService.formatForDatabase(validationResult);
      await prisma.upload.update({ where: { id: upload.id }, data: updateData });

      const logs = validationService.createValidationLogs(upload.id, validationResult);
      if (logs.length > 0) {
        await prisma.validationLog.createMany({ data: logs });
      }

      if (!validationResult.valid) {
        return {
          ok: false,
          reason: 'validation_failed',
          uploadId: upload.id,
          errors: validationResult.errors,
          warnings: validationResult.warnings,
        };
      }

      let importResult: ImportResult;
      try {
        importResult = await locationService.importFromCSV(absPath, upload.id);
      } catch (importErr: unknown) {
        const msg = importErr instanceof Error ? importErr.message : String(importErr);
        logger.error(`[Upload ${upload.id}] Manual store import failed:`, msg);
        await prisma.upload.update({
          where: { id: upload.id },
          data: {
            status: 'failed',
            validationErrors: JSON.stringify([{ issue: 'import_error', message: msg }]),
          },
        });
        return {
          ok: false,
          reason: 'import_failed',
          uploadId: upload.id,
          message: msg,
          importResult: {
            success: false,
            newCount: 0,
            updatedCount: 0,
            unchangedCount: 0,
            skippedCount: 0,
            errorCount: 1,
            errors: [msg],
          },
        };
      }

      const rowsProcessed =
        importResult.newCount + importResult.updatedCount + importResult.unchangedCount;
      const rowsFailed = importResult.skippedCount + importResult.errorCount;

      await prisma.upload.update({
        where: { id: upload.id },
        data: {
          status: 'completed',
          rowsProcessed,
          rowsFailed,
        },
      });

      if (rowsProcessed === 0) {
        return {
          ok: false,
          reason: 'import_failed',
          uploadId: upload.id,
          message:
            'No row was written to the database (incomplete row after validation, or all rows skipped).',
          importResult,
        };
      }

      const store = await prisma.location.findFirst({
        where: { uploadId: upload.id },
        orderBy: { updatedAt: 'desc' },
        select: { handle: true, name: true },
      });

      return {
        ok: true,
        uploadId: upload.id,
        store,
        importResult,
        warnings: validationResult.warnings,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[Upload ${upload.id}] Manual store pipeline failed:`, msg);
      await prisma.upload.update({
        where: { id: upload.id },
        data: {
          status: 'failed',
          validationErrors: JSON.stringify([{ issue: 'processing_error', message: msg }]),
        },
      });
      return {
        ok: false,
        reason: 'import_failed',
        uploadId: upload.id,
        message: msg,
        importResult: {
          success: false,
          newCount: 0,
          updatedCount: 0,
          unchangedCount: 0,
          skippedCount: 0,
          errorCount: 1,
          errors: [msg],
        },
      };
    }
  }

  /**
   * Single forward-geocode for the manual-add-store form (Photon or Nominatim from geo-verify config).
   */
  async geocodeManualFormAddress(body: unknown): Promise<
    | { ok: true; latitude: number; longitude: number }
    | { ok: false; code: 'bad_input' | 'unconfigured' | 'not_found' | 'upstream'; message: string }
  > {
    const parsed = parseGeocodeManualBody(body);
    if (!parsed.ok) {
      return { ok: false, code: 'bad_input', message: parsed.message };
    }

    const config = readGeoVerifyConfig();
    if (!config.nominatimUserAgent) {
      return {
        ok: false,
        code: 'unconfigured',
        message:
          'Geocoding is not configured. Set NOMINATIM_USER_AGENT in backend config (see src/config/geo-verify.ts).',
      };
    }

    const signal = AbortSignal.timeout(GEOCODE_REQUEST_TIMEOUT_MS);

    try {
      const point =
        config.geocoder === 'photon'
          ? await geocodeAddressPhoton(parsed.input, {
              baseUrl: config.photonBaseUrl,
              userAgent: config.nominatimUserAgent,
              signal,
            })
          : await geocodeAddressNominatim(parsed.input, {
              baseUrl: config.nominatimBaseUrl,
              userAgent: config.nominatimUserAgent,
              minIntervalMs: config.minIntervalMs,
              signal,
            });

      if (!point) {
        return {
          ok: false,
          code: 'not_found',
          message:
            'Could not find coordinates for this address. Add more detail (postal code, region) or enter latitude and longitude manually.',
        };
      }

      return { ok: true, latitude: point.lat, longitude: point.lon };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(`[Upload] Manual geocode failed: ${msg}`);
      return {
        ok: false,
        code: 'upstream',
        message:
          msg.includes('abort') || msg.includes('Timeout')
            ? 'Geocoding timed out. Try again or enter coordinates manually.'
            : `Geocoding failed: ${msg}`,
      };
    }
  }

  async processUpload(uploadId: string, filePath: string) {
    try {
      await prisma.upload.update({
        where: { id: uploadId },
        data: { status: 'validating' }
      });

      // Pre-normalize before validation: generate stable handles for complete rows,
      // normalize Country/Phone — same step the scraper does before validateCSV.
      await preNormalizeCsvFile(filePath);

      logger.info(`[Upload ${uploadId}] Validating...`);
      const validationResult = await validationService.validateCSV(filePath, VALIDATION_MANUAL_UPLOAD);
      logger.info(`[Upload ${uploadId}] Validation ${validationResult.valid ? 'passed' : 'failed'} — errors: ${validationResult.errors.length}, warnings: ${validationResult.warnings.length}`);

      const updateData = validationService.formatForDatabase(validationResult);
      await prisma.upload.update({ where: { id: uploadId }, data: updateData });

      const logs = validationService.createValidationLogs(uploadId, validationResult);
      if (logs.length > 0) {
        await prisma.validationLog.createMany({ data: logs });
      }

      let importResult: ImportResult | null = null;
      let importError: string | null = null;
      if (updateData.status === 'valid') {
        logger.info(`[Upload ${uploadId}] Importing to DB...`);
        try {
          importResult = await locationService.importFromCSV(filePath, uploadId);
          logger.info(
            `[Upload ${uploadId}] Import done — new: ${importResult.newCount}, updated: ${importResult.updatedCount}, ` +
              `unchanged: ${importResult.unchangedCount}`
          );
          const rowsFailed = importResult.skippedCount + importResult.errorCount;
          const rowsProcessed =
            importResult.newCount + importResult.updatedCount + importResult.unchangedCount;
          await prisma.upload.update({
            where: { id: uploadId },
            data: {
              status: 'completed',
              rowsProcessed,
              rowsFailed,
            }
          });
          if (rowsFailed > 0) {
            logger.warn(
              `[Upload ${uploadId}] Import finished with ${rowsFailed} row(s) not written ` +
                `(skipped incomplete or DB errors); see import logs / errors on upload`
            );
          }
        } catch (err: unknown) {
          importError = err instanceof Error ? err.message : String(err);
          logger.error(`[Upload ${uploadId}] Import failed:`, importError);
          await prisma.upload.update({
            where: { id: uploadId },
            data: {
              status: 'failed',
              validationErrors: JSON.stringify([{ issue: 'import_error', message: importError }]),
            },
          });
        }
      }

      const importSucceeded = updateData.status !== 'valid' || importResult !== null;
      return {
        success: importSucceeded,
        uploadId,
        validationResult,
        importResult,
        importError,
      };

    } catch (error: any) {
      logger.error(`[Upload ${uploadId}] Processing failed:`, error.message);
      await prisma.upload.update({
        where: { id: uploadId },
        data: {
          status: 'failed',
          validationErrors: JSON.stringify([{ issue: 'processing_error', message: error.message }])
        }
      });
      throw error;
    }
  }

  async getUpload(uploadId: string) {
    return prisma.upload.findUnique({
      where: { id: uploadId },
      include: { validationLogs: { orderBy: { rowNumber: 'asc' } } }
    });
  }

  async listUploads(params: { page?: number; limit?: number; status?: string }) {
    const page = params.page || 1;
    const limit = params.limit || 20;
    const skip = (page - 1) * limit;

    const where: Prisma.UploadWhereInput = { ...EXCLUDE_FROM_LISTING };
    if (params.status) where.status = params.status;

    const [uploads, total] = await Promise.all([
      prisma.upload.findMany({
        where,
        orderBy: { uploadedAt: 'desc' },
        skip,
        take: limit,
        include: { _count: { select: { validationLogs: true, locations: true } } }
      }),
      prisma.upload.count({ where })
    ]);

    return {
      uploads,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
    };
  }

  async getValidationLogs(uploadId: string, params: { logType?: string; page?: number; limit?: number }) {
    const page = params.page || 1;
    const limit = params.limit || 50;
    const skip = (page - 1) * limit;

    const where: any = { uploadId };
    if (params.logType) where.logType = params.logType;

    const [logs, total] = await Promise.all([
      prisma.validationLog.findMany({
        where,
        orderBy: [{ rowNumber: 'asc' }, { createdAt: 'asc' }],
        skip,
        take: limit
      }),
      prisma.validationLog.count({ where })
    ]);

    return { logs, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async deleteUpload(uploadId: string) {
    const upload = await prisma.upload.findUnique({ where: { id: uploadId } });
    if (!upload) throw new Error('Upload not found');

    await prisma.upload.delete({ where: { id: uploadId } });

    try {
      const uploadDir = path.join(__dirname, '..', '..', process.env.UPLOAD_DIR || 'uploads');
      await fs.unlink(path.join(uploadDir, upload.filename));
    } catch (error: any) {
      logger.warn(`[Upload ${uploadId}] File deletion failed (DB record removed):`, error.message);
    }

    return { success: true };
  }

  async getStats() {
    const [totalUploads, validUploads, invalidUploads, totalLocations] = await Promise.all([
      prisma.upload.count({ where: EXCLUDE_FROM_LISTING }),
      prisma.upload.count({ where: { ...EXCLUDE_FROM_LISTING, status: 'valid' } }),
      prisma.upload.count({ where: { ...EXCLUDE_FROM_LISTING, status: 'invalid' } }),
      prisma.location.count()
    ]);
    return { totalUploads, validUploads, invalidUploads, totalLocations };
  }

  /**
   * Get the full file path for an upload filename.
   * Returns null if the path escapes the uploads directory (security check).
   */
  async getFilePath(filename: string): Promise<string | null> {
    try {
      const uploadDir = path.join(__dirname, '..', '..', process.env.UPLOAD_DIR || 'uploads');
      const absolute = path.resolve(path.join(uploadDir, filename));
      if (!absolute.startsWith(path.resolve(uploadDir))) {
        logger.warn('[Upload] Path traversal attempt blocked:', filename);
        return null;
      }
      return absolute;
    } catch (error: any) {
      logger.error('[Upload] getFilePath error:', error.message);
      return null;
    }
  }

  async getMasterCSVPath(): Promise<string | null> {
    try {
      const uploadDir = path.join(__dirname, '..', '..', process.env.UPLOAD_DIR || 'uploads');
      return path.resolve(path.join(uploadDir, 'master_stores.csv'));
    } catch (error: any) {
      logger.error('[Upload] getMasterCSVPath error:', error.message);
      return null;
    }
  }

  async revalidateUpload(uploadId: string, options?: { autoFix?: boolean; checkUrls?: boolean }) {
    try {
      const upload = await prisma.upload.findUnique({ where: { id: uploadId } });
      if (!upload) throw new Error('Upload not found');

      const filePath = await this.getFilePath(upload.filename);
      if (!filePath) throw new Error('File path could not be resolved');

      await prisma.upload.update({ where: { id: uploadId }, data: { status: 'validating' } });

      logger.info(`[Upload ${uploadId}] Re-validating${options?.autoFix ? ' with auto-fix' : ''}...`);
      const validationResult = await validationService.validateCSV(filePath, {
        ...VALIDATION_REVALIDATE_DEFAULT,
        ...options,
      });

      await prisma.validationLog.deleteMany({ where: { uploadId } });

      const updateData = validationService.formatForDatabase(validationResult);
      await prisma.upload.update({ where: { id: uploadId }, data: updateData });

      const logs = validationService.createValidationLogs(uploadId, validationResult);
      if (logs.length > 0) {
        await prisma.validationLog.createMany({ data: logs });
      }

      logger.info(`[Upload ${uploadId}] Re-validation ${validationResult.valid ? 'passed' : 'failed'} — errors: ${validationResult.errors.length}`);
      return { success: true, uploadId, validationResult };

    } catch (error: any) {
      logger.error(`[Upload ${uploadId}] Re-validation error:`, error.message);
      await prisma.upload.update({
        where: { id: uploadId },
        data: {
          status: 'failed',
          validationErrors: JSON.stringify([{ issue: 'revalidation_error', message: error.message }])
        }
      });
      throw error;
    }
  }
}

export default new UploadService();
