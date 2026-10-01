import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import Papa from 'papaparse';
import validationService from './validation.service';
import uploadService from './upload.service';
import { storeService, UpsertResult } from './store.service';
import { runScopedPostIngestDedup } from '../utils/location-merge-core';
import { reconcileBrandClaims, formatBrandReconcileLog } from '../utils/brand-claims-reconcile';
import {
  VALIDATION_JOB_RECORDS_SAVE,
  VALIDATION_SCRAPER_JOB_COMPLETION,
} from '../config/validation-policy';
import { SCRAPER_PATH, PYTHON_CMD } from '../utils/paths';
import { normalizeScraperRowsForCsv } from '../utils/stable-handle';
import { brandConfigIdToDisplayName, normalizeBrandsCsvField } from '../utils/brand-display-name';
import { isRowCompleteForDb } from '../utils/row-completeness';
import { logger } from '../utils/logger';
import prisma from '../lib/prisma';

/** One-line summary for job footer and server logs. */
function formatDbSyncSummaryLine(result: UpsertResult): string {
  const synced = result.updated + result.unchanged;
  return `${result.created} new store(s) | ${synced} synced to existing (${result.updated} updated, ${result.unchanged} unchanged) | ${result.upserted} rows written, ${result.skipped} skipped`;
}

/** Format a detailed DB sync summary from a batchUpsertLocations result. */
function formatDbSyncLog(result: UpsertResult): string {
  const syncedToExisting = result.updated + result.unchanged;
  const lines: string[] = [
    `Summary: ${result.created} new store(s) added | ${syncedToExisting} synced to existing store(s) (of ${result.upserted} complete rows written to DB)`,
    `Processed: ${result.upserted} | Skipped (invalid / incomplete): ${result.skipped}`,
  ];
  if (result.skippedIncomplete != null && result.skippedIncomplete > 0) {
    lines.push(
      `  Incomplete rows (not in DB — fix in job editor): ${result.skippedIncomplete}`
    );
  }
  lines.push(
    `  New stores added: ${result.created}`,
    `  Synced to existing: ${syncedToExisting} total (${result.updated} with field changes, ${result.unchanged} unchanged vs DB)`
  );

  if (result.newStores.length > 0) {
    lines.push('');
    lines.push('New stores:');
    for (const name of result.newStores) lines.push(`  + ${name}`);
  }

  const appendChangeList = (label: string, names: string[]) => {
    if (names.length === 0) return;
    lines.push('');
    lines.push(`${label} (${names.length}):`);
    const shown = names.slice(0, 10);
    for (const name of shown) lines.push(`  ~ ${name}`);
    if (names.length > 10) lines.push(`  ... and ${names.length - 10} more`);
  };

  appendChangeList('Brand changes', result.brandsChanged);
  appendChangeList('Address changes', result.addressChanged);
  appendChangeList('Info changes', result.infoChanged);

  return lines.join('\n');
}

class ScraperService {
  private runningProcesses: Map<string, ChildProcess> = new Map();

  /** Location rows with this uploadId — source of truth for rowsProcessed (not per-save upsert batch size). */
  private async countLocationsForUpload(uploadId: string): Promise<number> {
    return prisma.location.count({ where: { uploadId } });
  }

