import { useState } from 'react';
import { scraperService } from '../services/scraper.service';
import ManualEndpointEntry from './ManualEndpointEntry';
import '../styles/EndpointDiscovery.css';

interface DiscoveredEndpoint {
  url: string;
  type: string;
  confidence: number;
  verified?: boolean;
  verified_store_count?: number;
  verified_type?: string;
  verification_error?: string;
  verification_time?: number;
  store_count?: number;
  data_path?: string;
  field_mapping?: Record<string, any>;
}

interface DiscoveryResult {
  success: boolean;
  url: string;
  endpoints: DiscoveredEndpoint[];
  suggested_config?: any;
  errors?: string[];
}

interface EndpointDiscoveryProps {
  /** Called after a brand config is saved or updated so the parent can refresh the brand list */
  onConfigSaved?: () => void;
}

const EndpointDiscovery: React.FC<EndpointDiscoveryProps> = ({ onConfigSaved }) => {
  const [mode, setMode] = useState<'auto' | 'manual'>('auto');
  const [storeLocatorUrl, setStoreLocatorUrl] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [discoveryResult, setDiscoveryResult] = useState<DiscoveryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedEndpoint, setSelectedEndpoint] = useState<DiscoveredEndpoint | null>(null);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [showComparisonModal, setShowComparisonModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [brandName, setBrandName] = useState('');
  const [brandDisplayName, setBrandDisplayName] = useState('');
  const [existingConfig, setExistingConfig] = useState<any>(null);
  const [suggestedConfig, setSuggestedConfig] = useState<any>(null);
  const [similarityInfo, setSimilarityInfo] = useState<{brandId: string; similarity: number; reason: string} | null>(null);

  const handleDiscover = async () => {
    if (!storeLocatorUrl.trim()) {
      setError('Please enter a store locator URL');
      return;
    }

    setDiscovering(true);
    setError(null);
    setDiscoveryResult(null);
    setSelectedEndpoint(null);

    try {
      const result = await scraperService.discoverEndpoints(storeLocatorUrl);
      
      if (result.success === false) {
        setError(result.errors?.join(', ') || 'Discovery failed');
        setDiscoveryResult(result);
      } else {
        setDiscoveryResult(result);
        
        // Auto-select the best endpoint (first one, usually highest confidence)
        if (result.endpoints && result.endpoints.length > 0) {
          // Prefer verified endpoints
          const verifiedEndpoint = result.endpoints.find((ep: DiscoveredEndpoint) => ep.verified);
          setSelectedEndpoint(verifiedEndpoint || result.endpoints[0]);
        }
      }
    } catch (err: any) {
      const errorMsg = err.response?.data?.error || err.response?.data?.details || err.message || 'Failed to discover endpoints';
      setError(errorMsg);
      console.error('Discovery error:', err);
    } finally {
      setDiscovering(false);
    }
  };

  const handleSaveAsConfig = async () => {
    if (!selectedEndpoint || !brandName.trim()) {
      setError('Please select an endpoint and enter a brand name');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await scraperService.saveBrandConfig({
        brandId: brandName,
        brandName: brandDisplayName || brandName,
        endpoint: selectedEndpoint,
        suggestedConfig: discoveryResult?.suggested_config,
        overwrite: false
      });

      // Save brand name before clearing state
      const savedBrandName = brandDisplayName || brandName;
      
      setShowSaveModal(false);
      setBrandName('');
      setBrandDisplayName('');
      setSelectedEndpoint(null);
      setDiscoveryResult(null);
      setStoreLocatorUrl('');
      
      onConfigSaved?.();
      // Show success message with saved brand name
      alert(`Brand configuration "${savedBrandName}" saved successfully! You can now create scraping jobs with this endpoint in the "Scraping Jobs" tab.`);
    } catch (err: any) {
      // Check if it's a conflict (config already exists or similar brand found)
      if (err.response?.status === 409 && err.response?.data?.existingConfig) {
        const conflictData = err.response.data;
        // Show comparison modal
        setExistingConfig(conflictData.existingConfig);
        // Build suggested config, ensuring data_path is included
        const baseSuggestedConfig = discoveryResult?.suggested_config || {
          type: selectedEndpoint.type,
          url: selectedEndpoint.url,
          method: 'GET',
          description: `Discovered endpoint for ${brandDisplayName || brandName}`,
          field_mapping: selectedEndpoint.field_mapping
        };
        // Ensure data_path is included (prefer from suggested_config, fallback to endpoint)
        if (!baseSuggestedConfig.data_path && selectedEndpoint.data_path) {
          baseSuggestedConfig.data_path = selectedEndpoint.data_path;
        }
        setSuggestedConfig(baseSuggestedConfig);
        // Store similarity info if this is a similar brand (not exact match)
        if (conflictData.similarity && conflictData.brandId !== brandName) {
          setSimilarityInfo({
            brandId: conflictData.brandId,
            similarity: conflictData.similarity,
            reason: conflictData.reason || 'Similar brand found'
          });
        } else {
          setSimilarityInfo(null);
        }
        setShowSaveModal(false);
        setShowComparisonModal(true);
      } else {
        setError(err.response?.data?.error || 'Failed to save brand configuration');
      }
    } finally {
      setSaving(false);
    }
  };

  const handleOverwriteConfig = async () => {
    if (!selectedEndpoint || !brandName.trim()) {
      setError('Please select an endpoint and enter a brand name');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      // Use the new name as the brand key; send oldBrandId so backend can remove the previous entry if the name changed
      await scraperService.saveBrandConfig({
        brandId: brandName,
        brandName: brandDisplayName || brandName,
        endpoint: selectedEndpoint,
        suggestedConfig: discoveryResult?.suggested_config,
        overwrite: true,
        oldBrandId: similarityInfo?.brandId ?? undefined
      });

      // Save brand name before clearing state
      const savedBrandName = brandDisplayName || brandName;
      
      setShowComparisonModal(false);
      setBrandName('');
      setBrandDisplayName('');
      setSelectedEndpoint(null);
      setDiscoveryResult(null);
      setStoreLocatorUrl('');
      setExistingConfig(null);
      setSuggestedConfig(null);
      setSimilarityInfo(null);
      
      onConfigSaved?.();
      // Show success message with saved brand name
      alert(`Brand configuration "${savedBrandName}" updated successfully! You can now create scraping jobs with this endpoint in the "Scraping Jobs" tab.`);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to update brand configuration');
    } finally {
      setSaving(false);
    }
  };

  const formatConfidence = (confidence: number) => {
    return `${(confidence * 100).toFixed(0)}%`;
  };

  if (mode === 'manual') {
    return (
      <div className="endpoint-discovery">
        <div className="discovery-header">
          <h2>Endpoint Discovery</h2>
          <p className="discovery-description">
            Discover API endpoints from store locator pages automatically, or enter an endpoint directly for manual probing and save.
          </p>
        </div>
        <div className="discovery-mode-toggle">
          <button className="btn btn-secondary" onClick={() => setMode('auto')}>Auto Discovery</button>
          <button className="btn btn-primary" disabled>Manual Entry</button>
        </div>
        <ManualEndpointEntry onConfigSaved={onConfigSaved} />
      </div>
    );
  }

  return (
    <div className="endpoint-discovery">
      <div className="discovery-header">
        <h2>Endpoint Discovery</h2>
        <p className="discovery-description">
          Discover API endpoints from store locator pages. Enter a store locator URL and we'll analyze it to find the API endpoints used to fetch store data.
        </p>
      </div>
      <div className="discovery-mode-toggle">
        <button className="btn btn-primary" disabled>Auto Discovery</button>
        <button className="btn btn-secondary" onClick={() => setMode('manual')}>Manual Entry</button>
      </div>

      {/* Discovery Form */}
      <div className="discovery-form">
        <div className="form-group">
          <label htmlFor="store-locator-url">Store Locator Page URL *</label>
          <input
            id="store-locator-url"
            type="text"
            value={storeLocatorUrl}
            onChange={(e) => setStoreLocatorUrl(e.target.value)}
            placeholder="https://www.example.com/store-locator"
            className="form-control"
            disabled={discovering}
          />
          <small className="form-hint">
            Enter the HTML page URL (not the API endpoint). The discoverer will analyze network requests to find the API.
          </small>
        </div>

        <button
          className="btn btn-primary"
          onClick={handleDiscover}
          disabled={discovering || !storeLocatorUrl.trim()}
        >
          {discovering ? 'Discovering...' : 'Discover Endpoints'}
        </button>
      </div>

      {/* Error Display */}
      {error && (
        <div className="error-message">
          {error}
        </div>
      )}

      {/* Discovery Results */}
      {discoveryResult && (
        <div className="discovery-results">
          <div className="results-header">
            <h3>Discovery Results</h3>
            {discoveryResult.success && (
              <span className="success-badge">✓ Success</span>
            )}
          </div>

          {discoveryResult.endpoints && discoveryResult.endpoints.length > 0 ? (
            <>
              <div className="endpoints-list">
                <h4>Found {discoveryResult.endpoints.length} Potential Endpoint(s)</h4>
                {discoveryResult.endpoints.map((endpoint, index) => (
                  <div
                    key={index}
                    className={`endpoint-card ${selectedEndpoint === endpoint ? 'selected' : ''}`}
                    onClick={() => setSelectedEndpoint(endpoint)}
                  >
                    <div className="endpoint-header">
                      <div className="endpoint-rank">#{index + 1}</div>
                      <div className="endpoint-info">
                        <div className="endpoint-url">{endpoint.url}</div>
                        <div className="endpoint-meta">
                          <span className="endpoint-type">{endpoint.type}</span>
                          <span className="endpoint-confidence">
                            Confidence: {formatConfidence(endpoint.confidence)}
                          </span>
                        </div>
                      </div>
                    </div>

                    {endpoint.verified && endpoint.type === 'html' && (
                      <div className="verification-badge verified">
                        ✓ HTML page with store data detected
                        {endpoint.verified_store_count ? ` (~${endpoint.verified_store_count} stores)` : ''}
                      </div>
                    )}

                    {endpoint.verified && endpoint.type !== 'html' && endpoint.verified_store_count !== undefined && (
                      <div className="verification-badge verified">
                        ✓ Verified: {endpoint.verified_store_count} stores in sample
                        {endpoint.verified_type && ` (Type: ${endpoint.verified_type})`}
                        {endpoint.verification_time && ` in ${endpoint.verification_time.toFixed(2)}s`}
                      </div>
                    )}

                    {!endpoint.verified && endpoint.verification_error && (
                      <div className="verification-badge error">
                        ⚠️ Verification failed: {endpoint.verification_error.substring(0, 100)}
                      </div>
                    )}

                    {!endpoint.verified &&
                      !endpoint.verification_error &&
                      typeof endpoint.store_count === 'number' && (
                      <div className="verification-badge">
                        ℹ️ ~{endpoint.store_count} stores in sample (discovery only — not verified)
                      </div>
                    )}

                    {endpoint.verified &&
                      endpoint.type === 'html' &&
                      endpoint.verified_store_count === undefined &&
                      typeof endpoint.store_count === 'number' && (
                      <div className="verification-badge">
                        ℹ️ ~{endpoint.store_count} stores estimated from page analysis
                      </div>
                    )}

                    {endpoint.data_path && (
                      <div className="endpoint-detail">
                        <strong>Data Path:</strong> {endpoint.data_path}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {selectedEndpoint && (
                <div className="selected-endpoint-actions">
                  <button
                    className="btn btn-primary"
                    onClick={() => setShowSaveModal(true)}
                  >
                    Save as Brand Config
                  </button>
                </div>
              )}

              {discoveryResult.suggested_config && (
                <div className="suggested-config">
                  <h4>Suggested Configuration</h4>
                  <pre className="config-preview">
                    {JSON.stringify(discoveryResult.suggested_config, null, 2)}
                  </pre>
                </div>
              )}
            </>
          ) : (
            <div className="no-endpoints">
              No endpoints found. Try a different URL or check if the page loads correctly.
            </div>
          )}

          {discoveryResult.errors && discoveryResult.errors.length > 0 && (
            <div className="discovery-errors">
              <h4>Errors:</h4>
              <ul>
                {discoveryResult.errors.map((err, idx) => (
                  <li key={idx}>{err}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Save Config Modal */}
      {showSaveModal && selectedEndpoint && (
        <div className="modal-overlay" onClick={() => setShowSaveModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Save as Brand Configuration</h2>
              <button className="modal-close" onClick={() => setShowSaveModal(false)}>
                ×
              </button>
            </div>

            <div className="modal-body">
              {error && <div className="error-message">{error}</div>}

              <div className="form-group">
                <label>Brand ID *</label>
                <input
                  type="text"
                  value={brandName}
                  onChange={(e) => setBrandName(e.target.value.toLowerCase().replace(/\s+/g, '_'))}
                  placeholder="e.g., omega_stores"
                  className="form-control"
                />
                <small className="form-hint">
                  Unique identifier (snake_case, e.g., omega_stores, rolex_retailers)
                </small>
              </div>

              <div className="form-group">
                <label>Brand Display Name</label>
                <input
                  type="text"
                  value={brandDisplayName}
                  onChange={(e) => setBrandDisplayName(e.target.value)}
                  placeholder="e.g., Omega Stores"
                  className="form-control"
                />
                <small className="form-hint">
                  Human-readable name (optional, will use Brand ID if not provided)
                </small>
              </div>

              <div className="info-box">
                <strong>Endpoint:</strong> {selectedEndpoint.url}<br />
                <strong>Type:</strong> {selectedEndpoint.type}<br />
                <strong>Confidence:</strong> {formatConfidence(selectedEndpoint.confidence)}<br />
                {(selectedEndpoint.verified_store_count !== undefined ||
                  typeof selectedEndpoint.store_count === 'number') && (
                  <>
                    <strong>Stores in sample:</strong>{' '}
                    {selectedEndpoint.verified_store_count !== undefined
                      ? selectedEndpoint.verified_store_count
                      : selectedEndpoint.store_count}
                    {selectedEndpoint.verified ? ' (verified)' : ' (discovery estimate)'}
                    <br />
                  </>
                )}
                {selectedEndpoint.data_path && (
                  <>
                    <strong>Data Path:</strong> {selectedEndpoint.data_path}<br />
                  </>
                )}
                {selectedEndpoint.verified_type && (
                  <>
                    <strong>Verified Type:</strong> {selectedEndpoint.verified_type}<br />
                  </>
                )}
              </div>

              {!selectedEndpoint.data_path && !discoveryResult?.suggested_config?.data_path && (
                <div className="warning-box">
                  <strong>Warning:</strong> No data path was detected. If the API returns stores
                  nested inside a key (e.g. <code>response.stores</code>), add a{' '}
                  <code>data_path</code> to the config manually after saving, otherwise the scraper
                  may not find any records.
                </div>
              )}
            </div>

            <div className="modal-footer">
              <button
                className="btn btn-secondary"
                onClick={() => setShowSaveModal(false)}
                disabled={saving}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={handleSaveAsConfig}
                disabled={!brandName.trim() || saving}
              >
                {saving ? 'Saving...' : 'Save Configuration'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Comparison Modal */}
      {showComparisonModal && existingConfig && suggestedConfig && (
        <div className="modal-overlay" onClick={() => {
          // Cancel on overlay click - don't save anything
          setShowComparisonModal(false);
          setExistingConfig(null);
          setSuggestedConfig(null);
          setSimilarityInfo(null);
          setError(null);
        }}>
          <div className="modal modal-xlarge" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{similarityInfo ? 'Similar Brand Configuration Found' : 'Configuration Already Exists'}</h2>
              <button className="modal-close" onClick={() => {
                // Cancel on X click - don't save anything
                setShowComparisonModal(false);
                setExistingConfig(null);
                setSuggestedConfig(null);
                setSimilarityInfo(null);
                setError(null);
              }}>
                ×
              </button>
            </div>

            <div className="modal-body">
              {similarityInfo ? (
                <div className="comparison-warning">
                  <strong>⚠️ Similar brand configuration found: "{similarityInfo.brandId}"</strong>
                  <div style={{ marginTop: '8px', fontSize: '14px', color: '#666' }}>
                    Similarity: {(similarityInfo.similarity * 100).toFixed(0)}% - {similarityInfo.reason}
                  </div>
                  <div style={{ marginTop: '8px' }}>
                    Compare the configurations below. If they're for the same brand, choose to overwrite. Otherwise, cancel and use a different brand name.
                  </div>
                </div>
              ) : (
                <div className="comparison-warning">
                  <strong>⚠️ Brand "{brandName}" already exists.</strong> Compare the configurations below and choose to overwrite or cancel.
                </div>
              )}

              {error && <div className="error-message">{error}</div>}

              <div className="config-comparison">
                <div className="config-column">
                  <h3>Existing Configuration</h3>
                  <pre className="config-preview">
                    {JSON.stringify(existingConfig, null, 2)}
                  </pre>
                </div>

                <div className="config-column">
                  <h3>Suggested Configuration</h3>
                  <pre className="config-preview">
                    {JSON.stringify(suggestedConfig, null, 2)}
                  </pre>
                </div>
              </div>

              <div className="config-differences">
                <h4>Key Differences:</h4>
                <ul>
                  {existingConfig.url !== suggestedConfig.url && (
                    <li>
                      <strong>URL:</strong> 
                      <span className="diff-old">{existingConfig.url}</span> → 
                      <span className="diff-new">{suggestedConfig.url}</span>
                    </li>
                  )}
                  {existingConfig.type !== suggestedConfig.type && (
                    <li>
                      <strong>Type:</strong> 
                      <span className="diff-old">{existingConfig.type}</span> → 
                      <span className="diff-new">{suggestedConfig.type}</span>
                    </li>
                  )}
                  {existingConfig.method !== suggestedConfig.method && (
                    <li>
                      <strong>Method:</strong> 
                      <span className="diff-old">{existingConfig.method}</span> → 
                      <span className="diff-new">{suggestedConfig.method}</span>
                    </li>
                  )}
                  {JSON.stringify(existingConfig.data_path || '') !== JSON.stringify(suggestedConfig.data_path || '') && (
                    <li>
                      <strong>Data Path:</strong> 
                      <span className="diff-old">{existingConfig.data_path || '(none)'}</span> → 
                      <span className="diff-new">{suggestedConfig.data_path || '(none)'}</span>
                    </li>
                  )}
                  {JSON.stringify(existingConfig.field_mapping || {}) !== JSON.stringify(suggestedConfig.field_mapping || {}) && (
                    <li>
                      <strong>Field Mapping:</strong> Changed
                      {existingConfig.field_mapping && (
                        <div className="diff-detail">
                          <div>Old: {Object.keys(existingConfig.field_mapping).length} fields</div>
                          <div>New: {Object.keys(suggestedConfig.field_mapping || {}).length} fields</div>
                        </div>
                      )}
                    </li>
                  )}
                  {((!existingConfig.url && !suggestedConfig.url) || 
                    (existingConfig.url && suggestedConfig.url && existingConfig.url === suggestedConfig.url)) &&
                    ((!existingConfig.type && !suggestedConfig.type) || 
                    (existingConfig.type && suggestedConfig.type && existingConfig.type === suggestedConfig.type)) &&
                    ((!existingConfig.method && !suggestedConfig.method) || 
                    (existingConfig.method && suggestedConfig.method && existingConfig.method === suggestedConfig.method)) &&
                    JSON.stringify(existingConfig.data_path || '') === JSON.stringify(suggestedConfig.data_path || '') &&
                    JSON.stringify(existingConfig.field_mapping || {}) === JSON.stringify(suggestedConfig.field_mapping || {}) && (
                    <li className="no-differences">No significant differences detected</li>
                  )}
                </ul>
              </div>
            </div>

            <div className="modal-footer">
              <button
                className="btn btn-secondary"
                onClick={() => {
                  // Cancel - just close the modal, don't save anything
                  setShowComparisonModal(false);
                  setExistingConfig(null);
                  setSuggestedConfig(null);
                  setSimilarityInfo(null);
                  setError(null); // Clear any errors
                  // Keep brandName and brandDisplayName in case user wants to try again
                }}
                disabled={saving}
              >
                Cancel
              </button>
              <button
                className="btn btn-warning"
                onClick={handleOverwriteConfig}
                disabled={saving}
              >
                {saving ? 'Overwriting...' : 'Overwrite Existing Config'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default EndpointDiscovery;
