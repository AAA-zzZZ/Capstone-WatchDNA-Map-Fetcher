import React, { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import api from '../services/api';
import { scraperService, type MasterCsvExportFilters } from '../services/scraper.service';
import '../styles/Uploads.css';

function escapeCsvValue(val: string): string {
  const s = String(val ?? '');
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function recordsToCsv(columns: string[], records: Record<string, string>[]): string {
  const header = columns.map(escapeCsvValue).join(',');
  const rows = records.map((r) =>
    columns.map((col) => escapeCsvValue(r[col] ?? '')).join(',')
  );
  return [header, ...rows].join('\r\n');
}

function slugForFilename(s: string): string {
  const t = s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return t || 'unknown';
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

const Uploads: React.FC = () => {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dbBrands, setDbBrands] = useState<string[]>([]);
  const [csvBrandFilter, setCsvBrandFilter] = useState('');
  const [csvCountryFilter, setCsvCountryFilter] = useState('');
  const [csvPremiumOnly, setCsvPremiumOnly] = useState(false);
  const [csvCountryOptions, setCsvCountryOptions] = useState<string[]>([]);
  const [loadingCsvCountries, setLoadingCsvCountries] = useState(false);

  useEffect(() => {
    loadUploads();
    scraperService.getDbBrands()
      .then((b) => setDbBrands(b))
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingCsvCountries(true);
      try {
        const scope =
          csvBrandFilter || csvPremiumOnly
            ? {
                ...(csvBrandFilter ? { brand: csvBrandFilter } : {}),
                ...(csvPremiumOnly ? { premiumOnly: true as const } : {}),
              }
            : undefined;
        const countries = await scraperService.getMasterCsvCountries(scope);
        if (cancelled) return;
        setCsvCountryOptions(countries);
        setCsvCountryFilter((prev) => (prev && countries.includes(prev) ? prev : ''));
      } catch {
        if (!cancelled) {
          setCsvCountryOptions([]);
          setCsvCountryFilter('');
        }
      } finally {
        if (!cancelled) setLoadingCsvCountries(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [csvBrandFilter, csvPremiumOnly]);

  const loadUploads = async () => {
    try {
      const response = await api.get('/uploads');
      setUploads(response.data.uploads);
    } catch (error) {
      console.error('Failed to load uploads:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.name.endsWith('.csv')) {
      alert('Please select a CSV file');
      return;
    }

    setUploading(true);

    try {
      const formData = new FormData();
      formData.append('file', file);

      await api.post('/uploads', formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });

      // Reload uploads
      await loadUploads();

      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }

      alert('File uploaded successfully! Validation in progress...');
    } catch (error: any) {
      alert(error.response?.data?.error || 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this upload?')) {
      return;
    }

    try {
      await api.delete(`/uploads/${id}`);
      setUploads(uploads.filter((u) => u.id !== id));
    } catch (error: any) {
      alert(error.response?.data?.error || 'Delete failed');
    }
  };

  const handleDownload = async (id: string, filename: string) => {
    try {
      const response = await api.get(`/uploads/${id}/download`, {
        responseType: 'blob',
      });

      // Create a blob URL and trigger download
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', filename);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (error: any) {
      alert(error.response?.data?.error || 'Download failed');
    }
  };

  const csvFilters = (): MasterCsvExportFilters | undefined => {
    const country = csvCountryFilter.trim();
    if (!csvBrandFilter && !country && !csvPremiumOnly) return undefined;
    return {
      ...(csvBrandFilter ? { brand: csvBrandFilter } : {}),
      ...(country ? { country } : {}),
      ...(csvPremiumOnly ? { premiumOnly: true } : {}),
    };
  };

  const handleDownloadStoresCsv = async () => {
    try {
      const data = await scraperService.getMasterCsvRecords(csvFilters());
      const csv = recordsToCsv(data.columns, data.records);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const brandSlug = csvBrandFilter ? slugForFilename(csvBrandFilter.replace(/_/g, '-')) : 'all';
      const countrySlug = csvCountryFilter.trim() ? slugForFilename(csvCountryFilter) : 'all';
      const prem = csvPremiumOnly ? '-premium' : '';
      link.download = `stores-${brandSlug}-${countrySlug}${prem}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error: any) {
      alert(error.response?.data?.error || 'Failed to download stores CSV');
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
    return <div className="loading">Loading uploads...</div>;
  }

  return (
    <div className="uploads-page">
      <div className="page-header">
        <h1>CSV Uploads</h1>
        <div style={{ display: 'flex', gap: '10px' }}>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            onChange={handleFileSelect}
            style={{ display: 'none' }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="button button-primary"
            disabled={uploading}
          >
            {uploading ? 'Uploading...' : 'Upload CSV'}
          </button>
        </div>
      </div>

      <div className="content-section">
        <div className="section-header">
          <h2>Export Master Store Data</h2>
          <div className="filter-controls filter-controls-wrap">
            <select
              value={csvBrandFilter}
              onChange={(e) => {
                setCsvBrandFilter(e.target.value);
                setCsvCountryFilter('');
              }}
              className="filter-select"
            >
              <option value="">All brands</option>
              {dbBrands.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
            <select
              className="filter-select"
              value={csvCountryFilter}
              onChange={(e) => setCsvCountryFilter(e.target.value)}
              disabled={loadingCsvCountries}
              aria-label="Filter by country"
              title={
                csvBrandFilter
                  ? 'Countries with at least one store matching the selected brand'
                  : 'All countries in the database'
              }
            >
              <option value="">
                {loadingCsvCountries ? 'Loading countries…' : 'All countries'}
              </option>
              {csvCountryOptions.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <label className="filter-checkbox">
              <input
                type="checkbox"
                checked={csvPremiumOnly}
                onChange={(e) => setCsvPremiumOnly(e.target.checked)}
              />
              Premium only
            </label>
            <button
              className="btn btn-secondary"
              onClick={handleDownloadStoresCsv}
              title={
                [
                  csvBrandFilter && `Brand: ${csvBrandFilter}`,
                  csvCountryFilter.trim() && `Country: ${csvCountryFilter.trim()}`,
                  csvPremiumOnly && 'Premium only',
                ]
                  .filter(Boolean)
                  .join(' · ') || 'Download all stores (set filters to narrow)'
              }
            >
              Download CSV
            </button>
          </div>
        </div>
      </div>

      {uploads.length === 0 ? (
        <div className="empty-state">
          <p>No uploads yet</p>
          <p>Click "Upload CSV" to get started</p>
        </div>
      ) : (
        <table className="uploads-table">
          <thead>
            <tr>
              <th>Filename</th>
              <th>Status</th>
              <th>Rows</th>
              <th>Errors</th>
              <th>Warnings</th>
              <th>Uploaded</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {uploads.map((upload) => (
              <tr key={upload.id}>
                <td>{upload.originalFilename}</td>
                <td>
                  <span className={`badge ${getStatusBadge(upload.status)}`}>
                    {upload.status}
                  </span>
                </td>
                <td>{upload.rowsTotal}</td>
                <td>
                  {upload.validationErrors?.length > 0 && (
                    <span className="error-count">{upload.validationErrors.length}</span>
                  )}
                </td>
                <td>
                  {upload.validationWarnings?.length > 0 && (
                    <span className="warning-count">{upload.validationWarnings.length}</span>
                  )}
                </td>
                <td>{new Date(upload.uploadedAt).toLocaleString()}</td>
                <td className="actions">
                  <Link to={`/uploads/${upload.id}`} className="link">View</Link>
                  <button 
                    onClick={() => handleDownload(upload.id, upload.originalFilename)} 
                    className="link link-primary"
                    style={{ marginLeft: '8px' }}
                  >
                    Download
                  </button>
                  <button onClick={() => handleDelete(upload.id)} className="link link-danger" style={{ marginLeft: '8px' }}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

export default Uploads;
