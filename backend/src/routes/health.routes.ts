import { Router, Request, Response } from 'express';
import { getHealthReport } from '../services/health.service';
import { authenticate, optionalAuth } from '../middleware/auth.middleware';

const router = Router();

// GET /health — simple ping (used by Railway/uptime monitors)
router.get('/', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'WatchDNA Admin Backend',
  });
});

// GET /health/details — full service health report (admin only)
router.get('/details', authenticate, async (req: Request, res: Response) => {
  try {
    const report = await getHealthReport();
    const statusCode = report.status === 'healthy' ? 200 : report.status === 'degraded' ? 200 : 503;
    res.status(statusCode).json(report);
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// GET /health/dashboard — visual status page (admin only)
router.get('/dashboard', authenticate, async (req: Request, res: Response) => {
  try {
    const report = await getHealthReport();
    res.send(buildDashboardHTML(report));
  } catch (error: any) {
    res.status(500).send(`<h1>Health Dashboard Error</h1><p>${error.message}</p>`);
  }
});

function buildDashboardHTML(report: any): string {
  const statusColor = report.status === 'healthy' ? '#22c55e' : report.status === 'degraded' ? '#f59e0b' : '#ef4444';
  const statusIcon = report.status === 'healthy' ? '&#10003;' : report.status === 'degraded' ? '&#9888;' : '&#10007;';

  const serviceRows = report.services.map((s: any) => {
    const color = s.status === 'healthy' ? '#22c55e' : s.status === 'degraded' ? '#f59e0b' : '#ef4444';
    const icon = s.status === 'healthy' ? '&#10003;' : s.status === 'degraded' ? '&#9888;' : '&#10007;';
    const detailsHtml = s.details
      ? `<div class="details">${Object.entries(s.details).map(([k, v]) => `<span class="detail-item"><strong>${k}:</strong> ${v}</span>`).join('')}</div>`
      : '';

    return `
      <div class="service-card">
        <div class="service-header">
          <span class="status-icon" style="color:${color}">${icon}</span>
          <span class="service-name">${s.name}</span>
          <span class="response-time">${s.responseTime}ms</span>
        </div>
        <div class="service-status" style="color:${color}">${s.status.toUpperCase()}</div>
        <div class="service-message">${s.message || ''}</div>
        ${detailsHtml}
      </div>
    `;
  }).join('');

  const upHours = Math.floor(report.uptime / 3600);
  const upMins = Math.floor((report.uptime % 3600) / 60);
  const upSecs = report.uptime % 60;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>WatchDNA System Status</title>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant:wght@400;600;700&family=Inter:wght@400;500;600&display=swap">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', -apple-system, sans-serif;
      background: #0a0a0a;
      color: #e5e5e5;
      min-height: 100vh;
    }
    .container { max-width: 900px; margin: 0 auto; padding: 40px 20px; }
    .header {
      text-align: center;
      margin-bottom: 40px;
    }
    .header h1 {
      font-family: 'Cormorant', serif;
      font-size: 2rem;
      font-weight: 700;
      letter-spacing: 2px;
      color: #c9a84c;
      margin-bottom: 8px;
    }
    .header .subtitle { color: #888; font-size: 0.85rem; }
    .overall-status {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding: 20px;
      border-radius: 12px;
      background: #141414;
      border: 1px solid #222;
      margin-bottom: 30px;
    }
    .overall-status .big-icon { font-size: 2rem; }
    .overall-status .label {
      font-size: 1.4rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .meta-row {
      display: flex;
      justify-content: center;
      gap: 30px;
      margin-bottom: 30px;
      flex-wrap: wrap;
    }
    .meta-item {
      text-align: center;
      background: #141414;
      border: 1px solid #222;
      border-radius: 8px;
      padding: 14px 24px;
      min-width: 150px;
    }
    .meta-item .value { font-size: 1.3rem; font-weight: 600; color: #c9a84c; }
    .meta-item .key { font-size: 0.75rem; color: #888; text-transform: uppercase; letter-spacing: 1px; margin-top: 4px; }
    .services-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(400px, 1fr));
      gap: 16px;
    }
    .service-card {
      background: #141414;
      border: 1px solid #222;
      border-radius: 10px;
      padding: 20px;
      transition: border-color 0.2s;
    }
    .service-card:hover { border-color: #333; }
    .service-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 8px;
    }
    .status-icon { font-size: 1.2rem; font-weight: bold; }
    .service-name { font-weight: 600; font-size: 1rem; flex: 1; }
    .response-time {
      font-size: 0.75rem;
      color: #888;
      background: #1a1a1a;
      padding: 3px 8px;
      border-radius: 4px;
    }
    .service-status {
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 1px;
      margin-bottom: 6px;
    }
    .service-message { font-size: 0.85rem; color: #aaa; margin-bottom: 8px; }
    .details {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 8px;
    }
    .detail-item {
      font-size: 0.75rem;
      background: #1a1a1a;
      padding: 3px 10px;
      border-radius: 4px;
      color: #999;
    }
    .detail-item strong { color: #bbb; }
    .footer {
      text-align: center;
      margin-top: 40px;
      color: #555;
      font-size: 0.75rem;
    }
    .summary-bar {
      display: flex;
      justify-content: center;
      gap: 20px;
      margin-bottom: 24px;
    }
    .summary-badge {
      display: flex; align-items: center; gap: 6px;
      font-size: 0.85rem; font-weight: 500;
    }
    .dot {
      width: 10px; height: 10px; border-radius: 50%; display: inline-block;
    }
    .refresh-btn {
      display: inline-block;
      margin-top: 20px;
      padding: 8px 20px;
      background: #1a1a1a;
      color: #c9a84c;
      border: 1px solid #333;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.85rem;
      text-decoration: none;
    }
    .refresh-btn:hover { background: #222; }
    @media (max-width: 480px) {
      .services-grid { grid-template-columns: 1fr; }
      .meta-row { gap: 12px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>WATCHDNA SYSTEM STATUS</h1>
      <div class="subtitle">Real-time service health monitoring</div>
    </div>

    <div class="overall-status">
      <span class="big-icon" style="color:${statusColor}">${statusIcon}</span>
      <span class="label" style="color:${statusColor}">All Systems ${report.status === 'healthy' ? 'Operational' : report.status === 'degraded' ? 'Degraded' : 'Down'}</span>
    </div>

    <div class="summary-bar">
      <span class="summary-badge"><span class="dot" style="background:#22c55e"></span> ${report.summary.healthy} Healthy</span>
      <span class="summary-badge"><span class="dot" style="background:#f59e0b"></span> ${report.summary.degraded} Degraded</span>
      <span class="summary-badge"><span class="dot" style="background:#ef4444"></span> ${report.summary.unhealthy} Unhealthy</span>
    </div>

    <div class="meta-row">
      <div class="meta-item">
        <div class="value">${upHours}h ${upMins}m ${upSecs}s</div>
        <div class="key">Uptime</div>
      </div>
      <div class="meta-item">
        <div class="value">${report.environment}</div>
        <div class="key">Environment</div>
      </div>
      <div class="meta-item">
        <div class="value">v${report.version}</div>
        <div class="key">Version</div>
      </div>
    </div>

    <div class="services-grid">
      ${serviceRows}
    </div>

    <div class="footer">
      Last checked: ${report.timestamp}<br>
      <a class="refresh-btn" href="" onclick="location.reload(); return false;">Refresh Status</a>
    </div>
  </div>
</body>
</html>`;
}

export default router;
