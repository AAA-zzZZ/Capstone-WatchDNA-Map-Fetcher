import { spawn } from 'child_process';
import path from 'path';
import { VALIDATE_CSV_PATH, PYTHON_CMD } from '../utils/paths';
import { logger } from '../utils/logger';

export interface ValidationError {
  row: number;
  field: string;
  issue: string;
  value?: string;
}

export interface ValidationWarning {
  type: string;
  message: string;
  [key: string]: any;
}

export interface ValidationResult {
  valid: boolean;
  file: string;
  rows_checked: number;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  status: string;
  exit_code: number;
}

export class ValidationService {
  private pythonPath: string;
  private validatorScriptPath: string;

  constructor() {
    this.pythonPath = PYTHON_CMD;
    this.validatorScriptPath = VALIDATE_CSV_PATH;
  }

  async validateCSV(
    filePath: string,
    options?: {
      autoFix?: boolean;
      checkUrls?: boolean;
      dbImportParity?: boolean;
    }
  ): Promise<ValidationResult> {
    return new Promise((resolve, reject) => {
      const args = [
        this.validatorScriptPath,
        filePath,
        '--json'
      ];

      if (options?.autoFix) args.push('--fix');
      if (options?.checkUrls) args.push('--check-urls');
      if (options?.dbImportParity) args.push('--db-import-parity');

      logger.debug(`[Validation] ${path.basename(filePath)}${options?.autoFix ? ' --fix' : ''}`);

      const childProcess = spawn(this.pythonPath, args);

      let stdoutData = '';
      let stderrData = '';

      childProcess.stdout.on('data', (data) => { stdoutData += data.toString(); });
      childProcess.stderr.on('data', (data) => { stderrData += data.toString(); });

      childProcess.on('close', (code) => {
        logger.debug(`[Validation] exit=${code} file=${path.basename(filePath)}`);

        if (stderrData) {
          logger.debug(`[Validation] stderr: ${stderrData.trim()}`);
        }

        try {
          const jsonMatch = stdoutData.match(/\{[\s\S]*\}/);

          if (!jsonMatch) {
            if (code === 0) {
              resolve({
                valid: true,
                file: filePath,
                rows_checked: 0,
                errors: [],
                warnings: [],
                status: 'passed',
                exit_code: 0
              });
            } else {
              reject(new Error(`Validation failed (exit ${code}): ${stdoutData.slice(0, 200)}`));
            }
            return;
          }

          const result = JSON.parse(jsonMatch[0]);
          resolve({
            valid: code === 0,
            file: result.file || filePath,
            rows_checked: result.rows_checked || 0,
            errors: result.errors || [],
            warnings: result.warnings || [],
            status: result.status || (code === 0 ? 'passed' : 'failed'),
            exit_code: code || 0
          });

        } catch (err) {
          logger.error('[Validation] Failed to parse output:', err);
          logger.error('[Validation] stdout:', stdoutData.slice(0, 500));
          reject(new Error(`Failed to parse validation output: ${err}`));
        }
      });

      childProcess.on('error', (err) => {
        logger.error('[Validation] Failed to start process:', err);
        reject(new Error(`Failed to start validation: ${err.message}`));
      });
    });
  }

  /**
   * Convert validation result to database-friendly format.
   */
  formatForDatabase(result: ValidationResult) {
    return {
      validationErrors: JSON.stringify(result.errors),
      validationWarnings: JSON.stringify(result.warnings),
      rowsTotal: result.rows_checked,
      status: result.valid ? 'valid' : 'invalid'
    };
  }

  /**
   * Convert validation result to validation log entries.
   */
  createValidationLogs(uploadId: string, result: ValidationResult) {
    const logs: any[] = [];

    result.errors.forEach(error => {
      logs.push({
        uploadId,
        rowNumber: error.row,
        logType: 'error',
        fieldName: error.field,
        issueType: error.issue,
        message: `${error.field}: ${error.issue}`,
        value: error.value || null
      });
    });

    result.warnings.forEach(warning => {
      logs.push({
        uploadId,
        rowNumber: null,
        logType: 'warning',
        fieldName: null,
        issueType: warning.type,
        message: warning.message,
        value: JSON.stringify(warning)
      });
    });

    return logs;
  }

  /**
   * Render a compact one-line summary suitable for embedding in a job log section.
   */
  formatLogSection(result: ValidationResult): string {
    const status = result.valid ? 'PASSED' : 'FAILED';
    const lines = [
      `Status: ${status}`,
      `Rows: ${result.rows_checked} | Errors: ${result.errors.length} | Warnings: ${result.warnings.length}`,
    ];
    if (result.errors.length > 0) {
      lines.push('Errors:');
      result.errors.slice(0, 10).forEach(e =>
        lines.push(`  Row ${e.row} [${e.field}] ${e.issue}${e.value ? ` — "${e.value}"` : ''}`)
      );
      if (result.errors.length > 10) {
        lines.push(`  ... and ${result.errors.length - 10} more`);
      }
    }
    return lines.join('\n');
  }
}

export default new ValidationService();
