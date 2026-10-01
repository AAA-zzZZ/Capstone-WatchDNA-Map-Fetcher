// Must run before any import that loads Prisma (env is read when PrismaClient is constructed).
import './load-env';

import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';

// Import configuration
import { config, validateConfig } from './config';
import { logger } from './utils/logger';

//Import services
import { storeService } from './services/store.service';

// Validate configuration on startup
validateConfig();

// Import middleware
import { authLimiter, publicLimiter, scraperLimiter, analyticsLimiter } from './middleware/rateLimiter';
import { securityHeaders } from './middleware/security';

// Import routes
import authRoutes from './routes/auth.routes';
import uploadRoutes from './routes/upload.routes';
import scraperRoutes from './routes/scraper.routes';
import locationRoutes from './routes/location.routes';
import healthRoutes from './routes/health.routes';
import premiumRoutes from './routes/premium.routes';
import analyticsRoutes from './routes/analytics.routes';
import adminRoutes from './routes/admin.routes';

const app: Express = express();
const PORT = config.port;

// Trust proxy (required for Railway/Render to get real client IP)
app.set('trust proxy', 1);

// CORS Configuration
const localDevOrigin =
  /^http:\/\/(localhost|127\.0\.0\.1):\d+$/;

const corsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    // Allow requests with no origin (mobile apps, Postman, curl, etc.)
    if (!origin) {
      return callback(null, true);
    }

    // Vite may use 5174, 5175, … when the default port is taken — allow any localhost port in non-production
    if (!config.isProduction && localDevOrigin.test(origin)) {
      return callback(null, true);
    }

    // Check if origin is in allowed list
    if (config.cors.allowedOrigins.includes(origin) || origin.endsWith('.vercel.app')) {
      callback(null, true);
    } else {
      callback(new Error(`Origin ${origin} not allowed by CORS policy`));
    }
  },
  credentials: true, // Allow cookies and Authorization headers
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset'],
  maxAge: 600, // Cache preflight requests for 10 minutes
};

// Apply CORS middleware
app.use(cors(corsOptions));

// Apply security headers
app.use(securityHeaders);

// Body parsing middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Ensure upload directory exists
const uploadsDir = path.join(__dirname, '..', config.upload.dir);
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
const storeImagesDir = path.join(uploadsDir, 'store-images');
if (!fs.existsSync(storeImagesDir)) {
  fs.mkdirSync(storeImagesDir, { recursive: true });
}

// Health check routes (no rate limiting)
app.use('/health', healthRoutes);

// Apply rate limiters to specific routes
// Note: More specific routes must come BEFORE general routes
app.use('/api/auth/login', authLimiter); // Strict: 5 attempts per 15 min
app.use('/api/locations', publicLimiter); // Lenient: 300 requests per 15 min
app.use('/api/analytics/events', analyticsLimiter); // 200 per 15 min (mobile app)

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/scraper', scraperRoutes);
app.use('/api/locations', locationRoutes);
app.use('/api/premium-stores', premiumRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/admin', adminRoutes);

//API endpoints for stores

app.get('/api/stores', async (req: Request, res: Response) => {
  try {
    const stores = await storeService.getMasterRecords();
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    res.json(stores);
  } catch (err) {
    logger.error('Failed to fetch stores:', err);
    res.status(500).json({ error: 'Failed to fetch stores' });
  }
});

// Dynamic CSV Route

app.get('/backend/uploads/master_stores.csv', async (req: Request, res: Response) => {
  try {
    const csv = await storeService.generateDownloadCSV();

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="master_stores.csv"');
    res.setHeader('Cache-Control', 'public, max-age=300');

    res.send(csv);
  } catch (err) {
    logger.error('CSV generation failed:', err);
    res.status(500).send('Failed to generate CSV');
  }
});


// Serve user-frontend static files
const userFrontendDir = path.join(__dirname, '..', '..', 'user-frontend');

// Serve prototype.html as the default page (index.html is an outdated copy)
app.get('/', (req: Request, res: Response) => {
  res.sendFile(path.join(userFrontendDir, 'index.html'));
});

app.use(express.static(userFrontendDir));

// 404 handler for API routes only
app.use('/api/*', (req: Request, res: Response) => {
  res.status(404).json({ error: 'API route not found' });
});

// Error handler
app.use((err: any, req: Request, res: Response, next: any) => {
  logger.error('Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    ...(config.isDevelopment && { stack: err.stack })
  });
});

// Start server
app.listen(PORT, () => {
  logger.warn(`🚀 Server running on port ${PORT} | env=${config.nodeEnv} | origins=${config.cors.allowedOrigins.join(', ')}`);
});

export default app;
