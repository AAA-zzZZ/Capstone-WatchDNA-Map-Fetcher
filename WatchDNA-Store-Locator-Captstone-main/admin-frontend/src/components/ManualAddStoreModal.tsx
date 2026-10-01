import React, { useCallback, useState } from 'react';
import { BrandEditor } from './StoreEditModal';
import {
  geocodeAddressForManualStore,
  markStoresPremium,
  submitManualStore,
  type ManualStoreValidationError,
} from '../services/premium.service';

export interface ManualAddStoreModalProps {
  availableBrands: string[];
  onClose: () => void;
  /** Called after a successful add so the parent can refresh the store list. */
  onSuccess: () => void;
  onToast: (t: { message: string; type: 'success' | 'error' }) => void;
}

interface FormDraft {
  name: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  stateProvinceRegion: string;
  postalCode: string;
  country: string;
  phone: string;
  email: string;
  website: string;
  latitude: string;
  longitude: string;
  brands: string[];
  pageDescription: string;
  isVerifiedDealer: boolean;
  isBoutique: boolean;
  isServiceCenter: boolean;
}

const emptyDraft = (): FormDraft => ({
  name: '',
  addressLine1: '',
  addressLine2: '',
  city: '',
  stateProvinceRegion: '',
  postalCode: '',
  country: '',
  phone: '',
  email: '',
  website: '',
  latitude: '',
  longitude: '',
  brands: [],
  pageDescription: '',
  isVerifiedDealer: false,
  isBoutique: false,
  isServiceCenter: false,
});

function formatValidationErrors(errors: ManualStoreValidationError[] | undefined): string {
  if (!errors?.length) return '';
  return errors
    .slice(0, 6)
    .map((e) => `Row ${e.row} · ${e.field}: ${e.issue}`)
    .join('\n');
}

