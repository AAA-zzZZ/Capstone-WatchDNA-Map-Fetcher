import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import prisma from '../lib/prisma';
import { PYTHON_CMD, VALIDATE_CSV_PATH, SCRAPER_PATH } from '../utils/paths';
import { config } from '../config';

export interface ServiceCheck {
  name: string;
  status: 'healthy' | 'unhealthy' | 'degraded';
  responseTime: number;
  message?: string;
  details?: Record<string, any>;
}

export interface HealthReport {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptime: number;
  environment: string;
  version: string;
  services: ServiceCheck[];
  summary: {
    total: number;
    healthy: number;
    degraded: number;
    unhealthy: number;
  };
}

const startTime = Date.now();

async function checkDatabase(): Promise<ServiceCheck> {
  const start = Date.now();
  try {
    const [result, brandConfigCount] = await Promise.all([
      prisma.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*) as count FROM "Location"`,
      prisma.brandConfig.count(),
    ]);
    const count = Number(result[0]?.count ?? 0);
    return {
      name: 'PostgreSQL Database',
      status: 'healthy',
      responseTime: Date.now() - start,
      message: `Connected — ${count} locations, ${brandConfigCount} brand config(s) in DB`,
      details: { locationCount: count, brandConfigCount },
    };
  } catch (error: any) {
    return {
      name: 'PostgreSQL Database',
      status: 'unhealthy',
      responseTime: Date.now() - start,
      message: `Connection failed: ${error.message}`,
    };
  }
}

async function checkAuth(): Promise<ServiceCheck> {
  const start = Date.now();
  try {
    const users = await prisma.user.count();
    return {
      name: 'Authentication Service',
      status: users > 0 ? 'healthy' : 'degraded',
      responseTime: Date.now() - start,
      message: users > 0 ? `${users} admin user(s) configured` : 'No admin users — run seed script',
      details: { userCount: users },
    };
  } catch (error: any) {
    return {
      name: 'Authentication Service',
      status: 'unhealthy',
      responseTime: Date.now() - start,
      message: `Auth check failed: ${error.message}`,
    };
  }
}

function checkFileSystem(): ServiceCheck {
  const start = Date.now();
  const uploadDir = path.join(__dirname, '..', '..', config.upload.dir);
  const issues: string[] = [];

  if (!fs.existsSync(uploadDir)) {
    issues.push(`Upload directory missing: ${uploadDir}`);
  } else {
    try {
      const testFile = path.join(uploadDir, '.health-check-test');
      fs.writeFileSync(testFile, 'test');
      fs.unlinkSync(testFile);
    } catch {
      issues.push('Upload directory not writable');
    }
  }

  return {
    name: 'File System',
    status: issues.length === 0 ? 'healthy' : 'degraded',
    responseTime: Date.now() - start,
    message:
      issues.length === 0
        ? 'Upload directory writable (brand configs persist in PostgreSQL)'
        : issues.join('; '),
    details: { uploadDir },
  };
}

function checkPython(): ServiceCheck {
  const start = Date.now();
  try {
    const version = execSync(`${PYTHON_CMD} --version 2>&1`, { timeout: 5000 }).toString().trim();
    const validatorExists = fs.existsSync(VALIDATE_CSV_PATH);
    const scraperExists = fs.existsSync(SCRAPER_PATH);

    if (!validatorExists) {
      return {
        name: 'Python Environment',
        status: 'degraded',
        responseTime: Date.now() - start,
        message: `${version} available, but validate_csv.py not found`,
        details: { version, validatorExists, scraperExists },
      };
    }

    return {
      name: 'Python Environment',
      status: 'healthy',
      responseTime: Date.now() - start,
      message: `${version} — validator and scraper available`,
      details: { version, validatorExists, scraperExists },
    };
  } catch (error: any) {
    return {
      name: 'Python Environment',
      status: 'unhealthy',
      responseTime: Date.now() - start,
      message: `Python not available: ${error.message}`,
    };
  }
}

function checkSecurityConfig(): ServiceCheck {
  const start = Date.now();
  const issues: string[] = [];

  if (!config.isProduction && !config.isDevelopment) {
    issues.push('NODE_ENV not explicitly set');
  }

  if (config.cors.allowedOrigins.length === 0) {
    issues.push('No CORS origins configured');
  }

  const jwtSecret = process.env.JWT_SECRET || '';
  if (config.isProduction && jwtSecret.length < 32) {
    issues.push('JWT_SECRET too short for production');
  }
  if (jwtSecret === 'default_secret_change_me' || jwtSecret === 'change_this_to_random_secret_in_production') {
    issues.push('Using default JWT_SECRET — change immediately');
  }

  return {
    name: 'Security Configuration',
    status: issues.length === 0 ? 'healthy' : (config.isProduction ? 'unhealthy' : 'degraded'),
    responseTime: Date.now() - start,
    message: issues.length === 0 ? 'All security checks passed' : issues.join('; '),
    details: {
      environment: config.nodeEnv,
      corsOrigins: config.cors.allowedOrigins.length,
      rateLimitEnabled: !config.isDevelopment,
    },
  };
}

async function checkPremiumStores(): Promise<ServiceCheck> {
  const start = Date.now();
  try {
    const count = await prisma.premiumStore.count();
    return {
      name: 'Premium Store Registry',
      status: count > 0 ? 'healthy' : 'degraded',
      responseTime: Date.now() - start,
      message: count > 0 ? `${count} premium store(s) registered` : 'No premium stores configured',
      details: { premiumStoreCount: count },
    };
  } catch (error: any) {
    return {
      name: 'Premium Store Registry',
      status: 'unhealthy',
      responseTime: Date.now() - start,
      message: `Check failed: ${error.message}`,
    };
  }
}

export async function getHealthReport(): Promise<HealthReport> {
  const services = await Promise.all([
    checkDatabase(),
    checkAuth(),
    checkPremiumStores(),
    Promise.resolve(checkFileSystem()),
    Promise.resolve(checkPython()),
    Promise.resolve(checkSecurityConfig()),
  ]);

  const summary = {
    total: services.length,
    healthy: services.filter(s => s.status === 'healthy').length,
    degraded: services.filter(s => s.status === 'degraded').length,
    unhealthy: services.filter(s => s.status === 'unhealthy').length,
  };

  let overallStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
  if (summary.unhealthy > 0) overallStatus = 'unhealthy';
  else if (summary.degraded > 0) overallStatus = 'degraded';

  return {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    uptime: Math.floor((Date.now() - startTime) / 1000),
    environment: config.nodeEnv,
    version: process.env.npm_package_version || '1.0.0',
    services,
    summary,
  };
}
