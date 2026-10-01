import React, { useState, useEffect } from 'react';
import analyticsApi from '../services/analytics.service';
import type {
  AnalyticsSummary,
  RetailerStat,
  BrandStat,
  ActionStats,
  SourceStats,
  DailyStat,
} from '../services/analytics.service';
import '../styles/AppAnalytics.css';

const PERIOD_OPTIONS = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
];

const AppAnalytics: React.FC = () => {
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);

  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [retailers, setRetailers] = useState<RetailerStat[]>([]);
  const [brands, setBrands] = useState<BrandStat[]>([]);
  const [actions, setActions] = useState<ActionStats | null>(null);
  const [sources, setSources] = useState<SourceStats | null>(null);
  const [daily, setDaily] = useState<DailyStat[]>([]);

  useEffect(() => {
    loadData(days);
  }, [days]);

  const loadData = async (d: number) => {
    setLoading(true);
    try {
      const [summaryRes, retailersRes, brandsRes, actionsRes, sourcesRes, dailyRes] =
        await Promise.all([
          analyticsApi.getSummary(d),
          analyticsApi.getRetailers(d),
          analyticsApi.getBrands(d),
          analyticsApi.getActions(d),
          analyticsApi.getSources(d),
          analyticsApi.getDaily(d),
        ]);

      setSummary(summaryRes.data);
      setRetailers(retailersRes.data);
      setBrands(brandsRes.data);
      setActions(actionsRes.data);
      setSources(sourcesRes.data);
      setDaily(dailyRes.data);
    } catch (error) {
      console.error('Failed to load analytics:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return <div className="analytics-loading">Loading analytics...</div>;
  }

  const maxDaily = Math.max(...daily.map((d) => d.count), 1);
  const totalActions = actions
    ? actions.phoneTaps + actions.directionTaps + actions.websiteTaps + actions.emailTaps
    : 0;
  const totalSources = sources ? sources.storeLocator + sources.searchDirectory : 0;

  return (
    <div className="analytics">
      <div className="analytics-header">
        <h1>App Analytics</h1>
        <div className="period-selector">
          {PERIOD_OPTIONS.map((opt) => (
            <button
              key={opt.days}
              className={`period-btn ${days === opt.days ? 'active' : ''}`}
              onClick={() => setDays(opt.days)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Summary cards */}
      <div className="analytics-stats">
        <div className="analytics-stat-card">
          <div className="analytics-stat-value">{summary?.totalEvents.toLocaleString() || 0}</div>
          <div className="analytics-stat-label">Total Events</div>
        </div>
        <div className="analytics-stat-card">
          <div className="analytics-stat-value">{summary?.uniqueSessions.toLocaleString() || 0}</div>
          <div className="analytics-stat-label">Unique Sessions</div>
        </div>
        <div className="analytics-stat-card">
          <div className="analytics-stat-value">{summary?.eventsToday.toLocaleString() || 0}</div>
          <div className="analytics-stat-label">Events Today</div>
        </div>
        <div className="analytics-stat-card">
          <div className="analytics-stat-value">{totalActions.toLocaleString()}</div>
          <div className="analytics-stat-label">Contact Actions</div>
        </div>
      </div>

      {/* Daily activity chart */}
      <div className="analytics-panel full-width" style={{ marginBottom: '1.5rem' }}>
        <h2>Daily Activity</h2>
        {daily.length > 0 ? (
          <>
            <div className="daily-chart">
              {daily.map((d) => (
                <div key={d.date} className="daily-bar-wrapper">
                  <div
                    className="daily-bar"
                    style={{ height: `${(d.count / maxDaily) * 100}%` }}
                  >
                    <span className="daily-bar-tooltip">
                      {d.date}: {d.count} events
                    </span>
                  </div>
                </div>
              ))}
            </div>
            <div className="daily-chart-labels">
              <span>{daily[0]?.date}</span>
              <span>{daily[daily.length - 1]?.date}</span>
            </div>
          </>
        ) : (
          <div className="analytics-empty">
            <p>No activity data yet</p>
          </div>
        )}
      </div>

      <div className="analytics-grid">
        {/* Top Retailers */}
        <div className="analytics-panel">
          <h2>Top Retailers</h2>
          {retailers.length > 0 ? (
            <table className="analytics-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Retailer</th>
                  <th>Taps</th>
                  <th>Phone</th>
                  <th>Dir.</th>
                  <th>Web</th>
                </tr>
              </thead>
              <tbody>
                {retailers.slice(0, 15).map((r, i) => (
                  <tr key={r.storeId}>
                    <td className="rank">{i + 1}</td>
                    <td>{r.storeName}</td>
                    <td className="count">{r.taps}</td>
                    <td className="count">{r.phoneTaps}</td>
                    <td className="count">{r.directionTaps}</td>
                    <td className="count">{r.websiteTaps}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="analytics-empty">
              <p>No retailer data yet</p>
            </div>
          )}
        </div>

        {/* Top Searched Brands */}
        <div className="analytics-panel">
          <h2>Top Searched Brands</h2>
          {brands.length > 0 ? (
            <table className="analytics-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Brand</th>
                  <th>Searches</th>
                  <th>Views</th>
                </tr>
              </thead>
              <tbody>
                {brands.slice(0, 15).map((b, i) => (
                  <tr key={b.brand}>
                    <td className="rank">{i + 1}</td>
                    <td style={{ textTransform: 'capitalize' }}>{b.brand}</td>
                    <td className="count">{b.searches}</td>
                    <td className="count">{b.views}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="analytics-empty">
              <p>No brand data yet</p>
            </div>
          )}
        </div>

        {/* Action Breakdown */}
        <div className="analytics-panel">
          <h2>Contact Actions Breakdown</h2>
          {totalActions > 0 ? (
            <div className="action-bars">
              {[
                { label: 'Phone', count: actions!.phoneTaps, cls: 'phone' },
                { label: 'Directions', count: actions!.directionTaps, cls: 'directions' },
                { label: 'Website', count: actions!.websiteTaps, cls: 'website' },
                { label: 'Email', count: actions!.emailTaps, cls: 'email' },
              ].map((a) => (
                <div key={a.cls} className="action-bar-row">
                  <span className="action-bar-label">{a.label}</span>
                  <div className="action-bar-track">
                    <div
                      className={`action-bar-fill ${a.cls}`}
                      style={{ width: `${(a.count / totalActions) * 100}%` }}
                    >
                      {a.count > 0 ? a.count : ''}
                    </div>
                  </div>
                  <span className="action-bar-count">{a.count}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="analytics-empty">
              <p>No action data yet</p>
            </div>
          )}
        </div>

        {/* Traffic Source */}
        <div className="analytics-panel">
          <h2>Traffic Source</h2>
          {totalSources > 0 ? (
            <div className="source-split">
              <div className="source-block">
                <div className="source-value">{sources!.storeLocator}</div>
                <div className="source-label">Store Locator</div>
                <div className="source-pct">
                  {((sources!.storeLocator / totalSources) * 100).toFixed(1)}%
                </div>
              </div>
              <div className="source-block">
                <div className="source-value">{sources!.searchDirectory}</div>
                <div className="source-label">Search Directory</div>
                <div className="source-pct">
                  {((sources!.searchDirectory / totalSources) * 100).toFixed(1)}%
                </div>
              </div>
            </div>
          ) : (
            <div className="analytics-empty">
              <p>No source data yet</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default AppAnalytics;