  async startScraping(
    jobId: string,
    brandName: string,
    url: string,
    region: string,
    config: any
  ): Promise<void> {
    try {
      const startedAt = new Date().toISOString();

      await prisma.scraperJob.update({
        where: { id: jobId },
        data: {
          status: 'running',
          logs: this.buildHeader(brandName, url, region, config.type, startedAt)
        }
      });

      const scraperPath = SCRAPER_PATH;
      const outputDir = path.join(__dirname, '..', '..', 'uploads', 'scraped');
      const individualCsvFile = path.join(outputDir, `${brandName}_${Date.now()}.csv`);

      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

      const pythonCmd = PYTHON_CMD;

      const pythonProcess = spawn(pythonCmd, [
        '-u',
        path.join(scraperPath, 'universal_scraper.py'),
        '--url', url,
        '--output', individualCsvFile,
        '--region', region,
        '--brand-config', JSON.stringify(config)
      ], {
        cwd: scraperPath,
        env: { ...process.env, PYTHONUNBUFFERED: '1' }
      });

      this.runningProcesses.set(jobId, pythonProcess);

      let stdout = '';
      let stderr = '';
      let lastLogUpdate = Date.now();
      const LOG_UPDATE_INTERVAL = 500;

      // Build the live-streaming portion of the log (header + output so far)
      const buildLiveLogs = () => {
        let log = this.buildHeader(brandName, url, region, config.type, startedAt);
        log += `\n=== SCRAPER OUTPUT ===\n${stdout}`;
        if (stderr) log += `\n\n=== ERRORS ===\n${stderr}`;
        return log;
      };

      const importantMarkers = [
        '🔍', '✅', '❌', '⚠️', '📡', '🗺️', '🌍',
        'Analyzing', 'Scraping', 'Normalizing', 'Validating',
        'Found', 'stores', 'ERROR', 'SUCCESS'
      ];

      pythonProcess.stdout.on('data', async (data) => {
        const chunk = data.toString();
        stdout += chunk;
        logger.debug(`[Scraper ${jobId}] ${chunk.trim()}`);

        const now = Date.now();
        const isImportant = importantMarkers.some(m => chunk.includes(m));
        if (isImportant || now - lastLogUpdate > LOG_UPDATE_INTERVAL) {
          lastLogUpdate = now;
          try {
            await prisma.scraperJob.update({
              where: { id: jobId },
              data: { logs: buildLiveLogs() }
            });
          } catch (err) {
            logger.warn(`[Job ${jobId}] Live log update failed:`, err);
          }
        }
      });

      pythonProcess.stderr.on('data', async (data) => {
        const chunk = data.toString();
        stderr += chunk;
        logger.debug(`[Scraper ${jobId}] stderr: ${chunk.trim()}`);
        try {
          await prisma.scraperJob.update({
            where: { id: jobId },
            data: { logs: buildLiveLogs() }
          });
          lastLogUpdate = Date.now();
        } catch (err) {
          logger.warn(`[Job ${jobId}] Live error log update failed:`, err);
        }
      });

      pythonProcess.on('close', async (code) => {
        this.runningProcesses.delete(jobId);
        const completedAt = new Date().toISOString();
        const baseLogs = buildLiveLogs();

        if (code === 0) {
          let recordsScraped: number | null = null;
          let individualUpload: any = null;
          let postProcessLogs = '';

          try {
            const individualFileStats = fs.statSync(individualCsvFile);
            const totalRows = await this.countCsvRows(individualCsvFile);

            const normalizedMatch =
              stdout.match(/(\d+)\s+stores\s+normalized/i) ||
              stdout.match(/✅\s+(\d+)\s+stores/i);
            recordsScraped = normalizedMatch ? parseInt(normalizedMatch[1]) : totalRows;

            // ── UPLOAD RECORD ────────────────────────────────────────────────
            const uploadsBaseDir = path.join(__dirname, '..', '..', 'uploads');
            const individualFilename = path.relative(uploadsBaseDir, individualCsvFile);

            individualUpload = await prisma.upload.create({
              data: {
                filename: individualFilename,
                originalFilename: `${brandName}_scraped_${Date.now()}.csv`,
                fileSize: individualFileStats.size,
                uploadedBy: 'scraper',
                status: 'completed',
                brandConfig: brandName,
                scraperType: config.type || 'json',
                rowsTotal: recordsScraped ?? 0,
                rowsProcessed: 0,
              }
            });

            const displayName: string = (
              config.display_name && String(config.display_name).trim()
                ? brandConfigIdToDisplayName(String(config.display_name).trim())
                : brandConfigIdToDisplayName(brandName)
            );

            // ── STABLE HANDLES + JOB CSV (keeps incomplete rows for editor) ───
            postProcessLogs += '\n\n=== SCRAPER CSV NORMALIZATION ===\n';
            try {
              const rawContent = fs.readFileSync(individualCsvFile, 'utf-8');
              const parsed = Papa.parse(rawContent, {
                header: true,
                skipEmptyLines: true,
                transformHeader: (h: string) => h.trim(),
              });
              const csvRecords = parsed.data as Record<string, string>[];
              const withBrands = csvRecords.map((r) => ({
                ...r,
                Brands: normalizeBrandsCsvField(r.Brands) ?? displayName,
              }));
              const normalizedRows = normalizeScraperRowsForCsv(withBrands);
              fs.writeFileSync(individualCsvFile, Papa.unparse(normalizedRows), 'utf-8');
              const completeN = normalizedRows.filter((r) => isRowCompleteForDb(r)).length;
              postProcessLogs += `Rows: ${normalizedRows.length} | Complete for DB: ${completeN} | Incomplete (CSV only): ${normalizedRows.length - completeN}\n`;
              postProcessLogs += `Country/Phone canonicalized (same rules as DB import); stable loc_* handles assigned to complete rows.\n`;
              await prisma.upload.update({
                where: { id: individualUpload.id },
                data: {
                  fileSize: fs.statSync(individualCsvFile).size,
                  rowsTotal: normalizedRows.length,
                },
              });
            } catch (normErr: any) {
              postProcessLogs += `Normalization warning: ${normErr.message}\n`;
              logger.warn(`[Job ${jobId}] CSV normalization:`, normErr.message);
            }

            // ── VALIDATION ───────────────────────────────────────────────────
            postProcessLogs += '\n\n=== VALIDATION ===\n';
            try {
              const validationResult = await validationService.validateCSV(
                individualCsvFile,
                VALIDATION_SCRAPER_JOB_COMPLETION
              );
              postProcessLogs += validationService.formatLogSection(validationResult);

              const updateData = validationService.formatForDatabase(validationResult);
              await prisma.upload.update({
                where: { id: individualUpload.id },
                data: {
                  validationErrors: updateData.validationErrors,
                  validationWarnings: updateData.validationWarnings,
                }
              });
              const valLogs = validationService.createValidationLogs(individualUpload.id, validationResult);
              if (valLogs.length > 0) {
                await prisma.validationLog.createMany({ data: valLogs });
              }
            } catch (valErr: any) {
              postProcessLogs += `Validation unavailable: ${valErr.message}`;
              logger.warn(`[Job ${jobId}] Validation failed (non-fatal):`, valErr.message);
            }

            // ── DB UPSERT (complete rows only; incomplete stay on CSV) ────────
            postProcessLogs += '\n\n=== DB SYNC ===\n';
            let dbSyncResult: UpsertResult | null = null;
            try {
              const fileContent = fs.readFileSync(individualCsvFile, 'utf-8');
              const { data: csvRecords } = Papa.parse(fileContent, {
                header: true,
                skipEmptyLines: true,
                transformHeader: (h: string) => h.trim(),
              });
              const enrichedRecords = (csvRecords as Record<string, string>[]).map((r) => ({
                ...r,
                Brands: normalizeBrandsCsvField(r.Brands) ?? displayName,
              }));
              dbSyncResult = await storeService.batchUpsertLocations(
                enrichedRecords,
                individualUpload.id,
                { failFast: true, requireCompleteForDb: true, mergeOnUpdate: true }
              );
              postProcessLogs += formatDbSyncLog(dbSyncResult);
              logger.info(`[Job ${jobId}] DB sync — ${formatDbSyncSummaryLine(dbSyncResult)}`);
              try {
                const dedup = await runScopedPostIngestDedup(dbSyncResult.affectedHandles ?? []);
                if (dedup.mergeGroups > 0) {
                  postProcessLogs += `\n\n=== POST-IMPORT DEDUPE (${dedup.mode}) ===\nMerged ${dedup.mergeGroups} group(s), removed ${dedup.rowsRemoved} duplicate location(s).`;
                  logger.info(
                    `[Job ${jobId}] Post-import dedupe (${dedup.mode}) — ${dedup.mergeGroups} group(s), ${dedup.rowsRemoved} row(s) removed`
                  );
                }
              } catch (dedupErr: any) {
                postProcessLogs += `\n\n=== POST-IMPORT DEDUPE ===\nFailed: ${dedupErr.message}`;
                logger.error(`[Job ${jobId}] Post-import dedupe failed:`, dedupErr.message);
              }
              // Stale-claim reconcile: the feed just told us every store it accounts for
              // (affectedHandles); any other location still claiming this brand inherited it
              // from an old bad merge. Report-only unless SCRAPER_RECONCILE_EXECUTE=true.
              try {
                const reconcile = await reconcileBrandClaims({
                  brand: displayName,
                  matchedHandles: new Set(dbSyncResult.affectedHandles ?? []),
                  feedRows: enrichedRecords.length,
                  execute: process.env.SCRAPER_RECONCILE_EXECUTE === 'true',
                });
                postProcessLogs += formatBrandReconcileLog(reconcile);
                if (reconcile.stale.length > 0) {
                  logger.info(
                    `[Job ${jobId}] Brand reconcile (${displayName}) — ${reconcile.stale.length} stale claim(s)` +
                      (reconcile.applied ? ' removed' : ' reported (not applied)')
                  );
                }
              } catch (recErr: any) {
                postProcessLogs += `\n\n=== BRAND CLAIM RECONCILE ===\nFailed: ${recErr.message}`;
                logger.error(`[Job ${jobId}] Brand reconcile failed (non-fatal):`, recErr.message);
              }
              const rowsInDb = await this.countLocationsForUpload(individualUpload.id);
              await prisma.upload.update({
                where: { id: individualUpload.id },
                data: { rowsProcessed: rowsInDb },
              });
            } catch (dbErr: any) {
              postProcessLogs += `DB sync failed: ${dbErr.message}`;
              logger.error(`[Job ${jobId}] DB upsert failed (non-fatal):`, dbErr.message);
            }

            // ── COMPLETION SUMMARY ────────────────────────────────────────────
            const dbSyncFooter =
              dbSyncResult != null
                ? `\nDB sync: ${formatDbSyncSummaryLine(dbSyncResult)}`
                : '';
            const finalLogs =
              baseLogs +
              postProcessLogs +
              `\n\n=== JOB COMPLETED ===\n` +
              `Scraped: ${recordsScraped ?? 0} records` +
              dbSyncFooter +
              `\nExit: 0 | Completed: ${completedAt}`;

            try {
              await prisma.scraperJob.update({
                where: { id: jobId },
                data: {
                  status: 'completed',
                  completedAt: new Date(),
                  recordsScraped: recordsScraped ?? 0,
                  uploadId: individualUpload.id,
                  logs: finalLogs
                }
              });
              logger.info(
                `[Job ${jobId}] Completed — scraped ${recordsScraped ?? 0} records` +
                  (dbSyncResult != null ? `; ${formatDbSyncSummaryLine(dbSyncResult)}` : '')
              );
            } catch (updateError: any) {
              logger.error(`[Job ${jobId}] Status update failed, retrying:`, updateError.message);
              try {
                await prisma.scraperJob.update({
                  where: { id: jobId },
                  data: {
                    status: 'completed',
                    completedAt: new Date(),
                    recordsScraped: recordsScraped ?? 0,
                    uploadId: individualUpload?.id || null,
                    logs: finalLogs + `\n[Status update error: ${updateError.message}]`
                  }
                });
              } catch (retryError: any) {
                logger.error(`[Job ${jobId}] Critical: could not persist completion status:`, retryError.message);
              }
            }

          } catch (error: any) {
            logger.error(`[Job ${jobId}] Post-processing failed:`, error.message);
            const finalRecordsScraped = recordsScraped ?? (() => {
              const m = stdout.match(/(\d+)\s+stores\s+normalized/i);
              return m ? parseInt(m[1]) : 0;
            })();
            try {
              await prisma.scraperJob.update({
                where: { id: jobId },
                data: {
                  status: 'failed',
                  completedAt: new Date(),
                  errorMessage: `Post-processing error: ${error.message}`,
                  recordsScraped: finalRecordsScraped,
                  logs: baseLogs + postProcessLogs +
                    `\n\n=== POST-PROCESSING ERROR ===\n${error.message}\n${error.stack || ''}`
                }
              });
            } catch (updateErr: any) {
              logger.error(`[Job ${jobId}] Critical: could not persist failure status:`, updateErr.message);
            }
          }

        } else {
          await prisma.scraperJob.update({
            where: { id: jobId },
            data: {
              status: 'failed',
              completedAt: new Date(),
              errorMessage: stderr.trim() || `Process exited with code ${code}`,
              logs: baseLogs + `\n\n=== JOB FAILED ===\nExit: ${code} | Completed: ${completedAt}`
            }
          });
          logger.warn(`[Job ${jobId}] Failed — exit code ${code}`);
        }
      });

      pythonProcess.on('error', async (error) => {
        this.runningProcesses.delete(jobId);
        logger.error(`[Job ${jobId}] Process spawn failed:`, error.message);
        await prisma.scraperJob.update({
          where: { id: jobId },
          data: {
            status: 'failed',
            completedAt: new Date(),
            errorMessage: error.message,
            logs: `=== SPAWN ERROR ===\n${error.message}\n${error.stack || ''}`
          }
        });
      });

    } catch (error: any) {
      logger.error(`[Job ${jobId}] Startup failed:`, error.message);
      await prisma.scraperJob.update({
        where: { id: jobId },
        data: {
          status: 'failed',
          completedAt: new Date(),
          errorMessage: error.message,
          logs: `=== STARTUP ERROR ===\n${error.message}\n${error.stack || ''}`
        }
      });
    }
  }