const ManualAddStoreModal: React.FC<ManualAddStoreModalProps> = ({
  availableBrands,
  onClose,
  onSuccess,
  onToast,
}) => {
  const [draft, setDraft] = useState<FormDraft>(emptyDraft);
  const [submitting, setSubmitting] = useState(false);
  const [serverHint, setServerHint] = useState<string | null>(null);
  /** Optional one-line address for geocoding (does not need to match CSV address lines). */
  const [geocodeQuery, setGeocodeQuery] = useState('');
  const [geocoding, setGeocoding] = useState(false);
  const [geocodeMessage, setGeocodeMessage] = useState<{ type: 'error' | 'success'; text: string } | null>(
    null
  );

  const updateDraft = useCallback((patch: Partial<FormDraft>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
  }, []);

  const closeIfIdle = useCallback(() => {
    if (!submitting && !geocoding) onClose();
  }, [submitting, geocoding, onClose]);

  const handleGeocode = async () => {
    setGeocodeMessage(null);
    const country = draft.country.trim();
    const city = draft.city.trim();
    const a1 = draft.addressLine1.trim();
    const a2 = draft.addressLine2.trim();
    const q = geocodeQuery.trim();

    if (!country) {
      setGeocodeMessage({
        type: 'error',
        text: 'Country is required to look up coordinates.',
      });
      return;
    }
    if (!q && !city) {
      setGeocodeMessage({
        type: 'error',
        text: 'Enter a city, or paste a full address in the lookup field.',
      });
      return;
    }
    if (!q && !a1 && !a2) {
      setGeocodeMessage({
        type: 'error',
        text: 'Enter address lines or paste a full address in the lookup field.',
      });
      return;
    }

    setGeocoding(true);
    try {
      const result = await geocodeAddressForManualStore({
        fullAddress: q || undefined,
        addressLine1: a1 || undefined,
        addressLine2: a2 || undefined,
        city,
        country,
        stateProvinceRegion: draft.stateProvinceRegion.trim() || undefined,
        postalCode: draft.postalCode.trim() || undefined,
      });

      if (!result.success) {
        const text =
          result.message ||
          (result.error === 'not_found'
            ? 'Could not find coordinates for this address.'
            : 'Could not look up coordinates.');
        setGeocodeMessage({ type: 'error', text });
        return;
      }

      const latStr = String(result.latitude);
      const lonStr = String(result.longitude);
      updateDraft({ latitude: latStr, longitude: lonStr });
      setGeocodeMessage({
        type: 'success',
        text: `Coordinates set: ${latStr}, ${lonStr}`,
      });
      onToast({ message: 'Coordinates filled from address.', type: 'success' });
    } finally {
      setGeocoding(false);
    }
  };

  const handleSubmit = async () => {
    setServerHint(null);
    const name = draft.name.trim();
    const city = draft.city.trim();
    const country = draft.country.trim();
    const lat = parseFloat(draft.latitude);
    const lon = parseFloat(draft.longitude);
    const a1 = draft.addressLine1.trim();
    const a2 = draft.addressLine2.trim();

    if (!name || !city || !country) {
      onToast({ message: 'Name, city, and country are required.', type: 'error' });
      return;
    }
    if (!a1 && !a2) {
      onToast({ message: 'Enter address line 1 and/or address line 2.', type: 'error' });
      return;
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      onToast({ message: 'Latitude and longitude must be valid numbers.', type: 'error' });
      return;
    }

    setSubmitting(true);
    try {
      const result = await submitManualStore({
        name,
        addressLine1: a1,
        addressLine2: a2 || undefined,
        city,
        country,
        stateProvinceRegion: draft.stateProvinceRegion.trim() || undefined,
        postalCode: draft.postalCode.trim() || undefined,
        phone: draft.phone.trim() || null,
        email: draft.email.trim() || undefined,
        website: draft.website.trim() || undefined,
        latitude: lat,
        longitude: lon,
        brands: draft.brands.length > 0 ? draft.brands : undefined,
        pageDescription: draft.pageDescription.trim() || undefined,
      });

      if (!result.success) {
        if (result.errors?.length) {
          setServerHint(formatValidationErrors(result.errors));
        } else if (result.message) {
          setServerHint(result.message);
        } else {
          setServerHint(result.error);
        }
        onToast({
          message:
            result.error === 'validation_failed'
              ? 'Validation failed — fix the issues below or adjust the row.'
              : result.error === 'import_failed'
                ? 'Store was not imported — see details below.'
                : result.message || 'Could not add store.',
          type: 'error',
        });
        return;
      }

      const h = result.store?.handle;
      const summary = result.importResult;

      if (h && (draft.isVerifiedDealer || draft.isBoutique || draft.isServiceCenter)) {
        try {
          await markStoresPremium([{
            handle: h,
            isVerifiedDealer: draft.isVerifiedDealer,
            isBoutique: draft.isBoutique,
            isServiceCenter: draft.isServiceCenter,
          }]);
        } catch {
          onToast({ message: 'Store added but store type could not be set — edit the store to set it.', type: 'error' });
          onSuccess();
          onClose();
          return;
        }
      }

      onToast({
        message: h
          ? `Store added (${summary.newCount ? 'new' : summary.updatedCount ? 'updated' : 'unchanged'}). Handle: ${h}`
          : 'Store processed — refresh the list if the handle is not shown.',
        type: 'success',
      });
      onSuccess();
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="store-edit-overlay" onClick={closeIfIdle} role="presentation">
      <div
        className="store-edit-modal manual-add-store-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="manual-add-store-title"
      >
        <div className="store-edit-modal__header">
          <h2 id="manual-add-store-title">Add store manually</h2>
          <button
            type="button"
            className="store-edit-modal__close"
            onClick={closeIfIdle}
            disabled={submitting || geocoding}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="store-edit-modal__body">
          <p className="store-edit-modal__subtitle manual-add-store__intro">
            This runs the same steps as uploading a one-row CSV: Python validation (with fixes), then
            database import with merge/dedupe rules and premium flag sync.
          </p>

          {serverHint && (
            <div className="manual-add-store__server-hint" role="alert">
              <pre>{serverHint}</pre>
            </div>
          )}

          <section className="store-edit-section">
            <h3 className="store-edit-section__title">Store</h3>
            <div className="store-edit-grid">
              <label className="store-edit-field store-edit-field--full">
                <span className="store-edit-label">Name</span>
                <input
                  value={draft.name}
                  onChange={(e) => updateDraft({ name: e.target.value })}
                  disabled={submitting}
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
                  value={draft.addressLine1}
                  onChange={(e) => updateDraft({ addressLine1: e.target.value })}
                  disabled={submitting}
                />
              </label>
              <label className="store-edit-field store-edit-field--full">
                <span className="store-edit-label">Address line 2</span>
                <input
                  value={draft.addressLine2}
                  onChange={(e) => updateDraft({ addressLine2: e.target.value })}
                  disabled={submitting}
                />
              </label>
              <label className="store-edit-field">
                <span className="store-edit-label">City</span>
                <input value={draft.city} onChange={(e) => updateDraft({ city: e.target.value })} disabled={submitting} />
              </label>
              <label className="store-edit-field">
                <span className="store-edit-label">State / province</span>
                <input
                  value={draft.stateProvinceRegion}
                  onChange={(e) => updateDraft({ stateProvinceRegion: e.target.value })}
                  disabled={submitting}
                />
              </label>
              <label className="store-edit-field">
                <span className="store-edit-label">Postal code</span>
                <input
                  value={draft.postalCode}
                  onChange={(e) => updateDraft({ postalCode: e.target.value })}
                  disabled={submitting}
                />
              </label>
              <label className="store-edit-field">
                <span className="store-edit-label">Country</span>
                <input
                  value={draft.country}
                  onChange={(e) => updateDraft({ country: e.target.value })}
                  disabled={submitting}
                />
              </label>
            </div>
          </section>

          <section className="store-edit-section">
            <h3 className="store-edit-section__title">Coordinates</h3>
            <p className="store-edit-hint">Required — use WGS84 decimal degrees (same as master CSV).</p>

            <div className="manual-add-store__geocode">
              <label className="store-edit-field store-edit-field--full">
                <span className="store-edit-label">Look up from address (optional)</span>
                <textarea
                  className="manual-add-store__geocode-query"
                  rows={2}
                  value={geocodeQuery}
                  onChange={(e) => {
                    setGeocodeQuery(e.target.value);
                    setGeocodeMessage(null);
                  }}
                  placeholder="Paste a full address on one line, or leave blank to use the address fields above."
                  disabled={submitting || geocoding}
                />
              </label>
              <p className="store-edit-hint manual-add-store__geocode-hint">
                Uses the same geocoder as coordinate verification (Photon or Nominatim). Country is required;
                include city and postal code for better results.
              </p>
              <button
                type="button"
                className="store-edit-btn store-edit-btn--secondary manual-add-store__geocode-btn"
                onClick={handleGeocode}
                disabled={submitting || geocoding}
              >
                {geocoding ? 'Looking up…' : 'Find coordinates from address'}
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
                  value={draft.latitude}
                  onChange={(e) => updateDraft({ latitude: e.target.value })}
                  placeholder="e.g. 40.7128"
                  disabled={submitting || geocoding}
                />
              </label>
              <label className="store-edit-field">
                <span className="store-edit-label">Longitude</span>
                <input
                  value={draft.longitude}
                  onChange={(e) => updateDraft({ longitude: e.target.value })}
                  placeholder="e.g. -74.0060"
                  disabled={submitting || geocoding}
                />
              </label>
            </div>
          </section>

          <section className="store-edit-section">
            <h3 className="store-edit-section__title">Contact</h3>
            <div className="store-edit-grid">
              <label className="store-edit-field">
                <span className="store-edit-label">Phone</span>
                <input value={draft.phone} onChange={(e) => updateDraft({ phone: e.target.value })} disabled={submitting} />
              </label>
              <label className="store-edit-field">
                <span className="store-edit-label">Email</span>
                <input
                  type="email"
                  value={draft.email}
                  onChange={(e) => updateDraft({ email: e.target.value })}
                  disabled={submitting}
                />
              </label>
              <label className="store-edit-field store-edit-field--full">
                <span className="store-edit-label">Website</span>
                <input
                  type="url"
                  placeholder="https://"
                  value={draft.website}
                  onChange={(e) => updateDraft({ website: e.target.value })}
                  disabled={submitting}
                />
              </label>
            </div>
          </section>

          <section className="store-edit-section">
            <h3 className="store-edit-section__title">Store Type</h3>
            <label className="store-edit-checkbox-row">
              <input
                type="checkbox"
                checked={draft.isVerifiedDealer}
                onChange={(e) => updateDraft({ isVerifiedDealer: e.target.checked })}
                disabled={submitting}
              />
              Verified Authorized Dealer
            </label>
            <label className="store-edit-checkbox-row">
              <input
                type="checkbox"
                checked={draft.isBoutique}
                onChange={(e) => updateDraft({ isBoutique: e.target.checked })}
                disabled={submitting}
              />
              Boutique Verified
            </label>
            <label className="store-edit-checkbox-row">
              <input
                type="checkbox"
                checked={draft.isServiceCenter}
                onChange={(e) => updateDraft({ isServiceCenter: e.target.checked })}
                disabled={submitting}
              />
              Service Center
            </label>
          </section>

          <section className="store-edit-section">
            <h3 className="store-edit-section__title">Brands</h3>
            <BrandEditor
              brands={draft.brands}
              availableBrands={availableBrands}
              onChange={(brands) => updateDraft({ brands })}
              disabled={submitting}
            />
          </section>

          <section className="store-edit-section">
            <h3 className="store-edit-section__title">Description</h3>
            <label className="store-edit-field store-edit-field--full">
              <span className="store-edit-label">Page description</span>
              <textarea
                rows={3}
                value={draft.pageDescription}
                onChange={(e) => updateDraft({ pageDescription: e.target.value })}
                disabled={submitting}
              />
            </label>
          </section>
        </div>

        <div className="store-edit-modal__footer">
          <button
            type="button"
            className="store-edit-btn store-edit-btn--secondary"
            onClick={closeIfIdle}
            disabled={submitting || geocoding}
          >
            Cancel
          </button>
          <button
            type="button"
            className="store-edit-btn store-edit-btn--primary"
            onClick={handleSubmit}
            disabled={submitting || geocoding}
          >
            {submitting ? 'Validating & importing…' : 'Add store'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ManualAddStoreModal;
