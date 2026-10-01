import { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import {
  scraperService,
  type Brand,
  type GeoVerifyTaskStatus,
  type MasterCsvExportFilters,
  type ScraperJob,
  type ScraperStats,
} from '../services/scraper.service';
import EndpointDiscovery from '../components/EndpointDiscovery';
import '../styles/Scraper.css';

type TabType = 'jobs' | 'discovery' | 'master' | 'tools';


const Scraper: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabType>('jobs');
  const [brands, setBrands] = useState<Brand[]>([]);
  const [jobs, setJobs] = useState<ScraperJob[]>([]);
  const [stats, setStats] = useState<ScraperStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [showNewJobModal, setShowNewJobModal] = useState(false);
  const [showLogsModal, setShowLogsModal] = useState(false);
  const [selectedJobLogs, setSelectedJobLogs] = useState<string>('');
  const [selectedJobId, setSelectedJobId] = useState<string>('');
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [selectedBrand, setSelectedBrand] = useState<Brand | null>(null);
  const [customUrl, setCustomUrl] = useState('');
  const [region, setRegion] = useState('world');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>('');
  const [showRecordsModal, setShowRecordsModal] = useState(false);
  const [recordsJobId, setRecordsJobId] = useState<string>('');
  const [recordsData, setRecordsData] = useState<{
    columns: string[];
    records: Record<string, string>[];
  } | null>(null);
  const [loadingRecords, setLoadingRecords] = useState(false);
  const [editedRecords, setEditedRecords] = useState<Map<number, Record<string, string>>>(new Map());
  const [savingRecords, setSavingRecords] = useState(false);
  const [recordsViewMode, setRecordsViewMode] = useState<'all' | 'incomplete'>('all');
  const [recordsModalTab, setRecordsModalTab] = useState<'records' | 'dropped'>('records');
  const [droppedRecordsData, setDroppedRecordsData] = useState<{
    excludedStores: { name: string; address: string; reason: string }[];
    count: number;
  } | null>(null);
  const [loadingDroppedRecords, setLoadingDroppedRecords] = useState(false);
  // Master store data tab
  const [masterBrands, setMasterBrands] = useState<string[]>([]);
  const [masterBrandFilter, setMasterBrandFilter] = useState<string>('');
  const [masterCountryFilter, setMasterCountryFilter] = useState<string>('');
  const [masterPremiumOnly, setMasterPremiumOnly] = useState(false);
  const [showMasterRecordsModal, setShowMasterRecordsModal] = useState(false);
  const [masterRecordsData, setMasterRecordsData] = useState<{
    columns: string[];
    records: Record<string, string>[];
  } | null>(null);
  const [loadingMasterRecords, setLoadingMasterRecords] = useState(false);
  const [editedMasterRecords, setEditedMasterRecords] = useState<Map<number, Record<string, string>>>(new Map());
  const [savingMasterRecords, setSavingMasterRecords] = useState(false);
  const [masterRecordsViewMode, setMasterRecordsViewMode] = useState<'all' | 'incomplete'>('all');
  const [masterCountryOptions, setMasterCountryOptions] = useState<string[]>([]);
  const [loadingMasterCountries, setLoadingMasterCountries] = useState(false);
  // Geo-verify Tools tab
  const [geoVerifyBrand, setGeoVerifyBrand] = useState('');
  const [geoVerifyTask, setGeoVerifyTask] = useState<GeoVerifyTaskStatus | null>(null);
  const [geoVerifyRunning, setGeoVerifyRunning] = useState(false);
  const [geoVerifyError, setGeoVerifyError] = useState<string | null>(null);
  const geoVerifyPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** False after unmount so in-flight status polls do not call setState. */
  const geoVerifyMountedRef = useRef(true);

  const masterCsvFilters = (): MasterCsvExportFilters | undefined => {
    const country = masterCountryFilter.trim();
    if (!masterBrandFilter && !country && !masterPremiumOnly) return undefined;
    return {
      ...(masterBrandFilter ? { brand: masterBrandFilter } : {}),
      ...(country ? { country } : {}),
      ...(masterPremiumOnly ? { premiumOnly: true } : {}),
    };
  };

  const loadJobs = useCallback(async () => {
    try {
      const params = filterStatus ? { status: filterStatus } : {};
      const { jobs: jobsData } = await scraperService.listJobs(params);
      setJobs(jobsData);
    } catch (err) {
      console.error('Failed to load jobs:', err);
    }
  }, [filterStatus]);

  const refreshScraperStats = useCallback(async () => {
    try {
      const { stats: statsData } = await scraperService.getStats();
      setStats(statsData);
    } catch (err) {
      console.error('Failed to load scraper stats:', err);
    }
  }, []);

  const previousTabRef = useRef<TabType>(activeTab);

  useEffect(() => {
    loadData();
  }, []);

  // Refetch brands when switching from Endpoint Discovery to Scraping Jobs (so newly saved configs appear)
  useEffect(() => {
    if (previousTabRef.current === 'discovery' && activeTab === 'jobs') {
      loadData();
    }
    previousTabRef.current = activeTab;
  }, [activeTab]);

  // Refresh jobs and DB store count when filter changes or every 5 seconds
  useEffect(() => {
    loadJobs();
    refreshScraperStats();
    const interval = setInterval(() => {
      loadJobs();
      refreshScraperStats();
    }, 5000);
    return () => clearInterval(interval);
  }, [loadJobs, refreshScraperStats]);

  // Load DB-sourced brand list once when master tab first activates
  useEffect(() => {
    if (activeTab !== 'master' || masterBrands.length > 0) return;
    scraperService.getDbBrands()
      .then((b) => setMasterBrands(b))
      .catch(() => {});
  }, [activeTab, masterBrands.length]);

  useEffect(() => {
    if (activeTab !== 'master') return;
    let cancelled = false;
    (async () => {
      setLoadingMasterCountries(true);
      try {
        const scope =
          masterBrandFilter || masterPremiumOnly
            ? {
                ...(masterBrandFilter ? { brand: masterBrandFilter } : {}),
                ...(masterPremiumOnly ? { premiumOnly: true as const } : {}),
              }
            : undefined;
        const countries = await scraperService.getMasterCsvCountries(scope);
        if (cancelled) return;
        setMasterCountryOptions(countries);
        setMasterCountryFilter((prev) => (prev && countries.includes(prev) ? prev : ''));
      } catch {
        if (!cancelled) {
          setMasterCountryOptions([]);
          setMasterCountryFilter('');
        }
      } finally {
        if (!cancelled) setLoadingMasterCountries(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeTab, masterBrandFilter, masterPremiumOnly]);

  useEffect(() => {
    geoVerifyMountedRef.current = true;
    return () => {
      geoVerifyMountedRef.current = false;
      if (geoVerifyPollRef.current) {
        clearInterval(geoVerifyPollRef.current);
        geoVerifyPollRef.current = null;
      }
    };
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [brandsData, statsData] = await Promise.all([
        scraperService.getBrands(),
        scraperService.getStats(),
      ]);
      setBrands(brandsData.filter(b => b.enabled !== false));
      setStats(statsData.stats);
      setJobs(statsData.recentJobs);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const stopGeoVerifyPoll = () => {
    if (geoVerifyPollRef.current) {
      clearInterval(geoVerifyPollRef.current);
      geoVerifyPollRef.current = null;
    }
  };

  const startGeoVerifyPoll = (taskId: string) => {
    stopGeoVerifyPoll();
    geoVerifyPollRef.current = setInterval(async () => {
      try {
        const task = await scraperService.getGeoVerifyStatus(taskId);
        if (!geoVerifyMountedRef.current) return;
        setGeoVerifyTask(task);
        if (task.status !== 'running') {
          stopGeoVerifyPoll();
          setGeoVerifyRunning(false);
        }
      } catch (err) {
        console.error('Failed to poll geo-verify status:', err);
      }
    }, 2500);
  };

  const handleStartGeoVerify = async () => {
    const brand = geoVerifyBrand.trim();
    if (!brand) {
      setGeoVerifyError('Please enter a brand name.');
      return;
    }
    setGeoVerifyError(null);
    setGeoVerifyRunning(true);
    setGeoVerifyTask(null);
    try {
      const { taskId } = await scraperService.startGeoVerify(brand);
      if (!geoVerifyMountedRef.current) return;
      startGeoVerifyPoll(taskId);
    } catch (err: any) {
      if (!geoVerifyMountedRef.current) return;
      setGeoVerifyError(err.response?.data?.error || 'Failed to start verification.');
      setGeoVerifyRunning(false);
    }
  };

  const handleResetGeoVerify = () => {
    stopGeoVerifyPoll();
    setGeoVerifyTask(null);
    setGeoVerifyRunning(false);
    setGeoVerifyError(null);
  };

  const handleStartScraping = async () => {
    if (!selectedBrand) {
      setError('Please select a brand');
      return;
    }

    const url = customUrl || selectedBrand.url;
    if (!url) {
      setError('URL is required');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      await scraperService.createJob({
        brandName: selectedBrand.id, // Use ID (e.g., "omega_stores") not formatted name
        url,
        region,
      });

      setShowNewJobModal(false);
      setSelectedBrand(null);
      setCustomUrl('');
      setRegion('world');
      loadData();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to start scraping job');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteJob = async (jobId: string) => {
    if (!confirm('Are you sure you want to delete this job?')) {
      return;
    }

    try {
      await scraperService.deleteJob(jobId);
      loadJobs();
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to delete job');
    }
  };

  const handleCancelJob = async (jobId: string) => {
    if (!confirm('Are you sure you want to cancel this running job?')) {
      return;
    }

    try {
      await scraperService.cancelJob(jobId);
      // Refresh jobs list to show cancelled status
      loadJobs();
      // If logs modal is open for this job, refresh it
      if (selectedJobId === jobId && showLogsModal) {
        const logsData = await scraperService.getJobLogs(jobId);
        setSelectedJobLogs(logsData.logs);
      }
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to cancel job');
    }
  };

  const handleViewLogs = async (jobId: string) => {
    setSelectedJobId(jobId);
    setShowLogsModal(true);
    setLoadingLogs(true);

    try {
      const logsData = await scraperService.getJobLogs(jobId);
      setSelectedJobLogs(logsData.logs || 'No logs available');
    } catch (err: any) {
      setSelectedJobLogs(`Error loading logs: ${err.response?.data?.error || err.message}`);
    } finally {
      setLoadingLogs(false);
    }
  };

  const handleEditRecords = async (jobId: string) => {
    setRecordsJobId(jobId);
    setShowRecordsModal(true);
    setLoadingRecords(true);
    setEditedRecords(new Map());
    setRecordsViewMode('all');
    setRecordsModalTab('records');
    setDroppedRecordsData(null);
    setError(null);

    try {
      const data = await scraperService.getJobRecords(jobId);
      setRecordsData({ columns: data.columns, records: data.records });
    } catch (err: any) {
      setRecordsData(null);
      setError(err.response?.data?.error || 'Failed to load job records');
    } finally {
      setLoadingRecords(false);
    }
  };

  const handleLoadDroppedRecords = async () => {
    if (!recordsJobId || droppedRecordsData !== null) return;
    setLoadingDroppedRecords(true);
    setError(null);
    try {
      const data = await scraperService.getJobDroppedRecords(recordsJobId);
      setDroppedRecordsData({ excludedStores: data.excludedStores, count: data.count });
    } catch (err: any) {
      setDroppedRecordsData({ excludedStores: [], count: 0 });
      setError(err.response?.data?.error || 'Failed to load dropped records');
    } finally {
      setLoadingDroppedRecords(false);
    }
  };

  const handleRecordCellChange = (rowIndex: number, column: string, value: string) => {
    if (!recordsData) return;
    const base = editedRecords.get(rowIndex) ?? recordsData.records[rowIndex];
    const updated = { ...base, [column]: value };
    setEditedRecords(new Map(editedRecords).set(rowIndex, updated));
  };

  const getRecordValue = (rowIndex: number, column: string): string => {
    const edited = editedRecords.get(rowIndex);
    const base = recordsData?.records[rowIndex];
    if (edited && column in edited) return edited[column];
    return base?.[column] ?? '';
  };

  /** Check if a store record is missing important data (phone or address) */
  const storeHasMissingImportantData = (record: Record<string, string>): boolean => {
    const phone = (record['Phone'] ?? '').trim();
    const addr1 = (record['Address Line 1'] ?? '').trim();
    const addr2 = (record['Address Line 2'] ?? '').trim();
    const hasAddress = addr1.length > 0 || addr2.length > 0;
    const hasPhone = phone.length > 0;
    return !hasPhone || !hasAddress;
  };

  /** Records to display based on view mode (all vs incomplete only) */
  const displayedRecords = (() => {
    if (!recordsData) return [];
    if (recordsViewMode === 'all') {
      return recordsData.records.map((r, i) => ({ record: r, originalIndex: i }));
    }
    return recordsData.records
      .map((r, i) => ({ record: r, originalIndex: i }))
      .filter(({ record }) => storeHasMissingImportantData(record));
  })();

  const incompleteCount = recordsData
    ? recordsData.records.filter(storeHasMissingImportantData).length
    : 0;

  const handleSaveRecords = async () => {
    if (!recordsData || !recordsJobId || editedRecords.size === 0) return;
    setSavingRecords(true);
    setError(null);
    try {
      const fullRecords = recordsData.records.map((r, i) =>
        editedRecords.has(i) ? editedRecords.get(i)! : r
      );
      const result = await scraperService.saveJobRecords(recordsJobId, fullRecords);
      setEditedRecords(new Map());
      setShowRecordsModal(false);
      loadData();
      const parts = [`Saved ${result.savedToJob} records to job CSV`];
      if (result.dbUpserted > 0) parts.push(`${result.dbUpserted} complete record(s) synced to the database`);
      if (result.skippedIncomplete > 0) parts.push(`${result.skippedIncomplete} incomplete record(s) kept in job only`);
      if (result.validationErrors) parts.push(`Validation blocked ${result.validationErrors} record(s)`);
      alert(parts.join('. '));
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to save records');
    } finally {
      setSavingRecords(false);
    }
  };

  const handleEditMasterRecords = async () => {
    setShowMasterRecordsModal(true);
    setLoadingMasterRecords(true);
    setEditedMasterRecords(new Map());
    setMasterRecordsViewMode('all');
    setError(null);
    try {
      const data = await scraperService.getMasterCsvRecords(masterCsvFilters());
      setMasterRecordsData({ columns: data.columns, records: data.records });
    } catch (err: any) {
      setMasterRecordsData(null);
      setError(err.response?.data?.error || 'Failed to load master store data');
    } finally {
      setLoadingMasterRecords(false);
    }
  };

  const handleMasterRecordCellChange = (rowIndex: number, column: string, value: string) => {
    if (!masterRecordsData) return;
    const base = editedMasterRecords.get(rowIndex) ?? masterRecordsData.records[rowIndex];
    const updated = { ...base, [column]: value };
    setEditedMasterRecords(new Map(editedMasterRecords).set(rowIndex, updated));
  };

  const getMasterRecordValue = (rowIndex: number, column: string): string => {
    const edited = editedMasterRecords.get(rowIndex);
    const base = masterRecordsData?.records[rowIndex];
    if (edited && column in edited) return edited[column];
    return base?.[column] ?? '';
  };

  const masterStoreHasMissingImportantData = (record: Record<string, string>): boolean => {
    const phone = (record['Phone'] ?? '').trim();
    const addr1 = (record['Address Line 1'] ?? '').trim();
    const addr2 = (record['Address Line 2'] ?? '').trim();
    const hasAddress = addr1.length > 0 || addr2.length > 0;
    const hasPhone = phone.length > 0;
    return !hasPhone || !hasAddress;
  };

  const displayedMasterRecords = (() => {
    if (!masterRecordsData) return [];
    if (masterRecordsViewMode === 'all') {
      return masterRecordsData.records.map((r, i) => ({ record: r, originalIndex: i }));
    }
    return masterRecordsData.records
      .map((r, i) => ({ record: r, originalIndex: i }))
      .filter(({ record }) => masterStoreHasMissingImportantData(record));
  })();

  const masterIncompleteCount = masterRecordsData
    ? masterRecordsData.records.filter(masterStoreHasMissingImportantData).length
    : 0;

  const handleSaveMasterRecords = async () => {
    if (!masterRecordsData || editedMasterRecords.size === 0) return;
    setSavingMasterRecords(true);
    setError(null);
    try {
      const rowsToUpdate = Array.from(editedMasterRecords.values());
      const result = await scraperService.updateMasterCsvRows(rowsToUpdate);
      setEditedMasterRecords(new Map());
      setShowMasterRecordsModal(false);
      loadData();
      alert(`Saved ${result.updatedCount} of ${result.totalRequested} records to master CSV.`);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to save records');
    } finally {
      setSavingMasterRecords(false);
    }
  };

  const handleRemoveMasterRecord = async (record: Record<string, string>) => {
    const handle = (record['Handle'] ?? record['handle'] ?? '').trim();
    const name = (record['Name'] ?? '').trim() || 'this store';
    if (!handle) {
      setError('Cannot remove: record has no Handle');
      return;
    }
    if (!confirm(`Remove "${name}" from the master CSV? This cannot be undone.`)) return;
    setError(null);
    try {
      const { removed } = await scraperService.deleteMasterRecord(handle);
      if (removed) {
        setEditedMasterRecords(new Map());
        const data = await scraperService.getMasterCsvRecords(masterCsvFilters());
        setMasterRecordsData({ columns: data.columns, records: data.records });
        loadData();
      } else {
        setError('Store not found in master CSV');
      }
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to remove store');
    }
  };

  // Auto-refresh logs for running jobs
  useEffect(() => {
    if (!showLogsModal || !selectedJobId) return;

    const loadLogs = async () => {
      try {
        const logsData = await scraperService.getJobLogs(selectedJobId);
        setSelectedJobLogs(logsData.logs || 'No logs available');
        
        // Stop refreshing if job is completed or failed
        if (logsData.status !== 'running' && logsData.status !== 'queued') {
          return false;
        }
        return true; // Continue refreshing
      } catch (err: any) {
        console.error('Error loading logs:', err);
        return false; // Stop on error
      }
    };

    // Initial load
    loadLogs();

    // Set up auto-refresh for running jobs
    const refreshInterval = setInterval(async () => {
      const shouldContinue = await loadLogs();
      if (!shouldContinue) {
        clearInterval(refreshInterval);
      }
    }, 1000); // Refresh every 1 second for better real-time viewing

    // Cleanup interval when modal closes or component unmounts
    return () => clearInterval(refreshInterval);
  }, [showLogsModal, selectedJobId]);

  const getStatusBadge = (status: string) => {
    const badges: { [key: string]: string } = {
      queued: 'status-badge status-pending',
      running: 'status-badge status-processing',
      completed: 'status-badge status-valid',
      failed: 'status-badge status-invalid',
      cancelled: 'status-badge status-cancelled',
    };
    return badges[status] || 'status-badge';
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString();
  };

  const calculateDuration = (start: string, end?: string) => {
    const startTime = new Date(start).getTime();
    const endTime = end ? new Date(end).getTime() : Date.now();
    const seconds = Math.floor((endTime - startTime) / 1000);
    
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  };

  if (loading) {
    return <div className="loading">Loading...</div>;
  }

  return (
    <div className="scraper-page">
      <div className="page-header">
        <h1>Store Scraper</h1>
        {activeTab === 'jobs' && (
          <button className="btn btn-primary" onClick={() => setShowNewJobModal(true)}>
            + New Scraping Job
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="scraper-tabs">
        <button
          className={`tab-button ${activeTab === 'jobs' ? 'active' : ''}`}
          onClick={() => setActiveTab('jobs')}
        >
          Scraping Jobs
        </button>
        <button
          className={`tab-button ${activeTab === 'discovery' ? 'active' : ''}`}
          onClick={() => setActiveTab('discovery')}
        >
          Endpoint Discovery
        </button>
        <button
          className={`tab-button ${activeTab === 'master' ? 'active' : ''}`}
          onClick={() => setActiveTab('master')}
        >
          Master Store Data
        </button>
        <button
          className={`tab-button ${activeTab === 'tools' ? 'active' : ''}`}
          onClick={() => setActiveTab('tools')}
        >
          Tools
        </button>
      </div>

      {/* Tab Content */}
      {activeTab === 'discovery' ? (
        <EndpointDiscovery onConfigSaved={loadData} />
      ) : activeTab === 'tools' ? (
        <div className="content-section">
          <div className="section-header">
            <h2>Store Tools</h2>
          </div>

          {/* Geo-Verify & Dedup Tool */}
          <div className="tool-card">
            <div className="tool-card-header">
              <h3>Geo-Verify &amp; Dedup</h3>
              <p className="tool-card-description">
                Re-geocode all stores for a brand using Nominatim, then run address deduplication to
                merge any duplicate locations. Brand affiliations are unioned onto the surviving record.
              </p>
            </div>

            <div className="tool-card-body">
              <div className="tool-field-row">
                <label className="tool-label" htmlFor="geo-verify-brand-input">Brand name</label>
                <div className="tool-input-group">
                  <input
                    id="geo-verify-brand-input"
                    type="text"
                    className="tool-input"
                    placeholder="e.g. OMEGA, AUDEMARS PIGUET, omega_stores"
                    value={geoVerifyBrand}
                    onChange={(e) => setGeoVerifyBrand(e.target.value)}
                    disabled={geoVerifyRunning}
                    list="geo-verify-brand-list"
                  />
                  <datalist id="geo-verify-brand-list">
                    {brands.map((b) => (
                      <option key={b.id} value={b.id}>{b.name}</option>
                    ))}
                  </datalist>
                </div>
              </div>

              {geoVerifyError && (
                <div className="tool-error">{geoVerifyError}</div>
              )}

              <div className="tool-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleStartGeoVerify}
                  disabled={geoVerifyRunning || !geoVerifyBrand.trim()}
                >
                  {geoVerifyRunning ? 'Running...' : 'Run Geo-Verify & Dedup'}
                </button>
                {geoVerifyTask && !geoVerifyRunning && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={handleResetGeoVerify}
                  >
                    Reset
                  </button>
                )}
              </div>

              {/* Progress */}
              {(geoVerifyRunning || geoVerifyTask) && (
                <div className="tool-progress-section">
                  {geoVerifyTask && geoVerifyTask.progress.total > 0 && (
                    <div className="tool-progress-bar-wrap">
                      <div
                        className="tool-progress-bar-fill"
                        style={{
                          width: `${Math.min(100, Math.round((geoVerifyTask.progress.checked / geoVerifyTask.progress.total) * 100))}%`,
                        }}
                      />
                      <span className="tool-progress-label">
                        {geoVerifyTask.progress.checked} / {geoVerifyTask.progress.total}
                        {geoVerifyTask.phase === 'dedup' ? ' — deduplicating...' : ''}
                      </span>
                    </div>
                  )}
                  {geoVerifyRunning && (!geoVerifyTask || geoVerifyTask.progress.total === 0) && (
                    <div className="tool-progress-bar-wrap">
                      <div className="tool-progress-bar-fill tool-progress-bar-indeterminate" />
                      <span className="tool-progress-label">Starting…</span>
                    </div>
                  )}

                  {geoVerifyTask && geoVerifyTask.log.length > 0 && (
                    <div className="tool-log">
                      {geoVerifyTask.log.map((line, i) => (
                        <div key={i} className="tool-log-line">{line}</div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Results summary */}
              {geoVerifyTask && geoVerifyTask.status === 'done' && geoVerifyTask.result && (
                <div className="tool-results">
                  <h4>Results</h4>
                  <div className="tool-results-grid">
                    <div className="tool-result-stat">
                      <span className="tool-result-value tool-result-value--updated">{geoVerifyTask.result.coordinatesUpdated}</span>
                      <span className="tool-result-label">Coordinates updated</span>
                    </div>
                    <div className="tool-result-stat">
                      <span className="tool-result-value">{geoVerifyTask.result.verifiedStampOnly}</span>
                      <span className="tool-result-label">Confirmed (no change)</span>
                    </div>
                    <div className="tool-result-stat">
                      <span className="tool-result-value tool-result-value--warn">{geoVerifyTask.result.geocodeFailed}</span>
                      <span className="tool-result-label">Geocode failures</span>
                    </div>
                    <div className="tool-result-stat">
                      <span className="tool-result-value tool-result-value--merged">{geoVerifyTask.result.dedupMerged}</span>
                      <span className="tool-result-label">Duplicates removed</span>
                    </div>
                    <div className="tool-result-stat">
                      <span className="tool-result-value">{geoVerifyTask.result.locationsRemaining}</span>
                      <span className="tool-result-label">Stores remaining</span>
                    </div>
                    <div className="tool-result-stat">
                      <span className="tool-result-value">{geoVerifyTask.result.elapsedSec.toFixed(1)}s</span>
                      <span className="tool-result-label">Total time</span>
                    </div>
                  </div>
                </div>
              )}

              {geoVerifyTask && geoVerifyTask.status === 'error' && (
                <div className="tool-error tool-error--block">
                  <strong>Error:</strong> {geoVerifyTask.error}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : activeTab === 'master' ? (
        <div className="content-section">
          <div className="section-header">
            <h2>Edit Master Store Data</h2>
            <div className="filter-controls filter-controls-wrap">
              <select
                value={masterBrandFilter}
                onChange={(e) => {
                  setMasterBrandFilter(e.target.value);
                  setMasterCountryFilter('');
                }}
                className="filter-select"
              >
                <option value="">All brands</option>
                {masterBrands.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
              <select
                className="filter-select"
                value={masterCountryFilter}
                onChange={(e) => setMasterCountryFilter(e.target.value)}
                disabled={loadingMasterCountries}
                aria-label="Filter by country"
                title={
                  masterBrandFilter
                    ? 'Countries that have at least one store matching the selected brand in the database'
                    : 'All countries that appear on locations in the database'
                }
              >
                <option value="">
                  {loadingMasterCountries ? 'Loading countries…' : 'All countries'}
                </option>
                {masterCountryOptions.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <label className="filter-checkbox">
                <input
                  type="checkbox"
                  checked={masterPremiumOnly}
                  onChange={(e) => setMasterPremiumOnly(e.target.checked)}
                />
                Premium only
              </label>
              <button
                className="btn btn-primary"
                onClick={handleEditMasterRecords}
              >
                Load & Edit Master Data
              </button>
            </div>
          </div>
          <p className="records-hint">
            Pick a brand to limit the country list to countries that have at least one matching store in the
            database (same brand matching as the public locations API). Optional premium-only narrows both the
            country list and the editor view. Stores with multiple brands still appear when a matching brand is selected.
            If premium counts look wrong after a bulk import, use Reconcile premium flags on the Premium Stores page.
            Click &quot;Load & Edit Master Data&quot; to open the inline editor. To export stores as CSV, use the Uploads page.
          </p>
        </div>
      ) : (
        <>

      {/* Stats Cards */}
      {stats && (
        <div className="stats-grid">
          <div className="stat-card">
            <div className="stat-value">{stats.totalJobs}</div>
            <div className="stat-label">Total Jobs</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{stats.runningJobs}</div>
            <div className="stat-label">Running</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{stats.completedJobs}</div>
            <div className="stat-label">Completed</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{stats.failedJobs}</div>
            <div className="stat-label">Failed</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">
              {(stats.totalStoresInDatabase ?? stats.totalRecords ?? 0).toLocaleString()}
            </div>
            <div className="stat-label">Stores in database</div>
          </div>
        </div>
      )}

      {/* Jobs List */}
      <div className="content-section">
        <div className="section-header">
          <h2>Scraping Jobs</h2>
          <div className="filter-controls">
            <select 
              value={filterStatus} 
              onChange={(e) => {
                setFilterStatus(e.target.value);
              }}
              className="filter-select"
            >
              <option value="">All Status</option>
              <option value="queued">Queued</option>
              <option value="running">Running</option>
              <option value="completed">Completed</option>
              <option value="failed">Failed</option>
            </select>
          </div>
        </div>

        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th>Brand</th>
                <th>Status</th>
                <th>Started</th>
                <th>Duration</th>
                <th>Records</th>
                <th>Upload</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {jobs.length === 0 ? (
                <tr>
                  <td colSpan={7} className="no-data">No scraping jobs found</td>
                </tr>
              ) : (
                jobs.map((job) => (
                  <tr key={job.id}>
                    <td><strong>{job.brandName}</strong></td>
                    <td>
                      <span className={getStatusBadge(job.status)}>
                        {job.status}
                      </span>
                    </td>
                    <td>{formatDate(job.startedAt)}</td>
                    <td>{calculateDuration(job.startedAt, job.completedAt)}</td>
                    <td>{job.recordsScraped > 0 ? job.recordsScraped.toLocaleString() : '-'}</td>
                    <td>
                      {job.uploadId ? (
                        <Link to={`/uploads/${job.uploadId}`} className="link">
                          View Upload
                        </Link>
                      ) : (
                        '-'
                      )}
                    </td>
                    <td>
                      <button
                        onClick={() => handleViewLogs(job.id)}
                        className="btn btn-secondary btn-sm"
                        style={{ marginRight: '0.5rem' }}
                      >
                        View Logs
                      </button>
                      {job.status === 'completed' && job.uploadId && (
                        <button
                          onClick={() => handleEditRecords(job.id)}
                          className="btn btn-primary btn-sm"
                          style={{ marginRight: '0.5rem' }}
                        >
                          Edit Records
                        </button>
                      )}
                      {job.status === 'running' ? (
                        <button
                          onClick={() => handleCancelJob(job.id)}
                          className="btn btn-warning btn-sm"
                        >
                          Cancel
                        </button>
                      ) : (
                        <button
                          onClick={() => handleDeleteJob(job.id)}
                          className="btn btn-danger btn-sm"
                        >
                          Delete
                        </button>
                      )}
                      {job.errorMessage && (
                        <span title={job.errorMessage} className="error-indicator">
                          ⚠️
                        </span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* New Job Modal */}
      {showNewJobModal && (
        <div className="modal-overlay" onClick={() => setShowNewJobModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Start New Scraping Job</h2>
              <button className="modal-close" onClick={() => setShowNewJobModal(false)}>
                ×
              </button>
            </div>

            <div className="modal-body">
              {error && <div className="error-message">{error}</div>}

              <div className="form-group">
                <label>Brand *</label>
                <select
                  value={selectedBrand?.id || ''}
                  onChange={(e) => {
                    const brand = brands.find(b => b.id === e.target.value);
                    setSelectedBrand(brand || null);
                    setCustomUrl(brand?.url || '');
                  }}
                  className="form-control"
                >
                  <option value="">Select a brand...</option>
                  {brands.map((brand) => (
                    <option key={brand.id} value={brand.id}>
                      {brand.name} ({brand.type})
                    </option>
                  ))}
                </select>
              </div>

              {selectedBrand && (
                <>
                  <div className="form-group">
                    <label>API URL *</label>
                    <input
                      type="text"
                      value={customUrl}
                      onChange={(e) => setCustomUrl(e.target.value)}
                      className="form-control"
                      placeholder="Enter API endpoint URL"
                    />
                    <small className="form-hint">
                      Default: {selectedBrand.url}
                    </small>
                  </div>

                  {(selectedBrand.supportsRegionPreset ?? selectedBrand.isViewportBased) && (
                    <div className="form-group">
                      <label>Region</label>
                      <select
                        value={region}
                        onChange={(e) => setRegion(e.target.value)}
                        className="form-control"
                      >
                        <option value="world">Worldwide</option>
                        <option value="north_america">North America</option>
                        <option value="europe">Europe</option>
                        <option value="asia">Asia</option>
                      </select>
                      <small className="form-hint">
                        Passed to the scraper as <code>--region</code> (viewport grids, multi-center radius
                        search, country subsets). Use <strong>North America</strong> for US-focused SFCC
                        locators such as Citizen.
                      </small>
                    </div>
                  )}

                  <div className="info-box">
                    <strong>Type:</strong> {selectedBrand.type}<br />
                    <strong>Method:</strong> {selectedBrand.method || 'GET'}<br />
                    {selectedBrand.description && (
                      <>
                        <strong>Description:</strong> {selectedBrand.description}
                      </>
                    )}
                  </div>
                </>
              )}
            </div>

            <div className="modal-footer">
              <button
                className="btn btn-secondary"
                onClick={() => setShowNewJobModal(false)}
                disabled={submitting}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={handleStartScraping}
                disabled={!selectedBrand || submitting}
              >
                {submitting ? 'Starting...' : 'Start Scraping'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Logs Modal */}
      {showLogsModal && (
        <div className="modal-overlay" onClick={() => setShowLogsModal(false)}>
          <div className="modal modal-large" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Job Logs - {selectedJobId.substring(0, 8)}</h2>
              <button className="modal-close" onClick={() => setShowLogsModal(false)}>
                ×
              </button>
            </div>

            <div className="modal-body">
              {loadingLogs ? (
                <div className="loading">Loading logs...</div>
              ) : (
                <pre className="logs-container" style={{ 
                  maxHeight: '70vh', 
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontSize: '12px',
                  fontFamily: 'monospace',
                  backgroundColor: '#1e1e1e',
                  color: '#d4d4d4',
                  padding: '1rem',
                  borderRadius: '4px'
                }}>
                  {selectedJobLogs || 'No logs available'}
                </pre>
              )}
            </div>

            <div className="modal-footer">
              <button
                className="btn btn-secondary"
                onClick={() => {
                  setShowLogsModal(false);
                  setSelectedJobLogs('');
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Job Records Edit Modal */}
      {showRecordsModal && (
        <div className="modal-overlay" onClick={() => setShowRecordsModal(false)}>
          <div className="modal modal-xlarge modal-records" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Edit Job Records – {recordsJobId.substring(0, 8)}</h2>
              <button className="modal-close" onClick={() => setShowRecordsModal(false)}>
                ×
              </button>
            </div>

            <div className="modal-body">
              {error && <div className="error-message">{error}</div>}
              <div className="records-view-toggle" style={{ marginBottom: '1rem' }}>
                <button
                  type="button"
                  className={`records-view-btn ${recordsModalTab === 'records' ? 'active' : ''}`}
                  onClick={() => {
                    setError(null);
                    setRecordsModalTab('records');
                  }}
                >
                  Records {recordsData ? `(${recordsData.records.length})` : ''}
                </button>
                <button
                  type="button"
                  className={`records-view-btn ${recordsModalTab === 'dropped' ? 'active' : ''}`}
                  onClick={() => {
                    setError(null);
                    setRecordsModalTab('dropped');
                    handleLoadDroppedRecords();
                  }}
                >
                  Dropped {droppedRecordsData !== null ? `(${droppedRecordsData.count})` : ''}
                </button>
              </div>
              {recordsModalTab === 'records' ? (
              loadingRecords ? (
                <div className="loading">Loading records...</div>
              ) : recordsData ? (
                <>
                  <p className="records-hint">
                    Edit incorrect or missing fields below. All changes are saved to this job&apos;s CSV. Only complete records (with phone and address) are validated and added to the master CSV. Incomplete records stay in the job for editing.
                  </p>
                  <div className="records-view-toggle">
                    <button
                      type="button"
                      className={`records-view-btn ${recordsViewMode === 'all' ? 'active' : ''}`}
                      onClick={() => setRecordsViewMode('all')}
                    >
                      All records ({recordsData.records.length})
                    </button>
                    <button
                      type="button"
                      className={`records-view-btn ${recordsViewMode === 'incomplete' ? 'active' : ''}`}
                      onClick={() => setRecordsViewMode('incomplete')}
                    >
                      Incomplete only ({incompleteCount})
                    </button>
                  </div>
                  <div className="records-table-wrapper">
                    <table className="records-edit-table">
                      <thead>
                        <tr>
                          <th className="record-warning-col record-header-sticky" title="Stores with missing phone or address">
                            <span className="record-warning-header">⚠</span>
                          </th>
                          {recordsData.columns.map((col) => (
                            <th key={col} className="record-header-sticky">{col}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                            {displayedRecords.length === 0 ? (
                              <tr>
                                <td colSpan={(recordsData.columns.length + 1)} className="records-empty-state">
                                  {recordsViewMode === 'incomplete'
                                    ? 'No records with missing phone or address.'
                                    : 'No records.'}
                                </td>
                              </tr>
                            ) : displayedRecords.map(({ record, originalIndex }) => {
                              const currentRecord = editedRecords.get(originalIndex) ?? record;
                              const hasMissing = storeHasMissingImportantData(currentRecord);
                              const isColumnIncomplete = (col: string) => {
                                if (!hasMissing) return false;
                                const val = (currentRecord[col] ?? '').trim();
                                if (col === 'Phone') return val.length === 0;
                                if (col === 'Address Line 1' || col === 'Address Line 2') {
                                  const addr1 = (currentRecord['Address Line 1'] ?? '').trim();
                                  const addr2 = (currentRecord['Address Line 2'] ?? '').trim();
                                  return addr1.length === 0 && addr2.length === 0;
                                }
                                return false;
                              };
                              return (
                                <tr
                                  key={originalIndex}
                                  className={`${editedRecords.has(originalIndex) ? 'row-edited' : ''} ${hasMissing ? 'row-incomplete' : ''}`}
                                >
                                  <td className="record-warning-col">
                                    {hasMissing ? (
                                      <span
                                        className="record-warning-icon"
                                        title="Missing phone number or address"
                                      >
                                        ⚠
                                      </span>
                                    ) : (
                                      <span className="record-warning-empty" />
                                    )}
                                  </td>
                                  {recordsData.columns.map((col) => (
                                    <td key={col}>
                                      {col === 'Handle' ? (
                                        <span className="record-cell-readonly">{getRecordValue(originalIndex, col)}</span>
                                      ) : (
                                        <input
                                          type="text"
                                          className={`record-cell-input ${isColumnIncomplete(col) ? 'record-cell-incomplete' : ''}`}
                                          value={getRecordValue(originalIndex, col)}
                                          onChange={(e) => handleRecordCellChange(originalIndex, col, e.target.value)}
                                        />
                                      )}
                                    </td>
                                  ))}
                                </tr>
                              );
                            })}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <div className="error-message">Could not load records</div>
              )
              ) : (
                <>
                  {loadingDroppedRecords ? (
                    <div className="loading">Loading dropped records...</div>
                  ) : droppedRecordsData && droppedRecordsData.count > 0 ? (
                    <>
                      <p className="records-hint">
                        These stores were excluded from the output because they lack Latitude/Longitude coordinates
                        (geocoding failed or insufficient address data).
                      </p>
                      <div className="records-table-wrapper">
                        <table className="records-edit-table">
                          <thead>
                            <tr>
                              <th>#</th>
                              <th>Store Name</th>
                              <th>Address</th>
                              <th>Reason</th>
                            </tr>
                          </thead>
                          <tbody>
                            {droppedRecordsData.excludedStores.map((store, i) => (
                              <tr key={i} className="row-incomplete">
                                <td>{i + 1}</td>
                                <td>{store.name}</td>
                                <td>{store.address}</td>
                                <td>{store.reason}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  ) : (
                    <div className="records-empty-state" style={{ padding: '2rem' }}>
                      No dropped records for this run.
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="modal-footer">
              <button
                className="btn btn-secondary"
                onClick={() => setShowRecordsModal(false)}
              >
                Cancel
              </button>
              {recordsModalTab === 'records' && (
              <button
                className="btn btn-primary"
                onClick={handleSaveRecords}
                disabled={editedRecords.size === 0 || savingRecords}
              >
                {savingRecords ? 'Saving...' : `Save ${editedRecords.size} change(s) (complete records → master)`}
              </button>
              )}
            </div>
          </div>
        </div>
      )}
        </>
      )}

      {/* Master Store Data Edit Modal - rendered at root so it works from master tab */}
      {showMasterRecordsModal && (
        <div className="modal-overlay" onClick={() => setShowMasterRecordsModal(false)}>
          <div className="modal modal-xlarge modal-records" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>
                Edit Master Store Data
                {(() => {
                  const parts: string[] = [];
                  if (masterBrandFilter) {
                    parts.push(masterBrandFilter);
                  }
                  if (masterCountryFilter.trim()) parts.push(masterCountryFilter.trim());
                  if (masterPremiumOnly) parts.push('Premium only');
                  return parts.length ? ` – ${parts.join(' · ')}` : ' – All stores';
                })()}
              </h2>
              <button className="modal-close" onClick={() => setShowMasterRecordsModal(false)}>
                ×
              </button>
            </div>

            <div className="modal-body">
              {error && <div className="error-message">{error}</div>}
              {loadingMasterRecords ? (
                <div className="loading">Loading master store data...</div>
              ) : masterRecordsData ? (
                <>
                  <p className="records-hint">
                    Edit incorrect or missing fields below. Changes are saved to the master CSV when you click Save.
                    Stores with missing phone or address are highlighted.
                  </p>
                  <div className="records-view-toggle">
                    <button
                      type="button"
                      className={`records-view-btn ${masterRecordsViewMode === 'all' ? 'active' : ''}`}
                      onClick={() => setMasterRecordsViewMode('all')}
                    >
                      All records ({masterRecordsData.records.length})
                    </button>
                    <button
                      type="button"
                      className={`records-view-btn ${masterRecordsViewMode === 'incomplete' ? 'active' : ''}`}
                      onClick={() => setMasterRecordsViewMode('incomplete')}
                    >
                      Incomplete only ({masterIncompleteCount})
                    </button>
                  </div>
                  <div className="records-table-wrapper">
                    <table className="records-edit-table">
                      <thead>
                        <tr>
                          <th className="record-actions-col record-header-sticky">Actions</th>
                          <th className="record-warning-col record-header-sticky" title="Stores with missing phone or address">
                            <span className="record-warning-header">⚠</span>
                          </th>
                          {masterRecordsData.columns.map((col) => (
                            <th key={col} className="record-header-sticky">{col}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {displayedMasterRecords.length === 0 ? (
                          <tr>
                            <td colSpan={(masterRecordsData.columns.length + 2)} className="records-empty-state">
                              {masterRecordsViewMode === 'incomplete'
                                ? 'No records with missing phone or address.'
                                : 'No records.'}
                            </td>
                          </tr>
                        ) : displayedMasterRecords.map(({ record, originalIndex }) => {
                          const currentRecord = editedMasterRecords.get(originalIndex) ?? record;
                          const hasMissing = masterStoreHasMissingImportantData(currentRecord);
                          const isColumnIncomplete = (col: string) => {
                            if (!hasMissing) return false;
                            const val = (currentRecord[col] ?? '').trim();
                            if (col === 'Phone') return val.length === 0;
                            if (col === 'Address Line 1' || col === 'Address Line 2') {
                              const addr1 = (currentRecord['Address Line 1'] ?? '').trim();
                              const addr2 = (currentRecord['Address Line 2'] ?? '').trim();
                              return addr1.length === 0 && addr2.length === 0;
                            }
                            return false;
                          };
                          return (
                            <tr
                              key={originalIndex}
                              className={`${editedMasterRecords.has(originalIndex) ? 'row-edited' : ''} ${hasMissing ? 'row-incomplete' : ''}`}
                            >
                              <td className="record-actions-col">
                                <button
                                  type="button"
                                  className="btn-remove-record"
                                  onClick={() => handleRemoveMasterRecord(record)}
                                  title="Remove this store from master CSV"
                                >
                                  Remove
                                </button>
                              </td>
                              <td className="record-warning-col">
                                {hasMissing ? (
                                  <span
                                    className="record-warning-icon"
                                    title="Missing phone number or address"
                                  >
                                    ⚠
                                  </span>
                                ) : (
                                  <span className="record-warning-empty" />
                                )}
                              </td>
                              {masterRecordsData.columns.map((col) => (
                                <td key={col}>
                                  {col === 'Handle' ? (
                                    <span className="record-cell-readonly">{getMasterRecordValue(originalIndex, col)}</span>
                                  ) : (
                                    <input
                                      type="text"
                                      className={`record-cell-input ${isColumnIncomplete(col) ? 'record-cell-incomplete' : ''}`}
                                      value={getMasterRecordValue(originalIndex, col)}
                                      onChange={(e) => handleMasterRecordCellChange(originalIndex, col, e.target.value)}
                                    />
                                  )}
                                </td>
                              ))}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <div className="error-message">Could not load master store data</div>
              )}
            </div>

            <div className="modal-footer">
              <button
                className="btn btn-secondary"
                onClick={() => setShowMasterRecordsModal(false)}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={handleSaveMasterRecords}
                disabled={editedMasterRecords.size === 0 || savingMasterRecords}
              >
                {savingMasterRecords ? 'Saving...' : `Save ${editedMasterRecords.size} change(s) to master CSV`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Scraper;

