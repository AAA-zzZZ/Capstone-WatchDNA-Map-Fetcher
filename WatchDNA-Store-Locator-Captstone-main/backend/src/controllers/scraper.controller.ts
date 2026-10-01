import { Request, Response } from 'express';
import { scraperService } from '../services/scraper.service';
import uploadService from '../services/upload.service';
import { storeService } from '../services/store.service';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { ENDPOINT_DISCOVERER_PATH, PYTHON_CMD } from '../utils/paths';
import prisma from '../lib/prisma';
import {
  loadMergedBrandConfigs,
  upsertBrandConfigRow,
  applyBrandRename,
} from '../services/brand-config.service';
import {
  masterBrandPremiumScopeFromQuery,
  masterExportFiltersFromQuery,
} from '../utils/parse-master-export-query';
import {
  geoVerifyTasks,
  markGeoVerifyTaskFinished,
  pruneGeoVerifyTasks,
  runGeoVerifyPipeline,
  type GeoVerifyTask,
} from '../services/geo-verify-pipeline.service';

// Helper functions for brand config similarity detection
function calculateSimilarity(str1: string, str2: string): number {
  const s1 = str1.toLowerCase().replace(/[^a-z0-9]/g, '');
  const s2 = str2.toLowerCase().replace(/[^a-z0-9]/g, '');
  
  if (s1 === s2) return 1.0;
  if (s1.length === 0 || s2.length === 0) return 0.0;
  
  // Check if one contains the other (e.g., "audemars_piguet" vs "audemars_piguet_stores")
  if (s1.includes(s2) || s2.includes(s1)) {
    return 0.85; // High similarity for substring matches
  }
  
  // Simple Levenshtein distance-based similarity
  const longer = s1.length > s2.length ? s1 : s2;
  const shorter = s1.length > s2.length ? s2 : s1;
  const editDistance = levenshteinDistance(s1, s2);
  return (longer.length - editDistance) / longer.length;
}

function levenshteinDistance(str1: string, str2: string): number {
  // Initialize matrix with dimensions (str2.length + 1) x (str1.length + 1)
  const matrix: number[][] = [];
  
  // Initialize first column: matrix[i][0] = i for all i
  for (let i = 0; i <= str2.length; i++) {
    matrix[i] = [i];
  }
  
  // Initialize first row: matrix[0][j] = j for all j
  // Note: matrix[0][0] is already set to 0, so start from j = 1
  for (let j = 1; j <= str1.length; j++) {
    matrix[0][j] = j;
  }
  
  // Fill the rest of the matrix
  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[str2.length][str1.length];
}

