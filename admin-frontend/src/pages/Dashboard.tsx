import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Upload, CheckCircle2, XCircle, MapPin } from 'lucide-react';
import api from '../services/api';
import { useAuth } from '../contexts/AuthContext';
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
  const { user } = useAuth();
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

  // One entry per stat card: icon + accent color + value + label.
  // Add/remove a card by editing this array — the JSX below just maps over it.
  const statCards = [
    {
      icon: Upload,
      accent: 'teal',
      value: stats?.totalUploads || 0,
      label: 'Total Uploads',
    },
    {
      icon: CheckCircle2,
      accent: 'green',
      value: stats?.validUploads || 0,
      label: 'Valid Uploads',
    },
    {
      icon: XCircle,
      accent: 'red',
      value: stats?.invalidUploads || 0,
      label: 'Invalid Uploads',
    },
    {
      icon: MapPin,
      accent: 'purple',
      value: stats?.totalLocations || 0,
      label: 'Total Locations',
    },
  ];

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <h1>Welcome back, {user?.username || 'Admin'}</h1>
        <p className="dashboard-subtitle">Overview of store locations and uploads.</p>
      </div>

      <div className="stats-grid">
        {statCards.map(({ icon: Icon, accent, value, label }) => (
          <div className="stat-card" key={label}>
            <div className={`stat-icon stat-icon-${accent}`}>
              <Icon size={20} strokeWidth={2} />
            </div>
            <div className="stat-value">{value}</div>
            <div className="stat-label">{label}</div>
          </div>
        ))}
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