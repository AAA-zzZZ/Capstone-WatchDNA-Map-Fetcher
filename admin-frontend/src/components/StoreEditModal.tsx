import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  geocodeAddressForManualStore,
  searchShopifyFiles,
  updateStore,
  uploadStoreImage,
  type ShopifyFileResult,
  type StoreRecord,
  type StoreUpdatePayload,
} from '../services/premium.service';
import { parseBrandsForDisplay } from '../utils/brandDisplay';

const API_ORIGIN = import.meta.env.VITE_API_URL || 'http://localhost:3001';

function n2s(v: string | null | undefined): string {
  return v ?? '';
}

/** Admin runs on another origin; API-relative image paths need the backend base URL. */
function imagePreviewSrc(imageUrl: string): string {
  const t = imageUrl.trim();
  if (!t) return '';
  if (t.startsWith('/api/')) return `${API_ORIGIN}${t}`;
  return t;
}

export interface StoreEditDraft {
  name: string;
  nameEn: string;
  addressLine1: string;
  addressLine1En: string;
  addressLine2: string;
  city: string;
  cityEn: string;
  stateProvinceRegion: string;
  postalCode: string;
  country: string;
  phone: string;
  website: string;
  imageUrl: string;
  brands: string[];
  monday: string;
  tuesday: string;
  wednesday: string;
  thursday: string;
  friday: string;
  saturday: string;
  sunday: string;
  isVerifiedDealer: boolean;
  isBoutique: boolean;
  isServiceCenter: boolean;
  premiumFilterBrands: string[];
  latitude: string;
  longitude: string;
}

function storeToDraft(s: StoreRecord): StoreEditDraft {
  return {
    name: s.name,
    nameEn: n2s(s.nameEn),
    addressLine1: s.addressLine1,
    addressLine1En: n2s(s.addressLine1En),
    addressLine2: n2s(s.addressLine2),
    city: s.city,
    cityEn: n2s(s.cityEn),
    stateProvinceRegion: n2s(s.stateProvinceRegion),
    postalCode: n2s(s.postalCode),
    country: s.country,
    phone: n2s(s.phone),
    website: n2s(s.website),
    imageUrl: n2s(s.imageUrl),
    brands: parseBrandsForDisplay(s.brands),
    monday: n2s(s.monday),
    tuesday: n2s(s.tuesday),
    wednesday: n2s(s.wednesday),
    thursday: n2s(s.thursday),
    friday: n2s(s.friday),
    saturday: n2s(s.saturday),
    sunday: n2s(s.sunday),
    isVerifiedDealer: Boolean(s.isVerifiedDealer),
    isBoutique: Boolean(s.isBoutique),
    isServiceCenter: Boolean(s.isServiceCenter),
    premiumFilterBrands: Array.isArray(s.premiumFilterBrands) ? s.premiumFilterBrands : [],
    latitude: String(s.latitude ?? ''),
    longitude: String(s.longitude ?? ''),
  };
}

function draftToPayload(
  d: StoreEditDraft,
  baseline: StoreRecord,
  pageDescription: string
): StoreUpdatePayload {
  const empty = (s: string) => (s.trim() === '' ? null : s.trim());
  const out: StoreUpdatePayload = {
    name: d.name.trim(),
    nameEn: empty(d.nameEn),
    addressLine1: d.addressLine1.trim(),
    addressLine1En: empty(d.addressLine1En),
    addressLine2: empty(d.addressLine2),
    city: d.city.trim(),
    cityEn: empty(d.cityEn),
    stateProvinceRegion: empty(d.stateProvinceRegion),
    postalCode: empty(d.postalCode),
    country: d.country.trim(),
    phone: empty(d.phone),
    website: empty(d.website),
    imageUrl: empty(d.imageUrl),
    pageDescription: empty(pageDescription),
    brands: d.brands.length > 0 ? d.brands.join(', ') : null,
    monday: empty(d.monday),
    tuesday: empty(d.tuesday),
    wednesday: empty(d.wednesday),
    thursday: empty(d.thursday),
    friday: empty(d.friday),
    saturday: empty(d.saturday),
    sunday: empty(d.sunday),
  };
  out.isVerifiedDealer = d.isVerifiedDealer;
  out.isBoutique = d.isBoutique;
  out.isServiceCenter = d.isServiceCenter;
  const newProgram = d.isVerifiedDealer || d.isBoutique || d.isServiceCenter;
  if (newProgram !== baseline.isPremium) {
    out.isPremium = newProgram;
  }
  out.premiumFilterBrands = d.premiumFilterBrands;
  const lat = parseFloat(d.latitude);
  const lng = parseFloat(d.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    out.latitude = lat;
    out.longitude = lng;
  }
  return out;
}

