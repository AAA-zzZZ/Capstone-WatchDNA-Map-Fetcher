import api from './api';

export interface AnalyticsSummary {
  totalEvents: number;
  uniqueSessions: number;
  eventsToday: number;
  periodDays: number;
}

export interface RetailerStat {
  storeId: string;
  storeName: string;
  taps: number;
  phoneTaps: number;
  directionTaps: number;
  websiteTaps: number;
}

export interface BrandStat {
  brand: string;
  searches: number;
  views: number;
}

export interface ActionStats {
  phoneTaps: number;
  directionTaps: number;
  websiteTaps: number;
  emailTaps: number;
}

export interface SourceStats {
  storeLocator: number;
  searchDirectory: number;
}

export interface DailyStat {
  date: string;
  count: number;
}

const analyticsApi = {
  getSummary: (days = 30) =>
    api.get<AnalyticsSummary>(`/analytics/summary?days=${days}`),

  getRetailers: (days = 30) =>
    api.get<RetailerStat[]>(`/analytics/retailers?days=${days}`),

  getBrands: (days = 30) =>
    api.get<BrandStat[]>(`/analytics/brands?days=${days}`),

  getActions: (days = 30) =>
    api.get<ActionStats>(`/analytics/actions?days=${days}`),

  getSources: (days = 30) =>
    api.get<SourceStats>(`/analytics/sources?days=${days}`),

  getDaily: (days = 30) =>
    api.get<DailyStat[]>(`/analytics/daily?days=${days}`),
};

export default analyticsApi;