  async cancelJob(jobId: string): Promise<{ success: boolean; message: string }> {
    try {
      const job = await prisma.scraperJob.findUnique({ where: { id: jobId } });
      if (!job) return { success: false, message: 'Job not found' };
      if (job.status !== 'running') {
        return { success: false, message: `Job is not running (status: ${job.status})` };
      }

      const proc = this.runningProcesses.get(jobId);
      if (!proc) {
        await prisma.scraperJob.update({
          where: { id: jobId },
          data: {
            status: 'cancelled',
            completedAt: new Date(),
            errorMessage: 'Job was cancelled (process not found)',
            logs: (job.logs || '') + `\n\n[${new Date().toISOString()}] Cancelled by user (process not found)`
          }
        });
        return { success: true, message: 'Job marked as cancelled (process not found)' };
      }

      proc.kill('SIGTERM');
      setTimeout(() => {
        if (this.runningProcesses.has(jobId)) proc.kill('SIGKILL');
      }, 5000);

      await prisma.scraperJob.update({
        where: { id: jobId },
        data: {
          status: 'cancelled',
          completedAt: new Date(),
          errorMessage: 'Job was cancelled by user',
          logs: (job.logs || '') + `\n\n[${new Date().toISOString()}] Cancelled by user`
        }
      });
      this.runningProcesses.delete(jobId);

      logger.info(`[Job ${jobId}] Cancelled`);
      return { success: true, message: 'Job cancelled successfully' };

    } catch (error: any) {
      logger.error(`[Job ${jobId}] Cancel failed:`, error.message);
      return { success: false, message: `Error cancelling job: ${error.message}` };
    }
  }

