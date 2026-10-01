/**
 * Validate then import a store CSV using the same pipeline as admin CSV upload:
 * Python validate_csv (--fix, --db-import-parity), then locationService.importFromCSV
 * (batch upsert, dedupe, merge with existing stores — same as scraper output).
 *
 * Usage (from backend/):
 *   npm run import-data -- ./path/to/stores.csv
 *   IMPORT_CSV_PATH=./stores.csv npm run import-data
 */

import path from 'path';
import fs from 'fs/promises';
import uploadService from '../services/upload.service';
import prisma from '../lib/prisma';
import { logger } from '../utils/logger';

function resolveCsvPath(): string {
  const fromArg = process.argv[2]?.trim();
  if (fromArg) {
    return path.isAbsolute(fromArg) ? fromArg : path.resolve(process.cwd(), fromArg);
  }
  const fromEnv = process.env.IMPORT_CSV_PATH?.trim();
  if (fromEnv) {
    return path.isAbsolute(fromEnv) ? fromEnv : path.resolve(process.cwd(), fromEnv);
  }
  console.error(
    'Missing CSV path.\n' +
      '  npm run import-data -- <path-to.csv>\n' +
      '  or set IMPORT_CSV_PATH to a CSV file.'
  );
  throw new Error('Missing CSV path');
}

async function main() {
  const csvPath = resolveCsvPath();

  try {
    await fs.access(csvPath);
  } catch {
    console.error(`File not found: ${csvPath}`);
    process.exit(1);
  }

  const stat = await fs.stat(csvPath);
  const base = path.basename(csvPath);

  const upload = await uploadService.createUpload({
    filename: base,
    originalFilename: base,
    fileSize: stat.size,
    uploadedBy: 'import-csv-locations',
    scraperType: 'manual_upload',
  });

  logger.warn(`[import-csv-locations] ${csvPath} → upload ${upload.id}`);

  const processResult = await uploadService.processUpload(upload.id, csvPath);
  const { validationResult, importResult, importError, success: processSuccess } = processResult;

  console.log(
    JSON.stringify(
      {
        uploadId: upload.id,
        valid: validationResult.valid,
        rowsChecked: validationResult.rows_checked,
        errors: validationResult.errors,
        warningsCount: validationResult.warnings.length,
        importSuccess: processSuccess,
        importError: importError ?? undefined,
        import: importResult
          ? {
              newCount: importResult.newCount,
              updatedCount: importResult.updatedCount,
              unchangedCount: importResult.unchangedCount,
              skippedCount: importResult.skippedCount,
              errorCount: importResult.errorCount,
            }
          : null,
      },
      null,
      2
    )
  );

  if (!validationResult.valid) {
    console.error('Validation failed; database not updated.');
    process.exit(1);
  }

  if (!processSuccess) {
    console.error(
      `Import failed after validation; database may be incomplete. ${importError ?? 'No import result returned.'}`
    );
    process.exit(1);
  }

  const final = await prisma.upload.findUnique({ where: { id: upload.id } });
  console.log('Upload status:', final?.status, 'rowsProcessed:', final?.rowsProcessed, 'rowsFailed:', final?.rowsFailed);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
