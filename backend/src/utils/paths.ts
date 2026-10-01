import path from 'path';
import fs from 'fs';

/**
 * Resolves the absolute path to the scraper/tools directories.
 *
 * Dev (ts-node):    __dirname = backend/src/utils  → backendRoot = backend/
 * Prod (Dockerfile): __dirname = /app/backend/dist/utils → backendRoot = /app/backend
 *
 * The Dockerfile copies the entire repo to /app, so Prototypes/ and tools/ are
 * available at /app/Prototypes and /app/tools respectively.
 * The Python venv is created at /app/venv by the Dockerfile.
 */

// backend/ in dev; /app/backend in production
const backendRoot = path.join(__dirname, '..', '..');

// Scraper directory: honour SCRAPER_PATH env var first, then dev default
export const SCRAPER_PATH: string = process.env.SCRAPER_PATH
  ? process.env.SCRAPER_PATH
  : path.join(backendRoot, '..', 'Prototypes', 'Data_Scrappers');

// Endpoint discoverer directory
export const ENDPOINT_DISCOVERER_PATH: string = process.env.SCRAPER_PATH
  ? path.join(process.env.SCRAPER_PATH, '..', 'endpoint_discoverer')
  : path.join(backendRoot, '..', 'Prototypes', 'endpoint_discoverer');

// brand_configs.json — lives inside backend/ so it is always deployed
export const BRAND_CONFIGS_PATH: string = path.join(backendRoot, 'brand_configs.json');

// validate_csv.py — lives inside backend/tools/ so it is always deployed
export const VALIDATE_CSV_PATH: string = path.join(backendRoot, 'tools', 'validate_csv.py');

// Python command: prefer venv if present (dev), else system python3
const venvPython = path.join(backendRoot, '..', 'venv', 'bin', 'python3');
export const PYTHON_CMD: string = (() => {
  if (process.env.PYTHON_PATH) return process.env.PYTHON_PATH;
  if (fs.existsSync(venvPython)) return venvPython;
  return 'python3';
})();