  /**
   * Save job records: write all records back to the job CSV (audit copy), run
   * validation + normalization (--fix) on the job CSV in-place, then
   * batch-upsert complete records directly into the Location table.
   * Appends a summary section to ScraperJob.logs for audit visibility.
   */
  async saveJobRecords(
    jobId: string,
    records: Record<string, string>[]
  ): Promise<{
    savedToJob: number;
    skippedIncomplete: number;
    dbUpserted: number;
    validationErrors?: number;
  }> {
    const job = await prisma.scraperJob.findUnique({
      where: { id: jobId },
      include: { upload: true }
    });
    if (!job || job.status !== 'completed' || !job.uploadId || !job.upload) {
      throw new Error('Job not found or has no upload');
    }

    const filePath = await uploadService.getFilePath(job.upload.filename);
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error('Job CSV file not found');
    }

    const Papa = (await import('papaparse')).default;

    const normalizedRecords = normalizeScraperRowsForCsv(records);
    // Write all records back to the job CSV — serves as the per-job audit copy
    fs.writeFileSync(filePath, Papa.unparse(normalizedRecords), 'utf-8');

    const completeCount = normalizedRecords.filter(isRowCompleteForDb).length;
    const skippedIncomplete = normalizedRecords.length - completeCount;
    let dbUpserted = 0;
    let lastUpsert: UpsertResult | null = null;
    let validationErrors: number | undefined;
    const editTimestamp = new Date().toISOString();
    let editLogSection = `\n\n=== RECORDS UPDATED [${editTimestamp}] ===\n`;
    editLogSection += `Saved to job CSV: ${normalizedRecords.length} | Complete: ${completeCount} | Skipped incomplete: ${skippedIncomplete}`;

