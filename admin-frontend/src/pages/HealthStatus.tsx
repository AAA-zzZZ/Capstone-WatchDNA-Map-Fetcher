import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import '../styles/HealthStatus.css';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

interface ServiceCheck {
  name: string;
  status: 'healthy' | 'unhealthy' | 'degraded';
  responseTime: number;
  message?: string;
  details?: Record<string, any>;
}

interface HealthReport {
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

const HealthStatus: React.FC = () => {
  const [report, setReport] = useState<HealthReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const loadHealth = useCallback(async () => {
    try {
      setError(null);
      const token = localStorage.getItem('token');
      const res = await axios.get<HealthReport>(`${API_URL}/health/details`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setReport(res.data);
      setLastRefresh(new Date());
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to load health status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadHealth();
    const interval = setInterval(loadHealth, 30000);
    return () => clearInterval(interval);
  }, [loadHealth]);

  const formatUptime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h}h ${m}m ${s}s`;
  };

  const statusIcon = (status: string) => {
    if (status === 'healthy') return '\u2713';
    if (status === 'degraded') return '\u26A0';
    return '\u2717';
  };

  const statusClass = (status: string) => {
    if (status === 'healthy') return 'status-healthy';
    if (status === 'degraded') return 'status-degraded';
    return 'status-unhealthy';
  };

  if (loading) {
    return <div className="loading">Loading health status...</div>;
  }

  if (error && !report) {
    return (
      <div className="health-status">
        <h1>System Health</h1>
        <div className="health-error">
          <p>{error}</p>
          <button onClick={loadHealth} className="button button-primary">Retry</button>
        </div>
      </div>
    );
  }

  if (!report) return null;

  return (
    <div className="health-status">
      <div className="page-header">
        <h1>System Health</h1>
        <div className="header-actions">
          {lastRefresh && (
            <span className="last-refresh">
              Updated {lastRefresh.toLocaleTimeString()}
            </span>
          )}
          <button onClick={loadHealth} className="button button-primary">
            Refresh
          </button>
        </div>
      </div>

      <div className={`overall-banner ${statusClass(report.status)}`}>
        <span className="overall-icon">{statusIcon(report.status)}</span>
        <span className="overall-label">
          {report.status === 'healthy' ? 'All Systems Operational' :
           report.status === 'degraded' ? 'Some Systems Degraded' :
           'System Issues Detected'}
        </span>
      </div>

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-value">{report.summary.healthy}</div>
          <div className="stat-label">Healthy</div>
        </div>
        <div className="stat-card">
          <div className="stat-value stat-degraded">{report.summary.degraded}</div>
          <div className="stat-label">Degraded</div>
        </div>
        <div className="stat-card">
          <div className="stat-value stat-unhealthy">{report.summary.unhealthy}</div>
          <div className="stat-label">Unhealthy</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{formatUptime(report.uptime)}</div>
          <div className="stat-label">Uptime</div>
        </div>
      </div>

      <div className="meta-bar">
        <span>Environment: <strong>{report.environment}</strong></span>
        <span>Version: <strong>v{report.version}</strong></span>
        <span>Auto-refresh: <strong>30s</strong></span>
      </div>

      <div className="services-section">
        <h2>Services ({report.summary.total})</h2>
        <div className="services-grid">
          {report.services.map((service) => (
            <div key={service.name} className={`service-card ${statusClass(service.status)}`}>
              <div className="service-header">
                <span className={`service-icon ${statusClass(service.status)}`}>
                  {statusIcon(service.status)}
                </span>
                <span className="service-name">{service.name}</span>
                <span className="response-time">{service.responseTime}ms</span>
              </div>
              <div className={`service-status-label ${statusClass(service.status)}`}>
                {service.status.toUpperCase()}
              </div>
              {service.message && (
                <div className="service-message">{service.message}</div>
              )}
              {service.details && (
                <div className="service-details">
                  {Object.entries(service.details).map(([key, value]) => (
                    <span key={key} className="detail-tag">
                      <strong>{key}:</strong> {String(value)}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default HealthStatus;
