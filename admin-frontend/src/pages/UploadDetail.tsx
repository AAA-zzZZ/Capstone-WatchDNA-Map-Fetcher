import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import api from '../services/api';
import '../styles/UploadDetail.css';

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

interface ValidationLog {
  id: string;
  uploadId: string;
  rowNumber: number | null;
  logType: string;
  fieldName: string | null;
  issueType: string;
  message: string;
  value: string | null;
  createdAt: string;
}

const UploadDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const [upload, setUpload] = useState<Upload | null>(null);
  const [logs, setLogs] = useState<ValidationLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [logFilter, setLogFilter] = useState<'all' | 'error' | 'warning'>('all');

  useEffect(() => {
    loadUpload();
  }, [id]);

  const loadUpload = async () => {
    try {
      const [uploadRes, logsRes] = await Promise.all([
        api.get(`/uploads/${id}`),
        api.get(`/uploads/${id}/logs`),
      ]);

      setUpload(uploadRes.data);
      setLogs(logsRes.data.logs);
    } catch (error) {
      console.error('Failed to load upload:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return <div className="loading">Loading...</div>;
  }

  if (!upload) {
    return <div className="error">Upload not found</div>;
  }

  const filteredLogs = logs.filter((log) => {
    if (logFilter === 'all') return true;
    return log.logType === logFilter;
  });

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

  return (
    <div className="upload-detail">
      <div className="page-header">
        <div>
          <Link to="/uploads" className="back-link">← Back to Uploads</Link>
          <h1>{upload.originalFilename}</h1>
        </div>
      </div>

      <div className="detail-grid">
        <div className="detail-card">
          <h3>Upload Information</h3>
          <dl>
            <dt>Status</dt>
            <dd>
              <span className={`badge ${getStatusBadge(upload.status)}`}>
                {upload.status}
              </span>
            </dd>

            <dt>File Size</dt>
            <dd>{(upload.fileSize / 1024).toFixed(2)} KB</dd>

            <dt>Uploaded By</dt>
            <dd>{upload.uploadedBy}</dd>

            <dt>Uploaded At</dt>
            <dd>{new Date(upload.uploadedAt).toLocaleString()}</dd>

            <dt>Total Rows</dt>
            <dd>{upload.rowsTotal}</dd>
          </dl>
        </div>

        <div className="detail-card">
          <h3>Validation Summary</h3>
          <dl>
            <dt>Errors</dt>
            <dd className={upload.validationErrors.length > 0 ? 'error-text' : ''}>
              {upload.validationErrors.length}
            </dd>

            <dt>Warnings</dt>
            <dd className={upload.validationWarnings.length > 0 ? 'warning-text' : ''}>
              {upload.validationWarnings.length}
            </dd>

            <dt>Validation Logs</dt>
            <dd>{logs.length}</dd>
          </dl>
        </div>
      </div>

      {logs.length > 0 && (
        <div className="logs-section">
          <div className="section-header">
            <h2>Validation Logs</h2>
            <div className="filter-buttons">
              <button
                className={logFilter === 'all' ? 'active' : ''}
                onClick={() => setLogFilter('all')}
              >
                All ({logs.length})
              </button>
              <button
                className={logFilter === 'error' ? 'active' : ''}
                onClick={() => setLogFilter('error')}
              >
                Errors ({logs.filter((l) => l.logType === 'error').length})
              </button>
              <button
                className={logFilter === 'warning' ? 'active' : ''}
                onClick={() => setLogFilter('warning')}
              >
                Warnings ({logs.filter((l) => l.logType === 'warning').length})
              </button>
            </div>
          </div>

          <table className="logs-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Row</th>
                <th>Field</th>
                <th>Issue</th>
                <th>Message</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {filteredLogs.map((log) => (
                <tr key={log.id} className={log.logType}>
                  <td>
                    <span className={`badge ${log.logType === 'error' ? 'badge-error' : 'badge-warning'}`}>
                      {log.logType}
                    </span>
                  </td>
                  <td>{log.rowNumber || '-'}</td>
                  <td>{log.fieldName || '-'}</td>
                  <td>{log.issueType}</td>
                  <td>{log.message}</td>
                  <td className="value-cell">{log.value || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {logs.length === 0 && upload.status === 'valid' && (
        <div className="success-message">
          ✅ No validation issues found! This CSV is ready to use.
        </div>
      )}
    </div>
  );
};

export default UploadDetail;