    if (completeCount > 0) {
      // Run validate_csv.py --fix directly on the job CSV in-place (no tmp files)
      let fixedRecords: Record<string, string>[] = normalizedRecords.filter(isRowCompleteForDb);
      let validationResult: import('./validation.service').ValidationResult | null = null;

      try {
        validationResult = await validationService.validateCSV(filePath, VALIDATION_JOB_RECORDS_SAVE);
        editLogSection += `\n\n=== VALIDATION ===\n${validationService.formatLogSection(validationResult)}`;

        // Re-read the job CSV — the validator may have fixed values in-place
        if (fs.existsSync(filePath)) {
          const fixedContent = fs.readFileSync(filePath, 'utf-8');
          const parsed = Papa.parse(fixedContent, {
            header: true,
            skipEmptyLines: true,
            transformHeader: (h: string) => h.trim()
          });
          const allFixed = parsed.data as Record<string, string>[];
          fixedRecords = normalizeScraperRowsForCsv(allFixed).filter(isRowCompleteForDb);
        }

        editLogSection += `\n\n=== NORMALIZATION ===\nAuto-fix applied — ${fixedRecords.length} complete records normalized`;

        if (!validationResult.valid && validationResult.errors.length > 0) {
          validationErrors = validationResult.errors.length;
          await this.appendJobLog(jobId, job.logs, editLogSection);
          return {
            savedToJob: normalizedRecords.length,
            skippedIncomplete,
            dbUpserted: 0,
            validationErrors
          };
        }
      } catch {
        editLogSection += '\n\n=== VALIDATION ===\nValidator unavailable — proceeding with original records';
      }

      // ── DB UPSERT ─────────────────────────────────────────────────────────
      try {
        lastUpsert = await storeService.batchUpsertLocations(fixedRecords, job.uploadId, {
          failFast: true,
          requireCompleteForDb: true,
          mergeOnUpdate: true,
        });
        dbUpserted = lastUpsert.upserted;
        editLogSection += `\n\n=== DB SYNC ===\n${formatDbSyncLog(lastUpsert)}`;
        logger.info(`[Job ${jobId}] DB sync (save) — ${formatDbSyncSummaryLine(lastUpsert)}`);
        try {
          const dedup = await runScopedPostIngestDedup(lastUpsert.affectedHandles ?? []);
          if (dedup.mergeGroups > 0) {
            editLogSection += `\n\n=== POST-IMPORT DEDUPE (${dedup.mode}) ===\nMerged ${dedup.mergeGroups} group(s), removed ${dedup.rowsRemoved} duplicate location(s).`;
            logger.info(
              `[Job ${jobId}] Post-import dedupe (${dedup.mode}, save) — ${dedup.mergeGroups} group(s), ${dedup.rowsRemoved} row(s) removed`
            );
          }
        } catch (dedupErr: any) {
          editLogSection += `\n\n=== POST-IMPORT DEDUPE ===\nFailed: ${dedupErr.message}`;
          logger.error(`[Job ${jobId}] Post-import dedupe failed:`, dedupErr.message);
        }
        try {
          const reconcile = await reconcileBrandClaims({
            brand: job.brandName,
            matchedHandles: new Set(lastUpsert.affectedHandles ?? []),
            feedRows: fixedRecords.length,
            execute: process.env.SCRAPER_RECONCILE_EXECUTE === 'true',
          });
          editLogSection += formatBrandReconcileLog(reconcile);
          if (reconcile.stale.length > 0) {
            logger.info(
              `[Job ${jobId}] Brand reconcile (${reconcile.brand}, save) — ${reconcile.stale.length} stale claim(s)` +
                (reconcile.applied ? ' removed' : ' reported (not applied)')
            );
          }
        } catch (recErr: any) {
          editLogSection += `\n\n=== BRAND CLAIM RECONCILE ===\nFailed: ${recErr.message}`;
          logger.error(`[Job ${jobId}] Brand reconcile failed (non-fatal):`, recErr.message);
        }
      } catch (dbErr: any) {
        editLogSection += `\n\n=== DB SYNC ===\nFailed: ${dbErr.message}`;
        logger.error(`[Job ${jobId}] DB upsert failed:`, dbErr.message);
      }

      // ── UPDATE UPLOAD RECORD ──────────────────────────────────────────────
      if (validationResult) {
        try {
          const dbFormat = validationService.formatForDatabase(validationResult);
          const rowsProcessed = await this.countLocationsForUpload(job.uploadId);
          await prisma.upload.update({
            where: { id: job.uploadId },
            data: {
              validationErrors: dbFormat.validationErrors,
              validationWarnings: dbFormat.validationWarnings,
              rowsTotal: normalizedRecords.length,
              rowsProcessed,
            }
          });
          await prisma.validationLog.deleteMany({ where: { uploadId: job.uploadId } });
          const valLogs = validationService.createValidationLogs(job.uploadId, validationResult);
          if (valLogs.length > 0) {
            await prisma.validationLog.createMany({ data: valLogs });
          }
        } catch (uploadErr: any) {
          logger.warn(`[Job ${jobId}] Upload record update failed:`, uploadErr.message);
        }
      }
    }

