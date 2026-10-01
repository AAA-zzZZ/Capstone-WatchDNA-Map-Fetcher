import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { isAxiosError } from 'axios';
import {
  deleteStore,
  deleteStores,
  fetchAllStores,
  markStoresPremium,
  reconcilePremiumFlags,
  removeStoresPremium,
  type StoreRecord,
} from '../services/premium.service';
import StoreEditModal from '../components/StoreEditModal';
import ManualAddStoreModal from '../components/ManualAddStoreModal';
import StoreMergeModal from '../components/StoreMergeModal';
import '../styles/PremiumStores.css';
import { parseBrandsForDisplay, storeMatchesBrandFilter } from '../utils/brandDisplay';
import { scraperService } from '../services/scraper.service';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** True when the string contains any non-ASCII character (a heuristic for "needs translation"). */
function hasNonLatin(s: string | null | undefined): boolean {
  if (!s) return false;
  // eslint-disable-next-line no-control-regex
  return /[^\x00-\x7F]/.test(s);
}

/** English version if admin supplied one; otherwise the original (which may be in a non-Latin script). */
function displayName(store: StoreRecord): string {
  return (store.nameEn ?? '').trim() || store.name;
}

/** One street line: English if supplied, else line 1 if present, otherwise line 2. */
function primaryAddressLine(store: StoreRecord): string {
  const en = (store.addressLine1En ?? '').trim();
  if (en) return en;
  const a1 = (store.addressLine1 ?? '').trim();
  if (a1) return a1;
  return (store.addressLine2 ?? '').trim();
}

function formatAddress(store: StoreRecord): string {
  const street = primaryAddressLine(store);
  const city = ((store.cityEn ?? '').trim() || (store.city ?? '').trim());
  const stateRaw = (store.stateProvinceRegion ?? '').trim();
  // Same text in city + state (e.g. "Dubai" as emirate and city) — show once.
  const state =
    stateRaw && (!city || stateRaw.toLowerCase() !== city.toLowerCase())
      ? stateRaw
      : undefined;
  const parts = [
    street || undefined,
    city || undefined,
    state,
    store.postalCode,
    store.country,
  ].filter(Boolean);
  return parts.join(', ');
}

/** Non-Latin original form of address, if different from the displayed English form — used as a secondary line. */
function originalAddressIfDifferent(store: StoreRecord): string | null {
  const hasEnglishSubstitute =
    ((store.addressLine1En ?? '').trim() !== '' && hasNonLatin(store.addressLine1)) ||
    ((store.cityEn ?? '').trim() !== '' && hasNonLatin(store.city));
  if (!hasEnglishSubstitute) return null;
  const street = (store.addressLine1 ?? '').trim() || (store.addressLine2 ?? '').trim();
  const parts = [street || undefined, (store.city ?? '').trim() || undefined].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
}

interface BulkPremiumRow {
  handle: string;
  name: string;
  city: string;
  isVerifiedDealer: boolean;
  isBoutique: boolean;
  isServiceCenter: boolean;
}

// ── Sub-components ────────────────────────────────────────────────────────────

interface StoreCardProps {
  store: StoreRecord;
  selected: boolean;
  onToggle: (handle: string) => void;
  onEdit: (store: StoreRecord) => void;
  onDelete: (store: StoreRecord) => void;
}