const DAY_LABELS: {
  key: keyof Pick<
    StoreEditDraft,
    'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday'
  >;
  label: string;
}[] = [
  { key: 'monday', label: 'Monday' },
  { key: 'tuesday', label: 'Tuesday' },
  { key: 'wednesday', label: 'Wednesday' },
  { key: 'thursday', label: 'Thursday' },
  { key: 'friday', label: 'Friday' },
  { key: 'saturday', label: 'Saturday' },
  { key: 'sunday', label: 'Sunday' },
];

export type StoreEditToast = { message: string; type: 'success' | 'error' };

const BRAND_SUGGESTIONS_LIMIT = 8;

/** Tag-style brand picker: chips for current brands + autocomplete input to add more. */
export const BrandEditor: React.FC<{
  brands: string[];
  availableBrands: string[];
  onChange: (brands: string[]) => void;
  disabled?: boolean;
}> = ({ brands, availableBrands, onChange, disabled }) => {
  const [input, setInput] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLUListElement>(null);

  const suggestions = useMemo(() => {
    const q = input.trim().toLowerCase();
    return availableBrands
      .filter((b) => !brands.includes(b))
      .filter((b) => !q || b.toLowerCase().includes(q))
      .slice(0, BRAND_SUGGESTIONS_LIMIT);
  }, [availableBrands, brands, input]);

  const addBrand = useCallback((name: string) => {
    const trimmed = name.trim().toUpperCase();
    if (!trimmed || brands.includes(trimmed)) return;
    onChange([...brands, trimmed]);
    setInput('');
    setShowSuggestions(false);
  }, [brands, onChange]);

  const removeBrand = useCallback((brand: string) => {
    onChange(brands.filter((b) => b !== brand));
  }, [brands, onChange]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        inputRef.current && !inputRef.current.contains(e.target as Node) &&
        suggestionsRef.current && !suggestionsRef.current.contains(e.target as Node)
      ) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const trimmedInput = input.trim().toUpperCase();
  const isNew = trimmedInput && !availableBrands.includes(trimmedInput);

  return (
    <div className="brand-editor">
      {brands.length > 0 && (
        <div className="brand-editor__chips">
          {brands.map((b) => (
            <span key={b} className="brand-editor__chip">
              {b}
              <button
                type="button"
                className="brand-editor__chip-remove"
                onClick={() => removeBrand(b)}
                disabled={disabled}
                aria-label={`Remove ${b}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="brand-editor__input-wrap">
        <input
          ref={inputRef}
          type="text"
          className="brand-editor__input"
          placeholder="Search or type a brand name…"
          value={input}
          onChange={(e) => { setInput(e.target.value); setShowSuggestions(true); }}
          onFocus={() => setShowSuggestions(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); addBrand(input); }
            if (e.key === 'Escape') { setShowSuggestions(false); }
          }}
          disabled={disabled}
          autoComplete="off"
        />
        {showSuggestions && suggestions.length > 0 && (
          <ul className="autocomplete-list brand-editor__suggestions" ref={suggestionsRef}>
            {suggestions.map((b) => (
              <li key={b} onMouseDown={() => addBrand(b)}>
                {b}
              </li>
            ))}
          </ul>
        )}
      </div>
      {isNew && (
        <p className="store-edit-hint brand-editor__new-hint">
          Press Enter to add "{trimmedInput}" as a new brand.
        </p>
      )}
    </div>
  );
};

/** Inline Shopify Files picker: search by filename, click to select a CDN URL. */
const ShopifyFilePicker: React.FC<{
  onSelect: (url: string, gid: string) => void;
  disabled?: boolean;
}> = ({ onSelect, disabled }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ShopifyFileResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [configured, setConfigured] = useState(true);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doSearch = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const res = await searchShopifyFiles(q, 20);
      setConfigured(res.configured);
      setResults(res.files.filter((f) => f.url && f.fileStatus === 'READY'));
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(query), 350);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, open, doSearch]);

  if (!configured) return null;

  return (
    <div className="shopify-file-picker">
      <button
        type="button"
        className="store-edit-btn store-edit-btn--secondary"
        onClick={() => { setOpen((o) => !o); if (!open) doSearch(query); }}
        disabled={disabled}
      >
        {open ? 'Close file picker' : 'Pick from Shopify Files'}
      </button>
      {open && (
        <div className="shopify-file-picker__panel">
          <input
            className="shopify-file-picker__search"
            type="search"
            placeholder="Search by file name…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          {loading && <p className="store-edit-hint">Searching…</p>}
          {!loading && results.length === 0 && (
            <p className="store-edit-hint">No ready images found{query ? ` for "${query}"` : ''}.</p>
          )}
          <div className="shopify-file-picker__grid">
            {results.map((f) => (
              <button
                key={f.id}
                type="button"
                className="shopify-file-picker__item"
                title={f.alt ?? f.url ?? ''}
                onClick={() => { onSelect(f.url!, f.id); setOpen(false); }}
              >
                <img src={f.url!} alt={f.alt ?? ''} className="shopify-file-picker__thumb" />
                <span className="shopify-file-picker__label">
                  {f.alt ?? f.url!.split('/').pop()?.split('?')[0] ?? ''}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

/** Local state + ref so typing does not re-render the full edit modal. */
const PageDescriptionField: React.FC<{
  initial: string;
  liveRef: React.MutableRefObject<string>;
}> = ({ initial, liveRef }) => {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    setValue(initial);
    liveRef.current = initial;
  }, [initial, liveRef]);
  return (
    <textarea
      rows={4}
      value={value}
      onChange={(e) => {
        const v = e.target.value;
        setValue(v);
        liveRef.current = v;
      }}
    />
  );
};

interface StoreEditModalProps {
  store: StoreRecord;
  /** All brand display names across all stores — used to populate autocomplete suggestions. */
  availableBrands: string[];
  onClose: () => void;
  onSaved: (updated: StoreRecord) => void;
  /** After image upload/remove — parent refreshes list and keeps editor open with new server row. */
  onStoreSynced: (updated: StoreRecord) => void;
  onToast: (t: StoreEditToast) => void;
}

const StoreEditModal: React.FC<StoreEditModalProps> = ({
  store,
  availableBrands,
  onClose,
  onSaved,
  onStoreSynced,
  onToast,
}) => {
  const [editDraft, setEditDraft] = useState<StoreEditDraft>(() => storeToDraft(store));
  const pageDescriptionRef = useRef(n2s(store.pageDescription));
  const prevStoreHandleRef = useRef(store.handle);
  const [editSaving, setEditSaving] = useState(false);
  const [imageUploading, setImageUploading] = useState(false);
  const [imagePreviewBroken, setImagePreviewBroken] = useState(false);
  const [geocoding, setGeocoding] = useState(false);
  const [geocodeMessage, setGeocodeMessage] = useState<{ type: 'error' | 'success'; text: string } | null>(null);

  useEffect(() => {
    setEditDraft(storeToDraft(store));
    setImagePreviewBroken(false);
    setGeocodeMessage(null);
    if (store.handle !== prevStoreHandleRef.current) {
      prevStoreHandleRef.current = store.handle;
      pageDescriptionRef.current = n2s(store.pageDescription);
    }
  }, [store]);

  const updateDraft = useCallback((patch: Partial<StoreEditDraft>) => {
    setEditDraft((prev) => ({ ...prev, ...patch }));
  }, []);

  const handleGeocode = useCallback(async () => {
    const country = editDraft.country.trim();
    if (!country) {
      setGeocodeMessage({ type: 'error', text: 'Country is required to look up coordinates.' });
      return;
    }
    setGeocoding(true);
    setGeocodeMessage(null);
    try {
      const result = await geocodeAddressForManualStore({
        addressLine1: editDraft.addressLine1.trim() || undefined,
        addressLine2: editDraft.addressLine2.trim() || undefined,
        city: editDraft.city.trim() || undefined,
        stateProvinceRegion: editDraft.stateProvinceRegion.trim() || undefined,
        postalCode: editDraft.postalCode.trim() || undefined,
        country,
      });
      if (result.success) {
        updateDraft({ latitude: String(result.latitude), longitude: String(result.longitude) });
        setGeocodeMessage({ type: 'success', text: `Found: ${result.latitude.toFixed(6)}, ${result.longitude.toFixed(6)}` });
      } else {
        setGeocodeMessage({ type: 'error', text: result.message ?? result.error ?? 'No result found.' });
      }
    } finally {
      setGeocoding(false);
    }
  }, [editDraft, updateDraft]);

  const closeIfIdle = useCallback(() => {
    if (!editSaving && !imageUploading) onClose();
  }, [editSaving, imageUploading, onClose]);

  const handleStoreImageFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!/^image\/(jpeg|png|webp|gif)$/i.test(file.type)) {
      onToast({ message: 'Please choose a JPEG, PNG, WebP, or GIF image.', type: 'error' });
      e.target.value = '';
      return;
    }
    setImageUploading(true);
    try {
      const updated = await uploadStoreImage(store.handle, file);
      onStoreSynced(updated);
      setEditDraft(storeToDraft(updated));
      setImagePreviewBroken(false);
      onToast({ message: 'Image uploaded.', type: 'success' });
    } catch {
      onToast({ message: 'Image upload failed. Please try again.', type: 'error' });
    } finally {
      setImageUploading(false);
      e.target.value = '';
    }
  };

  const handlePickShopifyFile = useCallback(async (cdnUrl: string, fileGid: string) => {
    setEditSaving(true);
    try {
      const updated = await updateStore(store.handle, { imageUrl: cdnUrl, shopifyFileGid: fileGid });
      onStoreSynced(updated);
      setEditDraft(storeToDraft(updated));
      setImagePreviewBroken(false);
      onToast({ message: 'Image set from Shopify Files.', type: 'success' });
    } catch {
      onToast({ message: 'Failed to set image. Please try again.', type: 'error' });
    } finally {
      setEditSaving(false);
    }
  }, [store.handle, onStoreSynced, onToast]);

  const handleRemoveStoreImage = async () => {
    setEditSaving(true);
    try {
      const updated = await updateStore(store.handle, { imageUrl: null });
      onStoreSynced(updated);
      setEditDraft(storeToDraft(updated));
      setImagePreviewBroken(false);
      onToast({ message: 'Image removed.', type: 'success' });
    } catch {
      onToast({ message: 'Failed to remove image.', type: 'error' });
    } finally {
      setEditSaving(false);
    }
  };

  const handleSaveEdit = async () => {
    if (
      !editDraft.name.trim() ||
      !editDraft.addressLine1.trim() ||
      !editDraft.city.trim() ||
      !editDraft.country.trim()
    ) {
      onToast({ message: 'Store name, address line 1, city, and country are required.', type: 'error' });
      return;
    }
    setEditSaving(true);
    try {
      const updated = await updateStore(
        store.handle,
        draftToPayload(editDraft, store, pageDescriptionRef.current)
      );
      onSaved(updated);
      onToast({ message: 'Store updated.', type: 'success' });
    } catch {
      onToast({ message: 'Failed to save store. Please try again.', type: 'error' });
    } finally {
      setEditSaving(false);
    }
  };

  return (
    <div className="store-edit-overlay" onClick={closeIfIdle} role="presentation">
      <div
        className="store-edit-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="store-edit-title"
      >
        <div className="store-edit-modal__header">
          <h2 id="store-edit-title">Edit store</h2>
          <button
            type="button"
            className="store-edit-modal__close"
            onClick={closeIfIdle}
            disabled={editSaving || imageUploading}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="store-edit-modal__body">
          <p className="store-edit-modal__subtitle">{store.nameEn || store.name}</p>

          <section className="store-edit-section">
            <h3 className="store-edit-section__title">Store name</h3>
            <p className="store-edit-hint">
              Keep the original (local-language) name exactly as it appears. Use the English field for the translation
              shoppers should see on the map — leave it blank when the original is already in English.
            </p>
            <div className="store-edit-grid">
              <label className="store-edit-field store-edit-field--full">
                <span className="store-edit-label">Name (original)</span>
                <input
                  value={editDraft.name}
                  onChange={(e) => updateDraft({ name: e.target.value })}
                />
              </label>
              <label className="store-edit-field store-edit-field--full">
                <span className="store-edit-label">Name — English</span>
                <input
                  value={editDraft.nameEn}
                  onChange={(e) => updateDraft({ nameEn: e.target.value })}
                  placeholder="e.g. Rolex Ginza Boutique"
                />
              </label>
            </div>
          </section>

          <section className="store-edit-section">
            <h3 className="store-edit-section__title">Address</h3>
            <div className="store-edit-grid">
              <label className="store-edit-field store-edit-field--full">
                <span className="store-edit-label">Address line 1</span>
                <input
                  value={editDraft.addressLine1}
                  onChange={(e) => updateDraft({ addressLine1: e.target.value })}
                />
              </label>
              <label className="store-edit-field store-edit-field--full">
                <span className="store-edit-label">Address line 1 — English</span>
                <input
                  value={editDraft.addressLine1En}
                  onChange={(e) => updateDraft({ addressLine1En: e.target.value })}
                  placeholder="English translation of the street address (optional)"
                />
              </label>
              <label className="store-edit-field store-edit-field--full">
                <span className="store-edit-label">Address line 2</span>
                <input
                  value={editDraft.addressLine2}
                  onChange={(e) => updateDraft({ addressLine2: e.target.value })}
                />
              </label>
              <label className="store-edit-field">
                <span className="store-edit-label">City</span>
                <input value={editDraft.city} onChange={(e) => updateDraft({ city: e.target.value })} />
              </label>
              <label className="store-edit-field">
                <span className="store-edit-label">City — English</span>
                <input
                  value={editDraft.cityEn}
                  onChange={(e) => updateDraft({ cityEn: e.target.value })}
                  placeholder="e.g. Tokyo"
                />
              </label>
              <label className="store-edit-field">
                <span className="store-edit-label">State / province</span>
                <input
                  value={editDraft.stateProvinceRegion}
                  onChange={(e) => updateDraft({ stateProvinceRegion: e.target.value })}
                />
              </label>
              <label className="store-edit-field">
                <span className="store-edit-label">Postal code</span>
                <input
                  value={editDraft.postalCode}
                  onChange={(e) => updateDraft({ postalCode: e.target.value })}
                />
              </label>
              <label className="store-edit-field">
                <span className="store-edit-label">Country</span>
                <input
                  value={editDraft.country}
                  onChange={(e) => updateDraft({ country: e.target.value })}
                />
              </label>
            </div>
          </section>

          <section className="store-edit-section">
            <h3 className="store-edit-section__title">Coordinates</h3>
            <p className="store-edit-hint">WGS84 decimal degrees. Use "Detect from address" to auto-fill from the address fields above.</p>
            <div className="manual-add-store__geocode">
              <button
                type="button"
                className="store-edit-btn store-edit-btn--secondary manual-add-store__geocode-btn"
                onClick={handleGeocode}
                disabled={editSaving || imageUploading || geocoding}
              >
                {geocoding ? 'Detecting…' : 'Detect from address'}
              </button>
              {geocodeMessage && (
                <div
                  className={
                    geocodeMessage.type === 'error'
                      ? 'manual-add-store__geocode-msg manual-add-store__geocode-msg--error'
                      : 'manual-add-store__geocode-msg manual-add-store__geocode-msg--ok'
                  }
                  role="status"
                >
                  {geocodeMessage.text}
                </div>
              )}
            </div>
            <div className="store-edit-grid">
              <label className="store-edit-field">
                <span className="store-edit-label">Latitude</span>
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="e.g. 35.6895"
                  value={editDraft.latitude}
                  onChange={(e) => { updateDraft({ latitude: e.target.value }); setGeocodeMessage(null); }}
                  disabled={editSaving || imageUploading || geocoding}
                />
              </label>
              <label className="store-edit-field">
                <span className="store-edit-label">Longitude</span>
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="e.g. 139.6917"
                  value={editDraft.longitude}
                  onChange={(e) => { updateDraft({ longitude: e.target.value }); setGeocodeMessage(null); }}
                  disabled={editSaving || imageUploading || geocoding}
                />
              </label>
            </div>
          </section>

          <section className="store-edit-section">
            <h3 className="store-edit-section__title">Contact</h3>
            <div className="store-edit-grid">
              <label className="store-edit-field">
                <span className="store-edit-label">Phone</span>
                <input value={editDraft.phone} onChange={(e) => updateDraft({ phone: e.target.value })} />
              </label>
              <label className="store-edit-field">
                <span className="store-edit-label">Website</span>
                <input
                  type="url"
                  placeholder="https://"
                  value={editDraft.website}
                  onChange={(e) => updateDraft({ website: e.target.value })}
                />
              </label>
            </div>
          </section>

          <section className="store-edit-section">
            <h3 className="store-edit-section__title">Brands</h3>
            <label className="store-edit-field store-edit-field--full">
              <span className="store-edit-label">Store brands</span>
              <BrandEditor
                brands={editDraft.brands}
                availableBrands={availableBrands}
                onChange={(brands) => updateDraft({ brands })}
                disabled={editSaving || imageUploading}
              />
            </label>
            <label className="store-edit-field store-edit-field--full">
              <span className="store-edit-label">Premium filter brands (public map)</span>
              <BrandEditor
                brands={editDraft.premiumFilterBrands}
                availableBrands={availableBrands}
                onChange={(premiumFilterBrands) => updateDraft({ premiumFilterBrands })}
                disabled={editSaving || imageUploading}
              />
            </label>
            <p className="store-edit-hint">
              Add existing brands from suggestions or type a new one and press Enter. These brands are used for the
              public map brand filters.
            </p>
          </section>

          <section className="store-edit-section">
            <h3 className="store-edit-section__title">Image</h3>
            <p className="store-edit-hint">Upload a new image (max 5 MB) or pick one already in Shopify Files. Saves immediately.</p>
            <div className="store-edit-image-actions">
              <label className="store-edit-field store-edit-field--full">
                <span className="store-edit-label">Upload image</span>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  onChange={handleStoreImageFile}
                  disabled={imageUploading || editSaving}
                />
              </label>
              {editDraft.imageUrl.trim() !== '' && (
                <button
                  type="button"
                  className="store-edit-btn store-edit-btn--secondary store-edit-remove-image"
                  onClick={handleRemoveStoreImage}
                  disabled={imageUploading || editSaving}
                >
                  Remove image
                </button>
              )}
            </div>
            <ShopifyFilePicker
              onSelect={handlePickShopifyFile}
              disabled={imageUploading || editSaving}
            />
            {imageUploading && <p className="store-edit-hint">Uploading…</p>}
            {editDraft.imageUrl.trim() !== '' && !imagePreviewBroken && (
              <div className="store-edit-image-preview">
                <img
                  src={imagePreviewSrc(editDraft.imageUrl)}
                  alt=""
                  onError={() => setImagePreviewBroken(true)}
                />
              </div>
            )}
          </section>

          <section className="store-edit-section">
            <h3 className="store-edit-section__title">Hours</h3>
            <div className="store-edit-grid store-edit-grid--days">
              {DAY_LABELS.map(({ key, label }) => (
                <label key={key} className="store-edit-field">
                  <span className="store-edit-label">{label}</span>
                  <input
                    value={editDraft[key]}
                    onChange={(e) => updateDraft({ [key]: e.target.value } as Partial<StoreEditDraft>)}
                    placeholder="e.g. 9:00–17:00"
                  />
                </label>
              ))}
            </div>
          </section>

          <section className="store-edit-section">
            <h3 className="store-edit-section__title">Description</h3>
            <label className="store-edit-field store-edit-field--full">
              <span className="store-edit-label">Page description</span>
              <PageDescriptionField
                key={store.handle}
                initial={n2s(store.pageDescription)}
                liveRef={pageDescriptionRef}
              />
            </label>
          </section>

          <section className="store-edit-section">
            <h3 className="store-edit-section__title">Listing</h3>
            <fieldset className="store-edit-fieldset">
              <legend className="store-edit-label">Verified listing (multi-select)</legend>
              <p className="store-edit-hint">
                Select how this store should appear in the public map’s category filters. At least one option puts the
                store in the verified program. Leave all unchecked to remove verified listing.
              </p>
              <label className="store-edit-checkbox-row">
                <input
                  type="checkbox"
                  checked={editDraft.isVerifiedDealer}
                  onChange={(e) => updateDraft({ isVerifiedDealer: e.target.checked })}
                />
                <span>Verified authorized dealer</span>
              </label>
              <label className="store-edit-checkbox-row">
                <input
                  type="checkbox"
                  checked={editDraft.isBoutique}
                  onChange={(e) => updateDraft({ isBoutique: e.target.checked })}
                />
                <span>Boutique verified</span>
              </label>
              <label className="store-edit-checkbox-row">
                <input
                  type="checkbox"
                  checked={editDraft.isServiceCenter}
                  onChange={(e) => updateDraft({ isServiceCenter: e.target.checked })}
                />
                <span>Service center (repairs; may not sell watches)</span>
              </label>
            </fieldset>
          </section>
        </div>

        <div className="store-edit-modal__footer">
          <button
            type="button"
            className="store-edit-btn store-edit-btn--secondary"
            onClick={closeIfIdle}
            disabled={editSaving || imageUploading}
          >
            Cancel
          </button>
          <button
            type="button"
            className="store-edit-btn store-edit-btn--primary"
            onClick={handleSaveEdit}
            disabled={editSaving || imageUploading}
          >
            {editSaving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default StoreEditModal;
