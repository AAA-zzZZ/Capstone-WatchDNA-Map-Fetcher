import { useEffect, useMemo, useState } from 'react';
import { scraperService, type ProbedEndpoint, type ProbeEndpointResponse } from '../services/scraper.service';

type ManualEndpointEntryProps = {
  onConfigSaved?: () => void;
};

function toSnakeCaseId(input: string): string {
  return input
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function suggestBrandIdFromDisplayName(displayName: string): string {
  const base = toSnakeCaseId(displayName);
  if (!base) return '';
  return base.endsWith('_stores') ? base : `${base}_stores`;
}

function buildSuggestedConfig(
  endpoint: ProbedEndpoint,
  brandId: string,
  brandDisplayName: string
): Record<string, any> {
  return {
    type: endpoint.type || 'json',
    url: endpoint.url,
    method: endpoint.method || 'GET',
    description: `Manual endpoint probe for ${brandDisplayName || brandId}`,
    data_path: endpoint.data_path || undefined,
    field_mapping: endpoint.field_mapping || {},
    display_name: brandDisplayName.trim() || undefined,
  };
}

const ManualEndpointEntry: React.FC<ManualEndpointEntryProps> = ({ onConfigSaved }) => {
  const [endpointUrl, setEndpointUrl] = useState('');
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<ProbeEndpointResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [showComparisonModal, setShowComparisonModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [brandId, setBrandId] = useState('');
  const [brandIdTouched, setBrandIdTouched] = useState(false);
  const [brandDisplayName, setBrandDisplayName] = useState('');
  const [acknowledgeNoStores, setAcknowledgeNoStores] = useState(false);
  const [existingConfig, setExistingConfig] = useState<any>(null);
  const [suggestedConfig, setSuggestedConfig] = useState<any>(null);

  const endpoint = probeResult?.endpoint ?? null;
  const detectedStoreCount = useMemo(() => {
    if (!endpoint) return 0;
    if (typeof endpoint.verified_store_count === 'number') {
      return endpoint.verified_store_count;
    }
    return typeof endpoint.store_count === 'number' ? endpoint.store_count : 0;
  }, [endpoint]);
  const noStoresDetected = endpoint != null && detectedStoreCount === 0;

  useEffect(() => {
    if (!brandIdTouched) {
      setBrandId(suggestBrandIdFromDisplayName(brandDisplayName));
    }
  }, [brandDisplayName, brandIdTouched]);

  const clearProbeState = () => {
    setProbeResult(null);
    setError(null);
    setShowSaveModal(false);
    setShowComparisonModal(false);
    setExistingConfig(null);
    setSuggestedConfig(null);
    setAcknowledgeNoStores(false);
  };

  const handleProbe = async () => {
    if (!endpointUrl.trim()) {
      setError('Please enter an endpoint URL');
      return;
    }

    setProbing(true);
    setError(null);
    setProbeResult(null);
    setShowSaveModal(false);
    setAcknowledgeNoStores(false);

    try {
      const result = await scraperService.probeEndpoint(endpointUrl.trim());
      setProbeResult(result);
      if (!result.success) {
        setError(result.errors?.join(', ') || 'Endpoint probe failed');
      }
    } catch (err: any) {
      const message = err.response?.data?.error || err.response?.data?.details || err.message;
      setError(message || 'Failed to probe endpoint');
    } finally {
      setProbing(false);
    }
  };

  const handleSave = async (overwrite = false) => {
    if (!endpoint || !brandId.trim() || !brandDisplayName.trim()) {
      setError('Please probe an endpoint and enter both Brand Display Name and Brand Config ID');
      return;
    }
    if (noStoresDetected && !acknowledgeNoStores) {
      setError('No store locations detected at this endpoint. Check the acknowledgement box to save anyway.');
      return;
    }

    setSaving(true);
    setError(null);
    const saveSuggestedConfig = buildSuggestedConfig(endpoint, brandId, brandDisplayName);

    try {
      await scraperService.saveBrandConfig({
        brandId,
        brandName: brandDisplayName.trim(),
        endpoint,
        suggestedConfig: saveSuggestedConfig,
        overwrite,
      });

      const savedName = brandDisplayName.trim() || brandId;
      clearProbeState();
      setEndpointUrl('');
      setBrandId('');
      setBrandIdTouched(false);
      setBrandDisplayName('');
      onConfigSaved?.();
      alert(`Brand configuration "${savedName}" saved successfully.`);
    } catch (err: any) {
      if (!overwrite && err.response?.status === 409 && err.response?.data?.existingConfig) {
        setExistingConfig(err.response.data.existingConfig);
        setSuggestedConfig(saveSuggestedConfig);
        setShowSaveModal(false);
        setShowComparisonModal(true);
      } else {
        const message = err.response?.data?.error || err.message || 'Failed to save brand config';
        setError(message);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="manual-entry-section">
      <div className="discovery-form">
        <div className="form-group">
          <label htmlFor="manual-endpoint-url">Endpoint URL *</label>
          <input
            id="manual-endpoint-url"
            type="text"
            className="form-control"
            value={endpointUrl}
            onChange={(e) => setEndpointUrl(e.target.value)}
            placeholder="https://api.example.com/stores"
            disabled={probing}
          />
          <small className="form-hint">
            Enter the direct API endpoint URL. We will probe it to detect type, structure, and how many store locations it returns.
          </small>
        </div>
        <button
          className="btn btn-primary"
          onClick={handleProbe}
          disabled={probing || !endpointUrl.trim()}
        >
          {probing ? 'Detecting...' : 'Detect Type'}
        </button>
      </div>

      {error && <div className="error-message">{error}</div>}

      {endpoint && (
        <div className="discovery-results">
          <div className="results-header">
            <h3>Endpoint Probe Result</h3>
            {probeResult?.success && <span className="success-badge">✓ Success</span>}
          </div>

          {detectedStoreCount > 0 ? (
            <div className="store-detection-badge store-detection-badge--found">
              ✓ Detected <strong>{detectedStoreCount}</strong> store location{detectedStoreCount === 1 ? '' : 's'} at this endpoint
            </div>
          ) : (
            <div className="store-detection-badge store-detection-badge--missing">
              ⚠ No store locations detected at this endpoint. The scraper may not return any rows.
            </div>
          )}

          <div className="endpoint-card selected">
            <div className="endpoint-header">
              <div className="endpoint-rank">#1</div>
              <div className="endpoint-info">
                <div className="endpoint-url">{endpoint.url}</div>
                <div className="endpoint-meta">
                  <span className="endpoint-type">{endpoint.type || 'unknown'}</span>
                  <span className="endpoint-confidence">
                    Confidence: {Math.round((endpoint.confidence || 0) * 100)}%
                  </span>
                  <span className="endpoint-confidence">
                    Method: {endpoint.method || 'GET'}
                  </span>
                </div>
              </div>
            </div>
            {endpoint.data_path && (
              <div className="endpoint-detail">
                <strong>Data Path:</strong> {endpoint.data_path}
              </div>
            )}
          </div>

          <div className="selected-endpoint-actions">
            <button className="btn btn-primary" onClick={() => setShowSaveModal(true)}>
              Save as Brand Config
            </button>
          </div>
        </div>
      )}

      {showSaveModal && endpoint && (
        <div className="modal-overlay" onClick={() => setShowSaveModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Save Manual Endpoint Config</h2>
              <button className="modal-close" onClick={() => setShowSaveModal(false)}>
                ×
              </button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label htmlFor="manual-brand-display-name">Brand Display Name *</label>
                <input
                  id="manual-brand-display-name"
                  type="text"
                  value={brandDisplayName}
                  onChange={(e) => setBrandDisplayName(e.target.value)}
                  placeholder="e.g., TUDOR"
                  className="form-control"
                />
                <small className="form-hint">
                  This is the human-readable brand name shown in scraping runs and filter dropdowns throughout the app.
                </small>
              </div>
              <div className="form-group">
                <label htmlFor="manual-brand-id">Brand Config ID *</label>
                <input
                  id="manual-brand-id"
                  type="text"
                  value={brandId}
                  onChange={(e) => {
                    setBrandIdTouched(true);
                    setBrandId(toSnakeCaseId(e.target.value));
                  }}
                  placeholder="e.g., tudor_stores"
                  className="form-control"
                />
                <small className="form-hint">
                  Internal identifier (snake_case). Auto-derived from the display name; override if needed.
                </small>
              </div>

              <div className="info-box">
                <strong>Endpoint:</strong> {endpoint.url}
                <br />
                <strong>Type:</strong> {endpoint.type}
                <br />
                <strong>Detected store locations:</strong>{' '}
                {detectedStoreCount > 0
                  ? `${detectedStoreCount} (will populate the "${brandDisplayName.trim() || 'BRAND'}" filter)`
                  : '0 — endpoint may not return any rows'}
                <br />
                {endpoint.data_path && (
                  <>
                    <strong>Data Path:</strong> {endpoint.data_path}
                    <br />
                  </>
                )}
              </div>

              {noStoresDetected && (
                <label className="form-checkbox-row">
                  <input
                    type="checkbox"
                    checked={acknowledgeNoStores}
                    onChange={(e) => setAcknowledgeNoStores(e.target.checked)}
                  />
                  <span>
                    I understand the probe found no store locations and want to save this brand anyway.
                  </span>
                </label>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowSaveModal(false)} disabled={saving}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={() => handleSave(false)}
                disabled={
                  saving ||
                  !brandId.trim() ||
                  !brandDisplayName.trim() ||
                  (noStoresDetected && !acknowledgeNoStores)
                }
              >
                {saving ? 'Saving...' : 'Save Configuration'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showComparisonModal && existingConfig && suggestedConfig && (
        <div className="modal-overlay" onClick={() => setShowComparisonModal(false)}>
          <div className="modal modal-xlarge" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Configuration Already Exists</h2>
              <button className="modal-close" onClick={() => setShowComparisonModal(false)}>
                ×
              </button>
            </div>
            <div className="modal-body">
              <div className="comparison-warning">
                <strong>⚠️ Brand "{brandId}" already exists.</strong> Compare and overwrite only if this should replace it.
              </div>
              <div className="config-comparison">
                <div className="config-column">
                  <h3>Existing Configuration</h3>
                  <pre className="config-preview">{JSON.stringify(existingConfig, null, 2)}</pre>
                </div>
                <div className="config-column">
                  <h3>Suggested Configuration</h3>
                  <pre className="config-preview">{JSON.stringify(suggestedConfig, null, 2)}</pre>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowComparisonModal(false)} disabled={saving}>
                Cancel
              </button>
              <button className="btn btn-warning" onClick={() => handleSave(true)} disabled={saving}>
                {saving ? 'Overwriting...' : 'Overwrite Existing Config'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ManualEndpointEntry;