const StoreCard: React.FC<StoreCardProps> = React.memo(({
  store,
  selected,
  onToggle,
  onEdit,
  onDelete,
}) => {
  const brands = parseBrandsForDisplay(store.brands);
  const primaryName = displayName(store);
  const originalName = store.name;
  const showOriginalName = primaryName !== originalName;
  const originalAddress = originalAddressIfDifferent(store);
  return (
    <div
      className={`store-card${selected ? ' selected' : ''}`}
      onClick={() => onToggle(store.handle)}
      role="checkbox"
      aria-checked={selected}
      tabIndex={0}
      onKeyDown={(e) => e.key === ' ' && onToggle(store.handle)}
    >
      <button
        type="button"
        className="store-card__edit"
        onClick={(e) => {
          e.stopPropagation();
          onEdit(store);
        }}
        onKeyDown={(e) => e.stopPropagation()}
      >
        Edit
      </button>
      <button
        type="button"
        className="store-card__delete"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(store);
        }}
        onKeyDown={(e) => e.stopPropagation()}
      >
        Delete
      </button>
      <div className="store-card__check">
        <svg className="store-card__check-icon" viewBox="0 0 12 12" fill="none">
          <polyline points="2,6 5,9 10,3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      <div className="store-card__top">
        <span className="store-card__name">{primaryName}</span>
        <div className="store-card__badges">
          <span
            className={`badge badge-store-type${store.isPremium ? ' badge-store-type--verified' : ''}`}
          >
            {store.storeType}
          </span>
        </div>
      </div>

      {showOriginalName && (
        <div
          className="store-card__original-name"
          style={{ fontSize: '0.85em', color: '#6b7280', marginTop: '-4px' }}
          title="Original (local-language) name"
        >
          {originalName}
        </div>
      )}

      <div className="store-card__address">{formatAddress(store)}</div>

      {originalAddress && (
        <div
          className="store-card__original-address"
          style={{ fontSize: '0.85em', color: '#6b7280' }}
          title="Original (local-language) address"
        >
          {originalAddress}
        </div>
      )}

      {store.phone && (
        <div className="store-card__phone">{store.phone}</div>
      )}

      {brands.length > 0 && (
        <div className="store-card__brands">
          {brands.map((b) => (
            <span key={b} className="brand-pill">{b}</span>
          ))}
        </div>
      )}
    </div>
  );
});

// ── Main page ────────────────────────────────────────────────────────────────

interface Toast {
  message: string;
  type: 'success' | 'error';
}

type DeleteConfirmState =
  | { open: false; handles: []; label: ''; count: 0 }
  | { open: true; handles: string[]; label: string; count: number };

const AUTOCOMPLETE_LIMIT = 8;

