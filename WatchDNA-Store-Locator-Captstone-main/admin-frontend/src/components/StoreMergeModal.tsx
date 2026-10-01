import { useCallback, useEffect, useMemo, useState } from 'react';
import type { StoreRecord } from '../services/premium.service';
import { mergePremiumStores } from '../services/premium.service';
import { parseBrandsForDisplay } from '../utils/brandDisplay';

export type StoreMergeToast = { message: string; type: 'success' | 'error' };

type MergeTextFieldKey =
  | 'name'
  | 'nameEn'
  | 'addressLine1'
  | 'addressLine1En'
  | 'addressLine2'
  | 'city'
  | 'cityEn'
  | 'stateProvinceRegion'
  | 'postalCode'
  | 'country'
  | 'phone'
  | 'website';

type FieldSource = { mode: 'store'; handle: string } | { mode: 'custom' };

const TEXT_FIELD_META: { key: MergeTextFieldKey; label: string }[] = [
  { key: 'name', label: 'Store name' },
  { key: 'nameEn', label: 'Store name (English)' },
  { key: 'addressLine1', label: 'Address line 1' },
  { key: 'addressLine1En', label: 'Address line 1 (English)' },
  { key: 'addressLine2', label: 'Address line 2' },
  { key: 'city', label: 'City' },
  { key: 'cityEn', label: 'City (English)' },
  { key: 'stateProvinceRegion', label: 'State / region' },
  { key: 'postalCode', label: 'Postal code' },
  { key: 'country', label: 'Country' },
  { key: 'phone', label: 'Phone' },
  { key: 'website', label: 'Website' },
];

function displayName(store: StoreRecord): string {
  return (store.nameEn ?? '').trim() || store.name;
}

function defaultSurvivorHandle(stores: StoreRecord[]): string {
  const sorted = [...stores].sort((a, b) => {
    if (a.isPremium !== b.isPremium) return a.isPremium ? -1 : 1;
    const ba =
      parseBrandsForDisplay(a.brands).length + parseBrandsForDisplay(a.customBrands).length;
    const bb =
      parseBrandsForDisplay(b.brands).length + parseBrandsForDisplay(b.customBrands).length;
    if (ba !== bb) return bb - ba;
    const na = displayName(a).length;
    const nb = displayName(b).length;
    if (na !== nb) return nb - na;
    return a.handle.localeCompare(b.handle);
  });
  return sorted[0]!.handle;
}

function getStoreTextField(store: StoreRecord, key: MergeTextFieldKey): string {
  switch (key) {
    case 'name':
      return store.name ?? '';
    case 'nameEn':
      return store.nameEn ?? '';
    case 'addressLine1':
      return store.addressLine1 ?? '';
    case 'addressLine1En':
      return store.addressLine1En ?? '';
    case 'addressLine2':
      return store.addressLine2 ?? '';
    case 'city':
      return store.city ?? '';
    case 'cityEn':
      return store.cityEn ?? '';
    case 'stateProvinceRegion':
      return store.stateProvinceRegion ?? '';
    case 'postalCode':
      return store.postalCode ?? '';
    case 'country':
      return store.country ?? '';
    case 'phone':
      return store.phone ?? '';
    case 'website':
      return store.website ?? '';
    default:
      return '';
  }
}

function initTextSource(keep: string): Record<MergeTextFieldKey, FieldSource> {
  const init = {} as Record<MergeTextFieldKey, FieldSource>;
  for (const { key } of TEXT_FIELD_META) init[key] = { mode: 'store', handle: keep };
  return init;
}

function initCustomText(surv: StoreRecord): Record<MergeTextFieldKey, string> {
  const init = {} as Record<MergeTextFieldKey, string>;
  for (const { key } of TEXT_FIELD_META) init[key] = getStoreTextField(surv, key);
  return init;
}

interface StoreMergeModalProps {
  stores: StoreRecord[];
  onClose: () => void;
  onMerged: (store: StoreRecord) => void;
  onToast: (t: StoreMergeToast) => void;
}

