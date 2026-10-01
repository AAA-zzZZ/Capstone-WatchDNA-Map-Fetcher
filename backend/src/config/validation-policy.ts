/**
 * Single place for validate_csv.py (--fix / --check-urls) behavior per flow.
 * See docs/data-pipeline.md for rationale.
 */

export type ValidateCsvOptions = {
  autoFix?: boolean;
  checkUrls?: boolean;
  /** Passes `--db-import-parity` to validate_csv.py (Phone + address line 1 or 2). */
  dbImportParity?: boolean;
};

/** Initial processing when an admin uploads a CSV. */
export const VALIDATION_MANUAL_UPLOAD: ValidateCsvOptions = {
  autoFix: true,
  checkUrls: false,
  dbImportParity: true,
};

/**
 * Right after a scraper job writes its CSV — same auto-fix as manual upload so
 * the on-disk file and DB import stay aligned with validation rules.
 */
export const VALIDATION_SCRAPER_JOB_COMPLETION: ValidateCsvOptions = {
  autoFix: true,
  checkUrls: false,
};

/** PATCH /api/scraper/jobs/:id/records — edits persisted to job CSV then DB. */
export const VALIDATION_JOB_RECORDS_SAVE: ValidateCsvOptions = {
  autoFix: true,
  checkUrls: false,
};

/** Default when POST /api/uploads/:id/revalidate omits body flags. */
export const VALIDATION_REVALIDATE_DEFAULT: ValidateCsvOptions = {
  autoFix: true,
  checkUrls: false,
  dbImportParity: true,
};