const PremiumStores: React.FC = () => {
  const [stores, setStores] = useState<StoreRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [searchText, setSearchText] = useState('');
  const [selectedBrand, setSelectedBrand] = useState('');
  const [selectedCountry, setSelectedCountry] = useState('');
  /** When any is checked, list only stores that match at least one selected category (OR). */
  const [filterDealer, setFilterDealer] = useState(false);
  const [filterBoutique, setFilterBoutique] = useState(false);
  const [filterService, setFilterService] = useState(false);

  const [selectedHandles, setSelectedHandles] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmState>({
    open: false,
    handles: [],
    label: '',
    count: 0,
  });

  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const autocompleteRef = useRef<HTMLUListElement>(null);

  const [editingStore, setEditingStore] = useState<StoreRecord | null>(null);
  const [manualAddOpen, setManualAddOpen] = useState(false);

  const [bulkPremiumOpen, setBulkPremiumOpen] = useState(false);
  const [bulkPremiumRows, setBulkPremiumRows] = useState<BulkPremiumRow[]>([]);
  const [bulkPremiumSubmitting, setBulkPremiumSubmitting] = useState(false);

  const [mergeModalOpen, setMergeModalOpen] = useState(false);

  const [apiCountries, setApiCountries] = useState<string[]>([]);

  // Load all stores and the normalized country list on mount
  useEffect(() => {
    scraperService.getMasterCsvCountries().then(setApiCountries).catch(() => {});

    fetchAllStores()
      .then(setStores)
      .catch((err: unknown) => {
        if (isAxiosError(err)) {
          const status = err.response?.status;
          const data = err.response?.data;
          const detail =
            data && typeof data === 'object' && data !== null && 'error' in data
              ? String((data as { error: unknown }).error)
              : err.message;
          if (status === 401) {
            setError('Session expired or not signed in. Please log in again.');
            return;
          }
          setError(
            `Failed to load stores (${status ?? 'network'}): ${detail}. Check that the admin API URL is correct and the backend is running.`
          );
          return;
        }
        setError('Failed to load stores. Please refresh the page.');
      })
      .finally(() => setLoading(false));
  }, []);

  // Dismiss toast after 3 s
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(id);
  }, [toast]);

  // Close autocomplete when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        searchRef.current &&
        !searchRef.current.contains(e.target as Node) &&
        autocompleteRef.current &&
        !autocompleteRef.current.contains(e.target as Node)
      ) {
        setShowAutocomplete(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // ── Derived filter options ────────────────────────────────────────────────

  const allBrands = useMemo(() => {
    const set = new Set<string>();
    stores.forEach((s) => {
      parseBrandsForDisplay(s.brands).forEach((b) => set.add(b));
      parseBrandsForDisplay(s.customBrands).forEach((b) => set.add(b));
      (s.premiumFilterBrands || []).forEach((b) => {
        const normalized = String(b || '').trim().toUpperCase();
        if (normalized) set.add(normalized);
      });
    });
    return Array.from(set).sort();
  }, [stores]);

  // Use the API-sourced normalized country list; fall back to raw store countries if the API call failed.
  const allCountries = useMemo(() => {
    if (apiCountries.length > 0) return apiCountries;
    const set = new Set<string>();
    stores.forEach((s) => s.country && set.add(s.country));
    return Array.from(set).sort();
  }, [apiCountries, stores]);

  // ── Filtered stores ───────────────────────────────────────────────────────

  const filteredStores = useMemo(() => {
    const query = searchText.trim().toLowerCase();
    const categoryOn = filterDealer || filterBoutique || filterService;
    return stores.filter((s) => {
      if (categoryOn) {
        const match =
          (filterDealer && s.isVerifiedDealer) ||
          (filterBoutique && s.isBoutique) ||
          (filterService && s.isServiceCenter);
        if (!match) return false;
      }
      if (
        selectedBrand &&
        !storeMatchesBrandFilter(s.brands, selectedBrand) &&
        !storeMatchesBrandFilter(s.customBrands, selectedBrand) &&
        !storeMatchesBrandFilter((s.premiumFilterBrands || []).join(', '), selectedBrand)
      )
        return false;
      if (selectedCountry && s.country !== selectedCountry) return false;
      if (query) {
        const haystack = `${s.name} ${s.nameEn ?? ''} ${s.addressLine1En ?? ''} ${s.cityEn ?? ''} ${formatAddress(s)}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  }, [stores, searchText, selectedBrand, selectedCountry, filterDealer, filterBoutique, filterService]);

  // ── Autocomplete suggestions ──────────────────────────────────────────────

  const autocompleteSuggestions = useMemo(() => {
    const query = searchText.trim().toLowerCase();
    if (!query) return [];
    return stores
      .filter((s) => {
        const nameLower = `${s.name} ${s.nameEn ?? ''}`.toLowerCase();
        const addrLower = `${formatAddress(s)} ${s.addressLine1En ?? ''} ${s.cityEn ?? ''}`.toLowerCase();
        return nameLower.includes(query) || addrLower.includes(query);
      })
      .slice(0, AUTOCOMPLETE_LIMIT);
  }, [stores, searchText]);

  // ── Selection helpers ─────────────────────────────────────────────────────

  const toggleHandle = useCallback((handle: string) => {
    setSelectedHandles((prev) => {
      const next = new Set(prev);
      if (next.has(handle)) next.delete(handle);
      else next.add(handle);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedHandles(new Set());
  }, []);

  const removeFromSelection = useCallback((handle: string) => {
    setSelectedHandles((prev) => {
      const next = new Set(prev);
      next.delete(handle);
      return next;
    });
  }, []);

  const selectedStores = useMemo(
    () => stores.filter((s) => selectedHandles.has(s.handle)),
    [stores, selectedHandles]
  );

  const nonPremiumSelected = useMemo(
    () => selectedStores.filter((s) => !s.isPremium),
    [selectedStores]
  );

  const premiumSelected = useMemo(
    () => selectedStores.filter((s) => s.isPremium),
    [selectedStores]
  );

  const premiumCount = useMemo(
    () => stores.filter((s) => s.isPremium).length,
    [stores]
  );

  // ── Actions ───────────────────────────────────────────────────────────────

  const openBulkPremiumModal = useCallback(() => {
    const rows: BulkPremiumRow[] = nonPremiumSelected.map((s) => ({
      handle: s.handle,
      name: displayName(s),
      city: ((s.cityEn ?? '').trim() || (s.city ?? '').trim()),
      isVerifiedDealer: true,
      isBoutique: false,
      isServiceCenter: false,
    }));
    setBulkPremiumRows(rows);
    setBulkPremiumOpen(true);
  }, [nonPremiumSelected]);

  const updateBulkPremiumRow = useCallback((handle: string, patch: Partial<BulkPremiumRow>) => {
    setBulkPremiumRows((prev) =>
      prev.map((r) => (r.handle === handle ? { ...r, ...patch } : r))
    );
  }, []);

  const handleConfirmBulkPremium = async () => {
    if (bulkPremiumRows.length === 0) return;
    setBulkPremiumSubmitting(true);
    try {
      const entries = bulkPremiumRows.map((r) => ({
        handle: r.handle,
        isVerifiedDealer: r.isVerifiedDealer,
        isBoutique: r.isBoutique,
        isServiceCenter: r.isServiceCenter,
      }));
      const result = await markStoresPremium(entries);
      const storesFresh = await fetchAllStores();
      setStores(storesFresh);
      setSelectedHandles(new Set());
      setBulkPremiumOpen(false);
      setBulkPremiumRows([]);
      setToast({ message: `${result.marked} store(s) marked as verified authorized dealer.`, type: 'success' });
    } catch {
      setToast({ message: 'Failed to mark stores as verified. Please try again.', type: 'error' });
    } finally {
      setBulkPremiumSubmitting(false);
    }
  };

  const handleRemovePremium = async () => {
    const handles = premiumSelected.map((s) => s.handle);
    if (handles.length === 0) return;
    setSubmitting(true);
    try {
      const result = await removeStoresPremium(handles);
      const storesFresh = await fetchAllStores();
      setStores(storesFresh);
      setSelectedHandles(new Set());
      setToast({ message: `Verified listing removed from ${result.removed} store(s).`, type: 'success' });
    } catch {
      setToast({ message: 'Failed to remove verified listing. Please try again.', type: 'error' });
    } finally {
      setSubmitting(false);
    }
  };

  const openSingleDeleteConfirm = useCallback((store: StoreRecord) => {
    setDeleteConfirm({
      open: true,
      handles: [store.handle],
      label: displayName(store),
      count: 1,
    });
  }, []);

  const openBulkDeleteConfirm = useCallback(() => {
    if (selectedStores.length === 0) return;
    const handles = selectedStores.map((s) => s.handle);
    setDeleteConfirm({
      open: true,
      handles,
      label: `${handles.length} selected stores`,
      count: handles.length,
    });
  }, [selectedStores]);

  const closeDeleteConfirm = useCallback(() => {
    if (deleting) return;
    setDeleteConfirm({ open: false, handles: [], label: '', count: 0 });
  }, [deleting]);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteConfirm.open || deleteConfirm.handles.length === 0) return;
    setDeleting(true);
    try {
      if (deleteConfirm.count === 1) {
        await deleteStore(deleteConfirm.handles[0]);
      } else {
        await deleteStores(deleteConfirm.handles);
      }
      const storesFresh = await fetchAllStores();
      setStores(storesFresh);
      setSelectedHandles((prev) => {
        const next = new Set(prev);
        deleteConfirm.handles.forEach((handle) => next.delete(handle));
        return next;
      });
      setDeleteConfirm({ open: false, handles: [], label: '', count: 0 });
      setToast({
        message:
          deleteConfirm.count === 1
            ? 'Store deleted from database.'
            : `${deleteConfirm.handles.length} stores deleted from database.`,
        type: 'success',
      });
    } catch {
      setToast({ message: 'Failed to delete store(s) from database.', type: 'error' });
    } finally {
      setDeleting(false);
    }
  }, [deleteConfirm]);

  const handleReconcilePremium = async () => {
    setReconciling(true);
    try {
      const result = await reconcilePremiumFlags();
      const storesFresh = await fetchAllStores();
      setStores(storesFresh);
      setToast({
        message: `Premium flags synced: ${result.setTrueCount} set to premium, ${result.setFalseCount} cleared.`,
        type: 'success',
      });
    } catch {
      setToast({ message: 'Failed to reconcile premium flags.', type: 'error' });
    } finally {
      setReconciling(false);
    }
  };

  const resetFilters = () => {
    setSearchText('');
    setSelectedBrand('');
    setSelectedCountry('');
    setFilterDealer(false);
    setFilterBoutique(false);
    setFilterService(false);
  };

  const handleCardEdit = useCallback((store: StoreRecord) => {
    setEditingStore(store);
  }, []);

  const handleEditClose = useCallback(() => {
    setEditingStore(null);
  }, []);

  const handleEditSaved = useCallback((updated: StoreRecord) => {
    setStores((prev) => prev.map((s) => (s.handle === updated.handle ? updated : s)));
    setEditingStore(null);
  }, []);

  const handleEditStoreSynced = useCallback((updated: StoreRecord) => {
    setStores((prev) => prev.map((s) => (s.handle === updated.handle ? updated : s)));
    setEditingStore(updated);
  }, []);

  const handleManualAddSuccess = useCallback(() => {
    fetchAllStores()
      .then(setStores)
      .catch(() => setToast({ message: 'Store was added but the list failed to refresh.', type: 'error' }));
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) return <div className="loading">Loading stores...</div>;
  if (error) return <div className="error">{error}</div>;

  return (
    <div className="premium-stores">
      {toast && (
        <div className={`premium-toast ${toast.type}`}>{toast.message}</div>
      )}

      <div className="premium-stores__header">
        <div className="premium-stores__header-row">
          <div className="premium-stores__header-titles">
            <h1>Premium Stores</h1>
            <span className="premium-stores__count">
              {premiumCount} verified listing
              {premiumCount === 1 ? '' : 's'} &middot; {stores.length} total
            </span>
          </div>
          <button
            type="button"
            className="premium-stores__manual-add"
            onClick={() => setManualAddOpen(true)}
          >
            Add store manually
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="premium-filters">
        <div className="premium-filter-group">
          <label>Brand</label>
          <select value={selectedBrand} onChange={(e) => setSelectedBrand(e.target.value)}>
            <option value="">All brands</option>
            {allBrands.map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
        </div>

        <div className="premium-filter-group">
          <label>Country</label>
          <select value={selectedCountry} onChange={(e) => setSelectedCountry(e.target.value)}>
            <option value="">All countries</option>
            {allCountries.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>

        <div className="premium-filter-group premium-filter-search" style={{ position: 'relative' }}>
          <label>Name or Address</label>
          <input
            ref={searchRef}
            type="text"
            placeholder="Search stores..."
            value={searchText}
            onChange={(e) => {
              setSearchText(e.target.value);
              setShowAutocomplete(true);
            }}
            onFocus={() => setShowAutocomplete(true)}
            autoComplete="off"
          />
          {showAutocomplete && autocompleteSuggestions.length > 0 && (
            <ul className="autocomplete-list" ref={autocompleteRef}>
              {autocompleteSuggestions.map((s) => (
                <li
                  key={s.handle}
                  onMouseDown={() => {
                    setSearchText(displayName(s));
                    setShowAutocomplete(false);
                  }}
                >
                  <div className="autocomplete-name">{displayName(s)}</div>
                  <div className="autocomplete-address">{formatAddress(s)}</div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="premium-filter-group premium-filter-categories" role="group" aria-label="Map category">
          <span className="premium-filter-categories__label">Map category (any match)</span>
          <div className="premium-filter-categories__row">
            <label className="premium-filter-cat">
              <input
                type="checkbox"
                checked={filterDealer}
                onChange={(e) => setFilterDealer(e.target.checked)}
              />
              Authorized dealer
            </label>
            <label className="premium-filter-cat">
              <input
                type="checkbox"
                checked={filterBoutique}
                onChange={(e) => setFilterBoutique(e.target.checked)}
              />
              Boutique
            </label>
            <label className="premium-filter-cat">
              <input
                type="checkbox"
                checked={filterService}
                onChange={(e) => setFilterService(e.target.checked)}
              />
              Service center
            </label>
          </div>
        </div>

        <button className="premium-filter-reset" onClick={resetFilters}>
          Clear filters
        </button>
      </div>

      {/* Toolbar */}
      <div className="premium-toolbar">
        <span className="premium-toolbar__info">
          Showing {filteredStores.length} store{filteredStores.length !== 1 ? 's' : ''}
          {selectedHandles.size > 0 && ` · ${selectedHandles.size} selected`}
        </span>
        <button
          type="button"
          className="premium-filter-reset"
          disabled={reconciling}
          onClick={handleReconcilePremium}
          title="Align Location.isPremium with the PremiumStore registry (e.g. after bulk imports)"
        >
          {reconciling ? 'Syncing…' : 'Reconcile premium flags'}
        </button>
      </div>

      {/* Store grid */}
      <div className="premium-grid">
        {filteredStores.length === 0 ? (
          <div className="premium-empty">No stores match your filters.</div>
        ) : (
          filteredStores.map((store) => (
            <StoreCard
              key={store.handle}
              store={store}
              selected={selectedHandles.has(store.handle)}
              onToggle={toggleHandle}
              onEdit={handleCardEdit}
              onDelete={openSingleDeleteConfirm}
            />
          ))
        )}
      </div>

      {/* Spacer so review panel doesn't cover last row */}
      {selectedHandles.size > 0 && <div className="review-panel-spacer" />}

      {/* Review panel */}
      {manualAddOpen && (
        <ManualAddStoreModal
          availableBrands={allBrands}
          onClose={() => setManualAddOpen(false)}
          onSuccess={handleManualAddSuccess}
          onToast={setToast}
        />
      )}

      {editingStore && (
        <StoreEditModal
          store={editingStore}
          availableBrands={allBrands}
          onClose={handleEditClose}
          onSaved={handleEditSaved}
          onStoreSynced={handleEditStoreSynced}
          onToast={setToast}
        />
      )}

      {mergeModalOpen && selectedStores.length >= 2 && (
        <StoreMergeModal
          stores={selectedStores}
          onClose={() => setMergeModalOpen(false)}
          onMerged={(store) => {
            setStores((prev) => {
              const handles = new Set(selectedStores.map((s) => s.handle));
              const rest = prev.filter((s) => !handles.has(s.handle));
              return [...rest, store].sort((a, b) => a.name.localeCompare(b.name));
            });
            setSelectedHandles(new Set([store.handle]));
          }}
          onToast={setToast}
        />
      )}

      {bulkPremiumOpen && (
        <div
          className="store-edit-overlay bulk-premium-overlay"
          onClick={() => !bulkPremiumSubmitting && setBulkPremiumOpen(false)}
          role="presentation"
        >
          <div
            className="store-edit-modal bulk-premium-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="bulk-premium-title"
          >
            <div className="store-edit-modal__header">
              <h2 id="bulk-premium-title">Mark stores as verified authorized dealer</h2>
              <button
                type="button"
                className="store-edit-modal__close"
                onClick={() => !bulkPremiumSubmitting && setBulkPremiumOpen(false)}
                disabled={bulkPremiumSubmitting}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="store-edit-modal__body bulk-premium-modal__body">
              <p className="store-edit-hint bulk-premium-hint">
                Choose which premium categories apply to each store. At least one category must be checked per store for it to appear as a verified listing on the public map.
              </p>
              <div className="bulk-premium-table-wrap">
                <table className="bulk-premium-table">
                  <thead>
                    <tr>
                      <th scope="col">Store</th>
                      <th scope="col">Location</th>
                      <th scope="col">Authorized dealer</th>
                      <th scope="col">Boutique</th>
                      <th scope="col">Service center</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bulkPremiumRows.map((r) => (
                      <tr key={r.handle}>
                        <td>
                          <div className="bulk-premium-store-name">{r.name}</div>
                          <div className="bulk-premium-store-handle">{r.handle}</div>
                        </td>
                        <td>{r.city || '—'}</td>
                        <td>
                          <label className="bulk-premium-checkbox">
                            <input
                              type="checkbox"
                              checked={r.isVerifiedDealer}
                              onChange={(e) =>
                                updateBulkPremiumRow(r.handle, { isVerifiedDealer: e.target.checked })
                              }
                              disabled={bulkPremiumSubmitting}
                            />
                            <span>Yes</span>
                          </label>
                        </td>
                        <td>
                          <label className="bulk-premium-checkbox">
                            <input
                              type="checkbox"
                              checked={r.isBoutique}
                              onChange={(e) =>
                                updateBulkPremiumRow(r.handle, { isBoutique: e.target.checked })
                              }
                              disabled={bulkPremiumSubmitting}
                            />
                            <span>Yes</span>
                          </label>
                        </td>
                        <td>
                          <label className="bulk-premium-checkbox">
                            <input
                              type="checkbox"
                              checked={r.isServiceCenter}
                              onChange={(e) =>
                                updateBulkPremiumRow(r.handle, { isServiceCenter: e.target.checked })
                              }
                              disabled={bulkPremiumSubmitting}
                            />
                            <span>Yes</span>
                          </label>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="store-edit-modal__footer">
              <button
                type="button"
                className="store-edit-btn store-edit-btn--secondary"
                onClick={() => !bulkPremiumSubmitting && setBulkPremiumOpen(false)}
                disabled={bulkPremiumSubmitting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="store-edit-btn store-edit-btn--primary"
                onClick={handleConfirmBulkPremium}
                disabled={bulkPremiumSubmitting || bulkPremiumRows.length === 0}
              >
                {bulkPremiumSubmitting ? 'Saving…' : `Confirm (${bulkPremiumRows.length})`}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteConfirm.open && (
        <div
          className="store-edit-overlay delete-confirm-overlay"
          onClick={closeDeleteConfirm}
          role="presentation"
        >
          <div
            className="store-edit-modal delete-confirm-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-confirm-title"
          >
            <div className="store-edit-modal__header">
              <h2 id="delete-confirm-title">Delete from database</h2>
              <button
                type="button"
                className="store-edit-modal__close"
                onClick={closeDeleteConfirm}
                disabled={deleting}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="store-edit-modal__body delete-confirm-modal__body">
              <p className="delete-confirm-warning">
                This will permanently remove{' '}
                <strong>{deleteConfirm.count === 1 ? deleteConfirm.label : `${deleteConfirm.count} stores`}</strong>{' '}
                from the database. This cannot be undone.
              </p>
              <p className="delete-confirm-subtext">
                Use this only for bad data or duplicates that were not caught.
              </p>
            </div>
            <div className="store-edit-modal__footer">
              <button
                type="button"
                className="store-edit-btn store-edit-btn--secondary"
                onClick={closeDeleteConfirm}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="store-edit-btn delete-confirm-btn"
                onClick={handleConfirmDelete}
                disabled={deleting}
              >
                {deleting
                  ? 'Deleting...'
                  : deleteConfirm.count === 1
                    ? 'Yes, delete store'
                    : `Yes, delete ${deleteConfirm.count} stores`}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className={`review-panel${selectedHandles.size > 0 ? ' visible' : ''}`}>
        <div className="review-panel__inner">
          <div>
            <div className="review-panel__title">{selectedHandles.size} store{selectedHandles.size !== 1 ? 's' : ''} selected</div>
            <button className="btn-clear-selection" onClick={clearSelection}>
              Clear selection
            </button>
          </div>

          <div className="review-panel__list">
            {selectedStores.map((s) => (
              <span key={s.handle} className="review-chip">
                {s.isPremium && (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="#f59e0b">
                    <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                  </svg>
                )}
                <span title={s.name}>{displayName(s)}</span>
                <button
                  className="review-chip__remove"
                  onClick={(e) => { e.stopPropagation(); removeFromSelection(s.handle); }}
                  title="Remove from selection"
                >
                  ×
                </button>
              </span>
            ))}
          </div>

          <div className="review-panel__actions">
            {selectedStores.length >= 2 && (
              <button
                type="button"
                className="btn-merge-stores"
                onClick={() => setMergeModalOpen(true)}
                disabled={submitting}
              >
                Merge duplicates…
              </button>
            )}
            {nonPremiumSelected.length > 0 && (
              <button
                type="button"
                className="btn-mark-premium"
                onClick={openBulkPremiumModal}
                disabled={submitting || deleting}
              >
                Mark {nonPremiumSelected.length} as verified authorized dealer…
              </button>
            )}
            {premiumSelected.length > 0 && (
              <button
                className="btn-remove-premium"
                onClick={handleRemovePremium}
                disabled={submitting || deleting}
              >
                {submitting ? 'Saving...' : `Remove verified listing (${premiumSelected.length})`}
              </button>
            )}
            {selectedStores.length > 0 && (
              <button
                type="button"
                className="btn-delete-stores"
                onClick={openBulkDeleteConfirm}
                disabled={submitting || deleting}
              >
                Delete from database ({selectedStores.length})
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default PremiumStores;