export default function StoreMergeModal({ stores, onClose, onMerged, onToast }: StoreMergeModalProps) {
  const byHandle = useMemo(() => new Map(stores.map((s) => [s.handle, s] as const)), [stores]);
  const defaultKeep = useMemo(() => defaultSurvivorHandle(stores), [stores]);

  const [keepHandle, setKeepHandle] = useState(defaultKeep);
  const [step, setStep] = useState<1 | 2>(1);
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [textSource, setTextSource] = useState<Record<MergeTextFieldKey, FieldSource>>(() =>
    initTextSource(defaultKeep)
  );
  const [customText, setCustomText] = useState<Record<MergeTextFieldKey, string>>(() => {
    const surv = stores.find((s) => s.handle === defaultKeep)!;
    return initCustomText(surv);
  });

  const [coordSource, setCoordSource] = useState<FieldSource>(() => ({
    mode: 'store',
    handle: defaultKeep,
  }));
  const [customLat, setCustomLat] = useState(() => {
    const s = stores.find((x) => x.handle === defaultKeep)!;
    return String(s.latitude);
  });
  const [customLng, setCustomLng] = useState(() => {
    const s = stores.find((x) => x.handle === defaultKeep)!;
    return String(s.longitude);
  });

  useEffect(() => {
    const surv = byHandle.get(keepHandle);
    if (!surv) return;
    setTextSource((prev) => {
      const next = { ...prev };
      for (const { key } of TEXT_FIELD_META) {
        if (next[key].mode === 'store') next[key] = { mode: 'store', handle: keepHandle };
      }
      return next;
    });
    setCoordSource((prev) => {
      if (prev.mode === 'store') return { mode: 'store', handle: keepHandle };
      return prev;
    });
  }, [keepHandle, byHandle]);

  useEffect(() => {
    if (coordSource.mode !== 'store') return;
    const st = byHandle.get(coordSource.handle);
    if (st) {
      setCustomLat(String(st.latitude));
      setCustomLng(String(st.longitude));
    }
  }, [keepHandle, byHandle, coordSource]);

  const brandPreview = useMemo(() => {
    const set = new Set<string>();
    for (const s of stores) {
      parseBrandsForDisplay(s.brands).forEach((b) => set.add(b));
      parseBrandsForDisplay(s.customBrands).forEach((b) => set.add(b));
    }
    return Array.from(set).sort();
  }, [stores]);

  const otherHandles = useMemo(
    () => stores.filter((s) => s.handle !== keepHandle).map((s) => s.handle),
    [stores, keepHandle]
  );

  const resolvedText = useCallback(
    (key: MergeTextFieldKey): string => {
      const src = textSource[key];
      if (src.mode === 'store') {
        const st = byHandle.get(src.handle);
        return st ? getStoreTextField(st, key) : '';
      }
      return customText[key];
    },
    [textSource, customText, byHandle]
  );

  const resolvedLatLng = useCallback(() => {
    if (coordSource.mode === 'store') {
      const st = byHandle.get(coordSource.handle);
      if (!st) return { lat: NaN, lng: NaN };
      return { lat: st.latitude, lng: st.longitude };
    }
    return { lat: parseFloat(customLat), lng: parseFloat(customLng) };
  }, [coordSource, byHandle, customLat, customLng]);

  const buildPayload = useCallback(() => {
    const { lat, lng } = resolvedLatLng();
    const name = resolvedText('name');
    const nameEnRaw = resolvedText('nameEn').trim();
    const addressLine1 = resolvedText('addressLine1');
    const addressLine1EnRaw = resolvedText('addressLine1En').trim();
    const addressLine2Raw = resolvedText('addressLine2').trim();
    const city = resolvedText('city');
    const cityEnRaw = resolvedText('cityEn').trim();
    const stateRaw = resolvedText('stateProvinceRegion').trim();
    const postalRaw = resolvedText('postalCode').trim();
    const country = resolvedText('country');
    const phoneRaw = resolvedText('phone').trim();
    const websiteRaw = resolvedText('website').trim();

    return {
      keepHandle,
      otherHandles,
      mergedStore: {
        name,
        nameEn: nameEnRaw ? nameEnRaw : null,
        addressLine1,
        addressLine1En: addressLine1EnRaw ? addressLine1EnRaw : null,
        addressLine2: addressLine2Raw ? addressLine2Raw : null,
        city,
        cityEn: cityEnRaw ? cityEnRaw : null,
        stateProvinceRegion: stateRaw ? stateRaw : null,
        postalCode: postalRaw ? postalRaw : null,
        country,
        phone: phoneRaw ? phoneRaw : null,
        website: websiteRaw ? websiteRaw : null,
        latitude: lat,
        longitude: lng,
      },
    };
  }, [keepHandle, otherHandles, resolvedText, resolvedLatLng]);

  const canProceedStep2 = useMemo(() => {
    const { mergedStore: m } = buildPayload();
    if (!m.name.trim() || !m.addressLine1.trim() || !m.city.trim() || !m.country.trim()) return false;
    if (!Number.isFinite(m.latitude) || !Number.isFinite(m.longitude)) return false;
    if (m.latitude < -90 || m.latitude > 90 || m.longitude < -180 || m.longitude > 180) return false;
    return true;
  }, [buildPayload]);

  const handleFieldSourceChange = (key: MergeTextFieldKey, src: FieldSource) => {
    if (src.mode === 'store') {
      const st = byHandle.get(src.handle);
      setCustomText((prev) => ({ ...prev, [key]: st ? getStoreTextField(st, key) : '' }));
    }
    setTextSource((prev) => ({ ...prev, [key]: src }));
  };

  const handleCoordSourceChange = (src: FieldSource) => {
    if (src.mode === 'store') {
      const st = byHandle.get(src.handle);
      if (st) {
        setCustomLat(String(st.latitude));
        setCustomLng(String(st.longitude));
      }
    }
    setCoordSource(src);
  };

  const handleSubmit = async () => {
    if (!confirmChecked || !canProceedStep2) return;
    setSubmitting(true);
    try {
      const payload = buildPayload();
      const { store, removedCount } = await mergePremiumStores(payload);
      onMerged(store);
      onToast({
        message: `Merged into one store; ${removedCount} duplicate record(s) removed.`,
        type: 'success',
      });
      onClose();
    } catch {
      onToast({ message: 'Merge failed. Check your data and try again.', type: 'error' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="store-merge-overlay" onClick={() => !submitting && onClose()} role="presentation">
      <div
        className="store-merge-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="store-merge-title"
        aria-modal="true"
      >
        <div className="store-merge-modal__header">
          <h2 id="store-merge-title">Merge duplicate stores</h2>
          <button
            type="button"
            className="store-edit-modal__close"
            onClick={() => !submitting && onClose()}
            disabled={submitting}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="store-merge-modal__body">
          <div className="store-merge-warning" role="alert">
            <strong>Destructive action.</strong> This combines {stores.length} locations into one row. The other{' '}
            {stores.length - 1} database record(s) will be <strong>permanently deleted</strong>. Brand lists are unioned
            on the server. Edit opening hours after the merge if needed.
          </div>

          {step === 1 && (
            <>
              <section className="store-merge-section">
                <h3 className="store-merge-section__title">Row to keep (handle)</h3>
                <p className="store-merge-hint">
                  The surviving row keeps its internal ID (handle). All merged data below is written to this row.
                </p>
                <ul className="store-merge-survivor-list">
                  {stores.map((s) => (
                    <li key={s.handle}>
                      <label className="store-merge-radio-label">
                        <input
                          type="radio"
                          name="merge-keep"
                          checked={keepHandle === s.handle}
                          onChange={() => setKeepHandle(s.handle)}
                          disabled={submitting}
                        />
                        <span>
                          <strong>{displayName(s)}</strong>
                          <span className="store-merge-handle">{s.handle}</span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="store-merge-section">
                <h3 className="store-merge-section__title">Merged store details</h3>
                <p className="store-merge-hint">
                  For each field, choose a store&apos;s value (with preview) or select <strong>Enter my own</strong> and
                  type the final value for the merged listing.
                </p>

                <div className="store-merge-brand-preview">
                  <span className="store-merge-brand-preview__label">Brands after merge (server union, read-only)</span>
                  <div className="store-merge-brand-preview__pills">
                    {brandPreview.length === 0 ? (
                      <span className="store-merge-muted">—</span>
                    ) : (
                      brandPreview.map((b) => (
                        <span key={b} className="store-merge-brand-pill">
                          {b}
                        </span>
                      ))
                    )}
                  </div>
                </div>

                {TEXT_FIELD_META.map(({ key, label }) => {
                  const src = textSource[key];
                  return (
                    <div key={key} className="store-merge-field">
                      <div className="store-merge-field__label">{label}</div>
                      <div className="store-merge-field__sources">
                        {stores.map((s) => (
                          <label key={s.handle} className="store-merge-radio-label store-merge-radio-label--compact">
                            <input
                              type="radio"
                              name={`merge-field-${key}`}
                              checked={src.mode === 'store' && src.handle === s.handle}
                              onChange={() => handleFieldSourceChange(key, { mode: 'store', handle: s.handle })}
                              disabled={submitting}
                            />
                            <span>
                              From: {displayName(s)}{' '}
                              <span className="store-merge-handle">({s.handle})</span>
                            </span>
                          </label>
                        ))}
                        <label className="store-merge-radio-label store-merge-radio-label--compact">
                          <input
                            type="radio"
                            name={`merge-field-${key}`}
                            checked={src.mode === 'custom'}
                            onChange={() => handleFieldSourceChange(key, { mode: 'custom' })}
                            disabled={submitting}
                          />
                          <span>
                            <strong>Enter my own</strong>
                          </span>
                        </label>
                      </div>
                      {src.mode === 'store' ? (
                        <div className="store-merge-preview">{resolvedText(key) || '—'}</div>
                      ) : (
                        <input
                          type="text"
                          className="store-merge-input"
                          value={customText[key]}
                          onChange={(e) => setCustomText((prev) => ({ ...prev, [key]: e.target.value }))}
                          disabled={submitting}
                          autoComplete="off"
                        />
                      )}
                    </div>
                  );
                })}

                <div className="store-merge-field">
                  <div className="store-merge-field__label">Map coordinates (latitude / longitude)</div>
                  <div className="store-merge-field__sources">
                    {stores.map((s) => (
                      <label key={s.handle} className="store-merge-radio-label store-merge-radio-label--compact">
                        <input
                          type="radio"
                          name="merge-coords"
                          checked={coordSource.mode === 'store' && coordSource.handle === s.handle}
                          onChange={() => handleCoordSourceChange({ mode: 'store', handle: s.handle })}
                          disabled={submitting}
                        />
                        <span>
                          From: {displayName(s)} — {s.latitude.toFixed(5)}, {s.longitude.toFixed(5)}
                        </span>
                      </label>
                    ))}
                    <label className="store-merge-radio-label store-merge-radio-label--compact">
                      <input
                        type="radio"
                        name="merge-coords"
                        checked={coordSource.mode === 'custom'}
                        onChange={() => handleCoordSourceChange({ mode: 'custom' })}
                        disabled={submitting}
                      />
                      <span>
                        <strong>Enter my own</strong>
                      </span>
                    </label>
                  </div>
                  {coordSource.mode === 'store' ? (
                    <div className="store-merge-preview">
                      {(() => {
                        const st = byHandle.get(coordSource.handle);
                        return st ? `${st.latitude}, ${st.longitude}` : '—';
                      })()}
                    </div>
                  ) : (
                    <div className="store-merge-coord-inputs">
                      <label>
                        Latitude
                        <input
                          type="text"
                          className="store-merge-input"
                          value={customLat}
                          onChange={(e) => setCustomLat(e.target.value)}
                          disabled={submitting}
                          inputMode="decimal"
                        />
                      </label>
                      <label>
                        Longitude
                        <input
                          type="text"
                          className="store-merge-input"
                          value={customLng}
                          onChange={(e) => setCustomLng(e.target.value)}
                          disabled={submitting}
                          inputMode="decimal"
                        />
                      </label>
                    </div>
                  )}
                </div>
              </section>
            </>
          )}

          {step === 2 && (
            <section className="store-merge-section">
              <h3 className="store-merge-section__title">Confirm deletion</h3>
              <p className="store-merge-hint">
                You are about to remove <strong>{otherHandles.length}</strong> duplicate record(s) and keep handle{' '}
                <code>{keepHandle}</code>.
              </p>
              <label className="store-merge-checkbox">
                <input
                  type="checkbox"
                  checked={confirmChecked}
                  onChange={(e) => setConfirmChecked(e.target.checked)}
                  disabled={submitting}
                />
                I understand that {otherHandles.length} store record(s) will be deleted and cannot be recovered.
              </label>
            </section>
          )}
        </div>

        <div className="store-merge-modal__footer">
          {step === 2 && (
            <button
              type="button"
              className="store-edit-btn store-edit-btn--secondary"
              onClick={() => {
                setStep(1);
                setConfirmChecked(false);
              }}
              disabled={submitting}
            >
              Back
            </button>
          )}
          <button
            type="button"
            className="store-edit-btn store-edit-btn--secondary"
            onClick={() => !submitting && onClose()}
            disabled={submitting}
          >
            Cancel
          </button>
          {step === 1 ? (
            <button
              type="button"
              className="store-edit-btn store-edit-btn--primary"
              onClick={() => canProceedStep2 && setStep(2)}
              disabled={!canProceedStep2 || submitting}
            >
              Continue to confirm
            </button>
          ) : (
            <button
              type="button"
              className="store-edit-btn store-edit-btn--primary"
              onClick={handleSubmit}
              disabled={!confirmChecked || submitting}
            >
              {submitting ? 'Merging…' : 'Merge stores'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