function normalizeUrlForComparison(url: string): string {
  try {
    const urlObj = new URL(url);
    // Keep only hostname and pathname, remove query params and fragments
    return `${urlObj.hostname}${urlObj.pathname}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/** Strip generic suffixes before name similarity comparison to avoid false positives
 * (e.g. breva_stores vs omega_stores both becoming *stores after non-alphanum removal). */
function stripGenericBrandSuffixes(brandId: string): string {
  return brandId
    .replace(/_stores$/i, '')
    .replace(/_retailers$/i, '')
    .replace(/_dealers$/i, '')
    .replace(/_watches$/i, '');
}

type SimilarBrandConfig = { brandId: string; config: any; similarity: number; reason: string };

function findSimilarBrandConfigs(
  brandId: string,
  endpointUrl: string,
  configs: Record<string, any>
): SimilarBrandConfig[] {
  const similar: SimilarBrandConfig[] = [];
  const normalizedNewUrl = normalizeUrlForComparison(endpointUrl);
  const strippedBrandId = stripGenericBrandSuffixes(brandId);
  
  for (const [existingBrandId, existingConfig] of Object.entries(configs)) {
    // Skip exact match (handled separately)
    if (existingBrandId === brandId) continue;
    
    let similarity = 0;
    let reason = '';
    
    // Compare names after stripping generic suffixes so e.g. breva_stores vs omega_stores
    // don't get a false 73% match purely because they share the "_stores" suffix.
    const strippedExistingId = stripGenericBrandSuffixes(existingBrandId);
    const nameSimilarity = calculateSimilarity(strippedBrandId, strippedExistingId);
    if (nameSimilarity >= 0.7) {
      similarity = nameSimilarity;
      reason = `Similar brand name (${(nameSimilarity * 100).toFixed(0)}% match)`;
    }
    
    // Check URL similarity
    if (existingConfig.url) {
      const normalizedExistingUrl = normalizeUrlForComparison(existingConfig.url);
      if (normalizedExistingUrl === normalizedNewUrl) {
        similarity = Math.max(similarity, 0.95);
        reason = reason ? `${reason} + Same endpoint URL` : 'Same endpoint URL';
      } else if (normalizedExistingUrl.includes(normalizedNewUrl) || normalizedNewUrl.includes(normalizedExistingUrl)) {
        similarity = Math.max(similarity, 0.8);
        reason = reason ? `${reason} + Similar endpoint URL` : 'Similar endpoint URL';
      }
    }
    
    if (similarity >= 0.7) {
      similar.push({ brandId: existingBrandId, config: existingConfig, similarity, reason });
    }
  }
  
  // Sort by similarity (highest first)
  return similar.sort((a, b) => b.similarity - a.similarity);
}

/** Query has distance + map center — universal_scraper uses --region for multi-center radius presets. */
function urlHasRadiusAndGeoCenter(brandUrl: string): boolean {
  if (!brandUrl) return false;
  try {
    const parsed = new URL(brandUrl);
    const hasRadius =
      parsed.searchParams.has('radius') ||
      parsed.searchParams.has('r') ||
      parsed.searchParams.has('max_distance') ||
      parsed.searchParams.has('maxdistance');
    const hasCenter =
      parsed.searchParams.has('lat') ||
      parsed.searchParams.has('latitude') ||
      parsed.searchParams.has('long') ||
      parsed.searchParams.has('lng') ||
      parsed.searchParams.has('q');
    return hasRadius && hasCenter;
  } catch {
    return false;
  }
}

/**
 * Brand benefits from the admin "Region" control (passed as --region to universal_scraper):
 * viewport grids, country-list subsets, multi-center radius expansion, etc.
 */
function brandSupportsRegionPreset(brandUrl: string, cfg: Record<string, unknown>): boolean {
  const u = brandUrl || '';
  const viewportLike =
    u.includes('viewport') ||
    u.includes('by_viewport') ||
    u.includes('bounds') ||
    u.includes('bbox') ||
    u.includes('northEast') ||
    u.includes('southWest');
  if (viewportLike) return true;
  if (/Stores-FindStores/i.test(u)) return true;
  if (urlHasRadiusAndGeoCenter(u)) return true;
  if (cfg.worldwide_country_pagination === true) return true;
  if (cfg.force_radius_multi_point === true) return true;
  const centers = cfg.radius_expansion_centers;
  if (Array.isArray(centers) && centers.length > 0) return true;
  return false;
}

export function ensureTmpOutputFile(prefix: string): string {
  const outputDir = path.join(__dirname, '..', '..', '..', 'tmp');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  const unique = `${Date.now()}_${crypto.randomUUID()}`;
  return path.join(outputDir, `${prefix}_${unique}.json`);
}

export const scraperController = {
  // GET /api/scraper/brands - List available brand configs
  async getBrands(req: Request, res: Response) {
    try {
      const configs = await loadMergedBrandConfigs();

      // Filter out _README and disabled brands
      const brands = Object.entries(configs)
        .filter(([key, value]: [string, any]) => {
          return key !== '_README' && value.enabled !== false;
        })
        .map(([key, value]: [string, any]) => {
          // Prefer explicit display_name from config, fallback to formatted brand key.
          const configuredDisplayName =
            typeof value.display_name === 'string' ? value.display_name.trim() : '';
          let formattedName = configuredDisplayName || key
            .split('_')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
          
          // Check if this is a US-only brand (check URL or description)
          const brandUrl = value.url || '';
          const description = value.description || '';
          
          // Check for US-only indicators, but exclude language codes like /us-en, /us-es, /us/en/, etc.
          // Language codes can be: /us-en (dash) or /us/en/ (slash)
          const hasUSPathDash = brandUrl.includes('/us-');
          const hasUSPathSlash = /\/us\/[a-z]{2,5}(\/|$|\?)/.test(brandUrl);
          const isLanguageCode = (hasUSPathDash && /\/us-[a-z]{2,5}(\/|$|\?)/.test(brandUrl)) || hasUSPathSlash;
          
          // If /us- or /us/ exists but it's a language code, don't treat it as US-only
          // Otherwise, check all US-only indicators
          const isUSOnly = ((hasUSPathDash || hasUSPathSlash) && !isLanguageCode) || 
                          brandUrl.includes('.us/') || 
                          brandUrl.includes('us.alpina') ||
                          description.toLowerCase().includes('us only') ||
                          description.toLowerCase().includes('united states');
          
          if (isUSOnly) {
            formattedName += ' (U.S.)';
          }
          
          // Viewport-style URLs (subset of region-aware scrapers)
          const isViewportBased =
            brandUrl.includes('viewport') ||
            brandUrl.includes('by_viewport') ||
            brandUrl.includes('bounds') ||
            brandUrl.includes('bbox') ||
            brandUrl.includes('northEast') ||
            brandUrl.includes('southWest');

          const supportsRegionPreset = brandSupportsRegionPreset(brandUrl, value);

          return {
            id: key,
            name: formattedName,
            type: value.type,
            url: value.url,
            description: value.description || '',
            method: value.method || 'GET',
            enabled: true,
            isViewportBased,
            supportsRegionPreset,
          };
        })
        .sort((a, b) => {
          // Sort alphabetically by name (case-insensitive)
          return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        });

      res.json({ brands });
    } catch (error: any) {
      console.error('Error loading brand configs:', error);
      res.status(500).json({ error: error.message });
    }
  },

  // POST /api/scraper/jobs - Start a new scraping job
  async createJob(req: Request, res: Response) {
    try {
      const { brandName, url, region = 'world' } = req.body;

      if (!brandName || !url) {
        return res.status(400).json({ error: 'brandName and url are required' });
      }

      // Load brand config (file baseline + DB overlay)
      const configs = await loadMergedBrandConfigs();
      const brandConfig = configs[brandName];

      if (!brandConfig) {
        return res.status(404).json({ error: 'Brand configuration not found' });
      }

      // Create job in database
      const job = await prisma.scraperJob.create({
        data: {
          brandName,
          config: JSON.stringify({ ...brandConfig, url, region }),
          status: 'queued',
        },
      });

      // Start scraping asynchronously
      scraperService.startScraping(job.id, brandName, url, region, brandConfig)
        .catch((error: any) => {
          console.error(`Error in scraping job ${job.id}:`, error);
        });

      res.status(201).json({ 
        message: 'Scraping job created',
        job: {
          id: job.id,
          brandName: job.brandName,
          status: job.status,
          startedAt: job.startedAt
        }
      });
    } catch (error: any) {
      console.error('Error creating scraper job:', error);
      res.status(500).json({ error: error.message });
    }
  },

  // GET /api/scraper/jobs - List all scraper jobs
  async listJobs(req: Request, res: Response) {
    try {
      const { status, brandName, limit = 50, offset = 0 } = req.query;

      const where: any = {};
      if (status) where.status = status;
      if (brandName) where.brandName = brandName;

      const [jobs, total] = await Promise.all([
        prisma.scraperJob.findMany({
          where,
          orderBy: { startedAt: 'desc' },
          take: Number(limit),
          skip: Number(offset),
          include: {
            upload: {
              select: {
                id: true,
                filename: true,
                status: true,
                rowsTotal: true,
              }
            }
          }
        }),
        prisma.scraperJob.count({ where })
      ]);

      res.json({ 
        jobs,
        pagination: {
          total,
          limit: Number(limit),
          offset: Number(offset),
          hasMore: total > Number(offset) + Number(limit)
        }
      });
    } catch (error: any) {
      console.error('Error listing scraper jobs:', error);
      res.status(500).json({ error: error.message });
    }
  },

  // GET /api/scraper/jobs/:id - Get job details
  async getJob(req: Request, res: Response) {
    try {
      const { id } = req.params;

      const job = await prisma.scraperJob.findUnique({
        where: { id },
        include: {
          upload: true
        }
      });

      if (!job) {
        return res.status(404).json({ error: 'Job not found' });
      }

      res.json({ job });
    } catch (error: any) {
      console.error('Error getting scraper job:', error);
      res.status(500).json({ error: error.message });
    }
  },

  // GET /api/scraper/jobs/:id/logs - Get job logs
  async getJobLogs(req: Request, res: Response) {
    try {
      const { id } = req.params;

      const job = await prisma.scraperJob.findUnique({
        where: { id },
        select: {
          id: true,
          brandName: true,
          status: true,
          logs: true,
          errorMessage: true,
          startedAt: true,
          completedAt: true
        }
      });

      if (!job) {
        return res.status(404).json({ error: 'Job not found' });
      }

      res.json({
        logs: job.logs || 'No logs available yet',
        status: job.status,
        brandName: job.brandName,
        errorMessage: job.errorMessage,
        startedAt: job.startedAt,
        completedAt: job.completedAt
      });
    } catch (error: any) {
      console.error('Error getting scraper job logs:', error);
      res.status(500).json({ error: error.message });
    }
  },

  // DELETE /api/scraper/jobs/:id - Delete a job
  async deleteJob(req: Request, res: Response) {
    try {
      const { id } = req.params;

      const job = await prisma.scraperJob.findUnique({
        where: { id }
      });

      if (!job) {
        return res.status(404).json({ error: 'Job not found' });
      }

      // Don't allow deleting running jobs
      if (job.status === 'running') {
        return res.status(400).json({ error: 'Cannot delete a running job' });
      }

      await prisma.scraperJob.delete({
        where: { id }
      });

      res.json({ message: 'Job deleted successfully' });
    } catch (error: any) {
      console.error('Error deleting scraper job:', error);
      res.status(500).json({ error: error.message });
    }
  },

  // GET /api/scraper/stats - Get scraper statistics
  async getStats(req: Request, res: Response) {
    try {
      const [totalJobs, runningJobs, completedJobs, failedJobs] = await Promise.all([
        prisma.scraperJob.count(),
        prisma.scraperJob.count({ where: { status: 'running' } }),
        prisma.scraperJob.count({ where: { status: 'completed' } }),
        prisma.scraperJob.count({ where: { status: 'failed' } })
      ]);
      
      // Total stores = rows in Location (updates/merges do not change this; only inserts/deletes do)
      let totalStoresInDatabase = 0;
      try {
        totalStoresInDatabase = await prisma.location.count();
      } catch (error: any) {
        console.error('Error counting Location rows:', error);
      }

      // Get recent jobs
      const recentJobs = await prisma.scraperJob.findMany({
        orderBy: { startedAt: 'desc' },
        take: 5,
        select: {
          id: true,
          brandName: true,
          status: true,
          startedAt: true,
          completedAt: true,
          recordsScraped: true
        }
      });

      res.json({
        stats: {
          totalJobs,
          runningJobs,
          completedJobs,
          failedJobs,
          totalStoresInDatabase,
          /** @deprecated same as totalStoresInDatabase; kept for older clients */
          totalRecords: totalStoresInDatabase,
        },
        recentJobs
      });
    } catch (error: any) {
      console.error('Error getting scraper stats:', error);
      res.status(500).json({ error: error.message });
    }
  },

  // POST /api/scraper/jobs/:id/cancel - Cancel a running job
  async cancelJob(req: Request, res: Response) {
    try {
      const { id } = req.params;

      const result = await scraperService.cancelJob(id);

      if (result.success) {
        res.json({ message: result.message });
      } else {
        res.status(400).json({ error: result.message });
      }
    } catch (error: any) {
      console.error('Error cancelling scraper job:', error);
      res.status(500).json({ error: error.message });
    }
  },

  // GET /api/scraper/jobs/:id/dropped-records - Get dropped/excluded records for a completed job
  async getJobDroppedRecords(req: Request, res: Response) {
    try {
      const { id } = req.params;

      const job = await prisma.scraperJob.findUnique({
        where: { id },
        include: { upload: true }
      });

      if (!job) {
        return res.status(404).json({ error: 'Job not found' });
      }

      if (job.status !== 'completed') {
        return res.status(400).json({ error: 'Only completed jobs have dropped records' });
      }

      if (!job.uploadId || !job.upload) {
        return res.status(404).json({ error: 'No upload linked to this job' });
      }

      // Dropped file is alongside the CSV: scraped/brand_timestamp.csv -> scraped/brand_timestamp_dropped.json
      const droppedFilename = job.upload.filename.replace(/\.csv$/i, '_dropped.json');
      const droppedPath = await uploadService.getFilePath(droppedFilename);

      if (!droppedPath || !fs.existsSync(droppedPath)) {
        return res.json({ jobId: job.id, excludedStores: [], count: 0 });
      }

      const fileContent = fs.readFileSync(droppedPath, 'utf-8');
      const data = JSON.parse(fileContent);

      res.json({
        jobId: job.id,
        brandName: job.brandName,
        excludedStores: data.excluded_stores || [],
        count: data.count ?? (data.excluded_stores?.length ?? 0)
      });
    } catch (error: any) {
      console.error('Error fetching dropped records:', error);
      res.status(500).json({ error: error.message });
    }
  },

  // GET /api/scraper/jobs/:id/records - Get records for a completed job (see scraperService.getJobRecordsPayload).
  async getJobRecords(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const payload = await scraperService.getJobRecordsPayload(id);
      res.json(payload);
    } catch (error: any) {
      const msg = error.message || 'Error fetching job records';
      if (msg === 'Job not found') {
        return res.status(404).json({ error: msg });
      }
      if (msg === 'Only completed jobs have viewable records') {
        return res.status(400).json({ error: msg });
      }
      if (msg === 'No upload linked to this job' || msg === 'Job CSV file not found') {
        return res.status(404).json({ error: msg });
      }
      console.error('Error fetching job records:', error);
      res.status(500).json({ error: msg });
    }
  },

  // PATCH /api/scraper/jobs/:id/records - Save job records (to job CSV) and append complete records to master
  async saveJobRecords(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { records } = req.body as { records: Record<string, string>[] };

      if (!Array.isArray(records) || records.length === 0) {
        return res.status(400).json({ error: 'records array with at least one record is required' });
      }

      const result = await scraperService.saveJobRecords(id, records);

      res.json({
        message: 'Job records saved',
        savedToJob: result.savedToJob,
        skippedIncomplete: result.skippedIncomplete,
        dbUpserted: result.dbUpserted,
        validationErrors: result.validationErrors,
      });
    } catch (error: any) {
      console.error('Error saving job records:', error);
      res.status(500).json({ error: error.message });
    }
  },

  // GET /api/scraper/master-csv/countries - Distinct countries in DB for optional brand / premium scope
  async getMasterCsvCountries(req: Request, res: Response) {
    try {
      const scope = masterBrandPremiumScopeFromQuery(req);
      const countries = await storeService.listDistinctCountriesForMasterFilter(scope);
      res.json({ countries });
    } catch (error: any) {
      console.error('Error fetching master CSV countries:', error);
      res.status(500).json({ error: error.message });
    }
  },

  // GET /api/scraper/master-csv/records - Get master store records (optional brand, country, premium)
  async getMasterCsvRecords(req: Request, res: Response) {
    try {
      const filters = masterExportFiltersFromQuery(req);
      const result = await storeService.getMasterRecords(filters);
      res.json({
        columns: result.columns,
        records: result.records,
        totalCount: result.totalCount,
      });
    } catch (error: any) {
      console.error('Error fetching master CSV records:', error);
      res.status(500).json({ error: error.message });
    }
  },

  // DELETE /api/scraper/master-csv/records - Remove a single store from master by Handle
  async deleteMasterRecord(req: Request, res: Response) {
    try {
      const { handle } = req.body as { handle?: string };
      if (!handle || typeof handle !== 'string') {
        return res.status(400).json({ error: 'handle is required' });
      }
      const { removed } = await storeService.deleteMasterRecord(handle);
      res.json({ removed });
    } catch (error: any) {
      console.error('Error deleting master record:', error);
      res.status(500).json({ error: error.message });
    }
  },

  // PATCH /api/scraper/master-csv - Update Location rows in the DB directly.
  async updateMasterCsvRows(req: Request, res: Response) {
    try {
      const { rows: updates } = req.body as { rows: Record<string, string>[] };

      if (!Array.isArray(updates) || updates.length === 0) {
        return res.status(400).json({ error: 'rows array with at least one record is required' });
      }

      const { updatedCount, totalRequested, dbUpserted, dbSkipped } =
        await storeService.updateMasterRecords(updates);

      res.json({
        message: 'Master records updated successfully',
        updatedCount,
        totalRequested,
        dbUpserted,
        dbSkipped,
      });
    } catch (error: any) {
      console.error('Error updating master records:', error);
      res.status(500).json({ error: error.message });
    }
  },

  // POST /api/scraper/discover - Discover endpoints from store locator page
  async discoverEndpoints(req: Request, res: Response) {
    try {
      const { url } = req.body;

      if (!url) {
        return res.status(400).json({ error: 'URL is required' });
      }

      // Create a temporary output file for JSON results
      const outputDir = path.join(__dirname, '..', '..', '..', 'tmp');
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }
      const outputFile = path.join(outputDir, `discovery_${Date.now()}.json`);

      // Call the endpoint discoverer Python script
      const { spawn } = require('child_process');
      const discovererPath = path.join(ENDPOINT_DISCOVERER_PATH, 'endpoint_discoverer.py');

      return new Promise((resolve, reject) => {
        let responseSent = false;
        
        const sendResponse = (statusCode: number, data: any) => {
          if (!responseSent) {
            responseSent = true;
            res.status(statusCode).json(data);
            // Resolve the Promise after sending response to prevent hanging in Express v5+
            if (statusCode >= 200 && statusCode < 300) {
              resolve(data);
            } else {
              reject(new Error(data.error || 'Request failed'));
            }
          }
        };

        const pythonProcess = spawn(PYTHON_CMD, [
          discovererPath,
          '--url',
          url,
          '--headless',
          '--output',
          outputFile
        ], {
          cwd: path.dirname(discovererPath),
          env: { ...process.env, PYTHONUNBUFFERED: '1' }
        });

        let stdout = '';
        let stderr = '';

        pythonProcess.stdout.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        pythonProcess.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        pythonProcess.on('close', (code: number) => {
          // Try to read the output file
          try {
            if (fs.existsSync(outputFile)) {
              const resultData = fs.readFileSync(outputFile, 'utf-8');
              const result = JSON.parse(resultData);
              
              // Clean up temp file
              fs.unlinkSync(outputFile);
              
              sendResponse(200, result);
            } else {
              // If output file doesn't exist, try to parse stdout for JSON
              // Find the last complete JSON object (endpoint discoverer outputs final result at the end)
              // This handles cases where stdout contains multiple JSON objects or mixed text/JSON
              let jsonMatch: RegExpMatchArray | null = null;
              const lastBraceIndex = stdout.lastIndexOf('}');
              if (lastBraceIndex !== -1) {
                // Find the matching opening brace by counting braces backwards
                let braceCount = 1;
                let startIndex = lastBraceIndex - 1;
                while (startIndex >= 0 && braceCount > 0) {
                  if (stdout[startIndex] === '}') braceCount++;
                  else if (stdout[startIndex] === '{') braceCount--;
                  startIndex--;
                }
                if (braceCount === 0) {
                  // Found balanced braces - extract the JSON object
                  const jsonString = stdout.substring(startIndex + 1, lastBraceIndex + 1);
                  jsonMatch = [jsonString];
                }
              }
              
              // Fallback: if brace matching failed, try non-greedy regex for first JSON object
              if (!jsonMatch) {
                jsonMatch = stdout.match(/\{[\s\S]*?\}/);
              }
              
              if (jsonMatch) {
                try {
                  const result = JSON.parse(jsonMatch[0]);
                  sendResponse(200, result);
                } catch {
                  sendResponse(500, {
                    error: 'Endpoint discovery completed but failed to parse results',
                    details: stderr || 'No error details available',
                    raw_output: stdout.substring(0, 1000)
                  });
                }
              } else {
                sendResponse(500, {
                  error: 'Endpoint discovery failed',
                  details: stderr || 'No output file created and no JSON found in stdout',
                  raw_output: stdout.substring(0, 1000)
                });
              }
            }
          } catch (fileError: any) {
            // Clean up temp file if it exists
            if (fs.existsSync(outputFile)) {
              try {
                fs.unlinkSync(outputFile);
              } catch {}
            }
            
            sendResponse(500, {
              error: 'Failed to read discovery results',
              details: fileError.message,
              raw_output: stdout.substring(0, 1000)
            });
          }
        });

        // Set timeout (5 minutes for discovery - some store locators load slowly)
        const DISCOVERY_TIMEOUT_MS = 5 * 60 * 1000;
        const timeoutId = setTimeout(() => {
          if (!pythonProcess.killed && !responseSent) {
            pythonProcess.kill();
            sendResponse(500, {
              error: 'Endpoint discovery timed out after 5 minutes'
            });
          }
        }, DISCOVERY_TIMEOUT_MS);

        pythonProcess.on('error', (error: Error) => {
          // Clear timeout when process fails to start
          clearTimeout(timeoutId);
          sendResponse(500, {
            error: 'Failed to start endpoint discoverer',
            details: error.message
          });
        });

        // Clear timeout if process completes before timeout
        pythonProcess.on('close', () => {
          clearTimeout(timeoutId);
        });
      });
    } catch (error: any) {
      console.error('Error discovering endpoints:', error);
      res.status(500).json({ error: error.message });
    }
  },

  // POST /api/scraper/probe-endpoint - Probe a manually entered endpoint (HTTP-only, no Selenium)
  async probeEndpoint(req: Request, res: Response) {
    try {
      const { url } = req.body as { url?: string };
      if (!url || typeof url !== 'string' || !url.trim()) {
        return res.status(400).json({ error: 'URL is required' });
      }

      const outputFile = ensureTmpOutputFile('probe');
      const { spawn } = require('child_process');
      const probeScriptPath = path.join(ENDPOINT_DISCOVERER_PATH, 'probe_endpoint.py');

      return new Promise((resolve, reject) => {
        let responseSent = false;
        let stdout = '';
        let stderr = '';

        const sendResponse = (statusCode: number, data: any) => {
          if (!responseSent) {
            responseSent = true;
            res.status(statusCode).json(data);
            if (statusCode >= 200 && statusCode < 300) {
              resolve(data);
            } else {
              reject(new Error(data.error || 'Request failed'));
            }
          }
        };

        const pythonProcess = spawn(
          PYTHON_CMD,
          [probeScriptPath, '--url', url.trim(), '--output', outputFile],
          {
            cwd: path.dirname(probeScriptPath),
            env: { ...process.env, PYTHONUNBUFFERED: '1' },
          }
        );

        pythonProcess.stdout.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        pythonProcess.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        pythonProcess.on('close', () => {
          try {
            if (fs.existsSync(outputFile)) {
              const resultData = fs.readFileSync(outputFile, 'utf-8');
              const result = JSON.parse(resultData);
              fs.unlinkSync(outputFile);
              return sendResponse(200, result);
            }

            const jsonMatch = stdout.match(/\{[\s\S]*\}$/);
            if (jsonMatch) {
              const result = JSON.parse(jsonMatch[0]);
              return sendResponse(200, result);
            }

            sendResponse(500, {
              error: 'Endpoint probe failed',
              details: stderr || 'No output file created and no JSON found in stdout',
              raw_output: stdout.substring(0, 1000),
            });
          } catch (error: any) {
            if (fs.existsSync(outputFile)) {
              try {
                fs.unlinkSync(outputFile);
              } catch {
                // Ignore temp cleanup errors.
              }
            }
            sendResponse(500, {
              error: 'Failed to read probe results',
              details: error.message,
              raw_output: stdout.substring(0, 1000),
            });
          }
        });

        const PROBE_TIMEOUT_MS = 30 * 1000;
        const timeoutId = setTimeout(() => {
          if (!pythonProcess.killed && !responseSent) {
            pythonProcess.kill();
            sendResponse(500, { error: 'Endpoint probe timed out after 30 seconds' });
          }
        }, PROBE_TIMEOUT_MS);

        pythonProcess.on('error', (error: Error) => {
          clearTimeout(timeoutId);
          sendResponse(500, {
            error: 'Failed to start endpoint probe',
            details: error.message,
          });
        });

        pythonProcess.on('close', () => {
          clearTimeout(timeoutId);
        });
      });
    } catch (error: any) {
      console.error('Error probing endpoint:', error);
      res.status(500).json({ error: error.message });
    }
  },

  // GET /api/scraper/brands/:id - Get a specific brand configuration
  async getBrandConfig(req: Request, res: Response) {
    try {
      const { id } = req.params;

      const configs = await loadMergedBrandConfigs();

      if (!configs[id]) {
        return res.status(404).json({ error: `Brand configuration "${id}" not found` });
      }

      res.json({ brandId: id, config: configs[id] });
    } catch (error: any) {
      console.error('Error getting brand config:', error);
      res.status(500).json({ error: error.message });
    }
  },

  // POST /api/scraper/verify-coordinates - Start a geo-verify + dedup pipeline for a brand
  async startVerifyCoordinates(req: Request, res: Response) {
    try {
      const { brandName } = req.body as { brandName?: string };
      if (!brandName || typeof brandName !== 'string' || !brandName.trim()) {
        return res.status(400).json({ error: 'brandName is required' });
      }

      pruneGeoVerifyTasks();

      const taskId = crypto.randomUUID();
      const task: GeoVerifyTask = {
        id: taskId,
        brandName: brandName.trim(),
        status: 'running',
        progress: { checked: 0, total: 0 },
        phase: 'geocoding',
        log: [],
        startedAt: new Date(),
      };
      geoVerifyTasks.set(taskId, task);

      runGeoVerifyPipeline(task).catch((e) => {
        task.status = 'error';
        task.phase = 'done';
        task.error = String(e);
        markGeoVerifyTaskFinished(task);
      });

      res.status(202).json({ taskId });
    } catch (error: any) {
      console.error('Error starting verify-coordinates task:', error);
      res.status(500).json({ error: error.message });
    }
  },

  // GET /api/scraper/verify-coordinates/:taskId - Poll task status
  async getVerifyCoordinatesStatus(req: Request, res: Response) {
    try {
      pruneGeoVerifyTasks();
      const { taskId } = req.params;
      const task = geoVerifyTasks.get(taskId);
      if (!task) {
        return res.status(404).json({ error: 'Task not found' });
      }
      res.json({
        taskId: task.id,
        brandName: task.brandName,
        status: task.status,
        phase: task.phase,
        progress: task.progress,
        log: task.log,
        result: task.result,
        error: task.error,
        startedAt: task.startedAt,
      });
    } catch (error: any) {
      console.error('Error getting verify-coordinates status:', error);
      res.status(500).json({ error: error.message });
    }
  },

  // POST /api/scraper/brands - Save discovered endpoint as brand configuration
  async saveBrandConfig(req: Request, res: Response) {
    try {
      const { brandId, brandName, endpoint, suggestedConfig, overwrite, oldBrandId } = req.body;

      if (!brandId || !endpoint || !endpoint.url) {
        return res.status(400).json({ error: 'brandId and endpoint.url are required' });
      }

      // Load existing brand configs (baseline file + DB)
      const configs = await loadMergedBrandConfigs();

      // Check for exact match first
      if (configs[brandId] && overwrite !== true) {
        // Return existing config so frontend can show comparison
        return res.status(409).json({ 
          error: `Brand configuration "${brandId}" already exists`,
          existingConfig: configs[brandId],
          brandId
        });
      }

      // Check for similar brand configs (by name similarity or URL match)
      const similarConfigs: SimilarBrandConfig[] = findSimilarBrandConfigs(brandId, endpoint.url, configs);
      if (similarConfigs.length > 0 && overwrite !== true) {
        // Return the most similar config (highest similarity)
        const mostSimilar: SimilarBrandConfig = similarConfigs[0];
        return res.status(409).json({
          error: `Similar brand configuration found: "${mostSimilar.brandId}"`,
          existingConfig: mostSimilar.config,
          brandId: mostSimilar.brandId,
          similarity: mostSimilar.similarity,
          reason: mostSimilar.reason,
          allSimilar: similarConfigs.map((s: SimilarBrandConfig) => ({
            brandId: s.brandId,
            similarity: s.similarity,
            reason: s.reason
          }))
        });
      }
      
      // If overwrite is true, we'll proceed to overwrite below
      // If overwrite is false/undefined and config exists, we already returned above

      // Build brand configuration from discovered endpoint
      // Use suggested_config as base if available, otherwise build from endpoint
      const baseConfig = suggestedConfig || {};
      const brandConfig: any = {
        type: endpoint.type || baseConfig.type || 'json',
        url: endpoint.url,
        method: baseConfig.method || 'GET',
        description: baseConfig.description || `Discovered endpoint for ${brandName || brandId}`,
        enabled: true
      };

      const configuredDisplayName =
        typeof brandName === 'string' && brandName.trim() ? brandName.trim() : '';
      if (configuredDisplayName) {
        brandConfig.display_name = configuredDisplayName;
      }

      // Add data_path if available (from verified endpoint or suggested config)
      // Priority: endpoint.data_path > baseConfig.data_path
      // This is critical for the scraper to find stores in the JSON response
      if (endpoint.data_path && endpoint.data_path.trim()) {
        brandConfig.data_path = endpoint.data_path;
      } else if (baseConfig.data_path && baseConfig.data_path.trim()) {
        brandConfig.data_path = baseConfig.data_path;
      }
      
      // Log warning if data_path is missing (helps debug)
      if (!brandConfig.data_path) {
        console.warn(`⚠️  Warning: No data_path detected for brand ${brandId}. The scraper may not be able to find stores in the JSON response.`);
      }

      // Add field_mapping if available
      // Priority: baseConfig.field_mapping (from pattern detector) > endpoint.field_mapping (from verifier)
      // The pattern detector has more accurate detection, so prefer it
      if (baseConfig.field_mapping && Object.keys(baseConfig.field_mapping).length > 0) {
        brandConfig.field_mapping = baseConfig.field_mapping;
      } else if (endpoint.field_mapping && Object.keys(endpoint.field_mapping).length > 0) {
        brandConfig.field_mapping = endpoint.field_mapping;
      }

      // Add headers if needed (e.g., Accept: application/json)
      if (baseConfig.headers) {
        brandConfig.headers = baseConfig.headers;
      }

      // Add any other properties from suggested config
      if (baseConfig._note) {
        brandConfig._note = baseConfig._note;
      }

      // When overwriting with a new name, drop old DB row and hide baseline file key if present
      if (overwrite === true && oldBrandId && oldBrandId !== brandId) {
        await applyBrandRename(oldBrandId);
      }

      await upsertBrandConfigRow(brandId, brandConfig);

      res.json({
        message: 'Brand configuration saved successfully',
        brandId,
        config: brandConfig
      });
    } catch (error: any) {
      console.error('Error saving brand config:', error);
      res.status(500).json({ error: error.message });
    }
  }
};

