import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import api from '../services/api';
import '../styles/Dashboard.css';

interface Stats {
  totalUploads: number;
  validUploads: number;
  invalidUploads: number;
  totalLocations: number;
}

interface Upload {
  id: string;
  filename: string;
  originalFilename: string;
  fileSize: number;
  uploadedBy: string;
  uploadedAt: string;
  status: string;
  validationErrors: any[];
  validationWarnings: any[];
  rowsTotal: number;
  rowsProcessed: number;
  rowsFailed: number;
  brandConfig: string | null;
  scraperType: string | null;
  _count?: {
    validationLogs: number;
    locations: number;
  };
}

const Dashboard: React.FC = () => {
  const [stats, setStats] = useState<Stats | null>(null);
  const [recentUploads, setRecentUploads] = useState<Upload[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadDashboard();
  }, []);

  const loadDashboard = async () => {
    try {
      const [statsRes, uploadsRes] = await Promise.all([
        api.get<Stats>('/uploads/stats'),
        api.get('/uploads?limit=5'),
      ]);

      setStats(statsRes.data);
      setRecentUploads(uploadsRes.data.uploads);
    } catch (error) {
      console.error('Failed to load dashboard:', error);
    } finally {
      setLoading(false);
    }
  };

  const getStatusBadge = (status: string) => {
    const badges: Record<string, string> = {
      valid: 'badge-success',
      invalid: 'badge-error',
      pending: 'badge-warning',
      validating: 'badge-info',
      completed: 'badge-success',
      failed: 'badge-error',
      processing: 'badge-info',
    };
    return badges[status] || 'badge-default';
  };

  if (loading) {
    return <div className="loading">Loading dashboard...</div>;
  }

  return (
    <div className="dashboard">
      <h1>Dashboard</h1>

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-value">{stats?.totalUploads || 0}</div>
          <div className="stat-label">Total Uploads</div>
        </div>

        <div className="stat-card">
          <div className="stat-value">{stats?.validUploads || 0}</div>
          <div className="stat-label">Valid Uploads</div>
        </div>

        <div className="stat-card">
          <div className="stat-value">{stats?.invalidUploads || 0}</div>
          <div className="stat-label">Invalid Uploads</div>
        </div>

        <div className="stat-card">
          <div className="stat-value">{stats?.totalLocations || 0}</div>
          <div className="stat-label">Total Locations</div>
        </div>
      </div>

      <div className="recent-section">
        <div className="section-header">
          <h2>Recent Uploads</h2>
          <Link to="/uploads" className="view-all">View All</Link>
        </div>

        {recentUploads.length === 0 ? (
          <div className="empty-state">
            <p>No uploads yet</p>
            <Link to="/uploads" className="button">Upload CSV</Link>
          </div>
        ) : (
          <table className="uploads-table">
            <thead>
              <tr>
                <th>Filename</th>
                <th>Status</th>
                <th>Rows</th>
                <th>Date</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {recentUploads.map((upload) => (
                <tr key={upload.id}>
                  <td>{upload.originalFilename}</td>
                  <td>
                    <span className={`badge ${getStatusBadge(upload.status)}`}>
                      {upload.status}
                    </span>
                  </td>
                  <td>{upload.rowsTotal}</td>
                  <td>{new Date(upload.uploadedAt).toLocaleString()}</td>
                  <td>
                    <Link to={`/uploads/${upload.id}`} className="link">View</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

export default Dashboard;