    await this.appendJobLog(jobId, job.logs, editLogSection);
    return { savedToJob: normalizedRecords.length, skippedIncomplete, dbUpserted, validationErrors };
  }

  /**
   * Append a section to an existing job's stored log without rewriting it from scratch.
   */
  private async appendJobLog(jobId: string, existingLogs: string | null, section: string): Promise<void> {
    try {
      await prisma.scraperJob.update({
        where: { id: jobId },
        data: { logs: (existingLogs || '') + section }
      });
    } catch (err: any) {
      logger.warn(`[Job ${jobId}] Log append failed:`, err.message);
    }
  }

  /**
   * Build the fixed job header (captured once at job start, never mutated).
   */
  private buildHeader(
    brandName: string,
    url: string,
    region: string,
    type: string | undefined,
    startedAt: string
  ): string {
    return (
      `=== JOB STARTED ===\n` +
      `Brand: ${brandName} | Region: ${region} | Type: ${type || 'auto-detect'}\n` +
      `URL: ${url}\n` +
      `Started: ${startedAt}`
    );
  }

  /**
   * Records for a completed job.
   * Scraper jobs: always load from job CSV when present so incomplete rows stay editable.
   * Other uploads: prefer DB by uploadId, else CSV (legacy).
   */
  async getJobRecordsPayload(jobId: string): Promise<{
    jobId: string;
    brandName: string;
    source: 'db' | 'csv';
    columns: string[];
    records: Record<string, string>[];
  }> {
    const job = await prisma.scraperJob.findUnique({
      where: { id: jobId },
      include: { upload: true },
    });
    if (!job) {
      throw new Error('Job not found');
    }
    if (job.status !== 'completed') {
      throw new Error('Only completed jobs have viewable records');
    }
    if (!job.uploadId || !job.upload) {
      throw new Error('No upload linked to this job');
    }

    const upload = job.upload;
    const filePath = await uploadService.getFilePath(upload.filename);
    if (upload.uploadedBy === 'scraper' && filePath && fs.existsSync(filePath)) {
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      const parseResult = Papa.parse(fileContent, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (h: string) => h.trim(),
      });
      const rows = parseResult.data as Record<string, string>[];
      const normalized = normalizeScraperRowsForCsv(rows);
      return {
        jobId: job.id,
        brandName: job.brandName,
        source: 'csv',
        columns: normalized.length > 0 ? Object.keys(normalized[0]) : [],
        records: normalized,
      };
    }

    const dbRows = await storeService.getLocationsByUploadId(job.uploadId);
    if (dbRows.length > 0) {
      const normalized = normalizeScraperRowsForCsv(dbRows);
      return {
        jobId: job.id,
        brandName: job.brandName,
        source: 'db',
        columns: Object.keys(normalized[0]),
        records: normalized,
      };
    }

    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error('Job CSV file not found');
    }

    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const parseResult = Papa.parse(fileContent, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h: string) => h.trim(),
    });
    const rows = parseResult.data as Record<string, string>[];
    const normalized = normalizeScraperRowsForCsv(rows);
    return {
      jobId: job.id,
      brandName: job.brandName,
      source: 'csv',
      columns: normalized.length > 0 ? Object.keys(normalized[0]) : [],
      records: normalized,
    };
  }

  /**
   * Count rows in a CSV file (excluding header).
   */
  async countCsvRows(filePath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      let newlineCount = 0;
      let lastChunkEndsWithNewline = false;
      const stream = fs.createReadStream(filePath);
      stream.on('data', (chunk) => {
        const s = chunk.toString();
        const matches = s.match(/\n/g);
        newlineCount += matches ? matches.length : 0;
        lastChunkEndsWithNewline = s.length > 0 && s[s.length - 1] === '\n';
      });
      stream.on('end', () => {
        const dataRows = lastChunkEndsWithNewline ? Math.max(0, newlineCount - 1) : newlineCount;
        resolve(dataRows);
      });
      stream.on('error', reject);
    });
  }
}

export const scraperService = new ScraperService();
