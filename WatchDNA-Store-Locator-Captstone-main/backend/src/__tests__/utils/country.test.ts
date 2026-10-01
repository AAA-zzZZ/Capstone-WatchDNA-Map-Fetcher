import { describe, it, expect } from 'vitest';
import { normalizeCountry, isRecognizedCountryOrTerritory } from '../../utils/country';

describe('normalizeCountry', () => {
  describe('empty / whitespace', () => {
    it('returns empty string for empty input', () => {
      expect(normalizeCountry('')).toBe('');
    });

    it('returns empty string for whitespace-only input', () => {
      expect(normalizeCountry('   ')).toBe('');
    });
  });

  describe('ISO alpha-2 codes — JSON (project-preferred names)', () => {
    it('resolves US → United States', () => {
      expect(normalizeCountry('US')).toBe('United States');
    });

    it('is case-insensitive for codes', () => {
      expect(normalizeCountry('us')).toBe('United States');
    });

    it('resolves GB → United Kingdom', () => {
      expect(normalizeCountry('GB')).toBe('United Kingdom');
    });

    it('resolves HK → Hong Kong (JSON over i18n-iso)', () => {
      expect(normalizeCountry('HK')).toBe('Hong Kong');
    });

    it('resolves TW → Taiwan (not "Taiwan, Province of China")', () => {
      expect(normalizeCountry('TW')).toBe('Taiwan');
    });

    it('resolves KR → South Korea (not "Korea, Republic of")', () => {
      expect(normalizeCountry('KR')).toBe('South Korea');
    });

    it('resolves CZ → Czech Republic (not "Czechia")', () => {
      expect(normalizeCountry('CZ')).toBe('Czech Republic');
    });

    it('resolves CH → Switzerland', () => {
      expect(normalizeCountry('CH')).toBe('Switzerland');
    });
  });

  describe('ISO alpha-2 codes — i18n-iso-countries fallback', () => {
    it('resolves AD → Andorra (not in watch_store_countries.json)', () => {
      expect(normalizeCountry('AD')).toBe('Andorra');
    });

    it('resolves LI → Liechtenstein', () => {
      expect(normalizeCountry('LI')).toBe('Liechtenstein');
    });

    it('resolves MC → Monaco', () => {
      expect(normalizeCountry('MC')).toBe('Monaco');
    });
  });

  describe('aliases', () => {
    it('resolves USA → United States', () => {
      expect(normalizeCountry('USA')).toBe('United States');
    });

    it('resolves U.S.A. → United States', () => {
      expect(normalizeCountry('U.S.A.')).toBe('United States');
    });

    it('resolves United States of America → United States', () => {
      expect(normalizeCountry('United States of America')).toBe('United States');
    });

    it('resolves UK → United Kingdom', () => {
      expect(normalizeCountry('UK')).toBe('United Kingdom');
    });

    it('resolves England → United Kingdom', () => {
      expect(normalizeCountry('England')).toBe('United Kingdom');
    });

    it('resolves UAE → United Arab Emirates', () => {
      expect(normalizeCountry('UAE')).toBe('United Arab Emirates');
    });

    it('resolves Korea → South Korea', () => {
      expect(normalizeCountry('Korea')).toBe('South Korea');
    });

    it('resolves Czechia → Czech Republic', () => {
      expect(normalizeCountry('Czechia')).toBe('Czech Republic');
    });

    it('resolves Taiwan, Province of China → Taiwan', () => {
      expect(normalizeCountry('Taiwan, Province of China')).toBe('Taiwan');
    });

    it('resolves Hong Kong SAR variants → Hong Kong', () => {
      expect(normalizeCountry('Hong Kong SAR')).toBe('Hong Kong');
      expect(normalizeCountry('Hong Kong SAR, China')).toBe('Hong Kong');
      expect(normalizeCountry('Hong Kong SAR. China')).toBe('Hong Kong');
    });

    it('resolves Macau SAR variants → Macau', () => {
      expect(normalizeCountry('Macau SAR')).toBe('Macau');
      expect(normalizeCountry('Macao SAR, China')).toBe('Macau');
    });

    it("resolves People's Republic of China → China", () => {
      expect(normalizeCountry("People's Republic of China")).toBe('China');
      expect(normalizeCountry('PRC')).toBe('China');
    });
  });

  describe('full names — canonical casing', () => {
    it('lowercased full name gets canonical casing', () => {
      expect(normalizeCountry('france')).toBe('France');
    });

    it('uppercased full name gets canonical casing', () => {
      expect(normalizeCountry('FRANCE')).toBe('France');
    });

    it('lowercased "united states" → United States', () => {
      expect(normalizeCountry('united states')).toBe('United States');
    });

    it('lowercased "south korea" → South Korea', () => {
      expect(normalizeCountry('south korea')).toBe('South Korea');
    });
  });

  describe('isRecognizedCountryOrTerritory', () => {
    it('accepts ISO countries and territories (HK, Macau)', () => {
      expect(isRecognizedCountryOrTerritory('Hong Kong')).toBe(true);
      expect(isRecognizedCountryOrTerritory('Hong Kong SAR')).toBe(true);
      expect(isRecognizedCountryOrTerritory('Macau')).toBe(true);
      expect(isRecognizedCountryOrTerritory('Macao')).toBe(true);
    });

    it('rejects typical city names in the country column', () => {
      expect(isRecognizedCountryOrTerritory('Paris')).toBe(false);
      expect(isRecognizedCountryOrTerritory('London')).toBe(false);
      expect(isRecognizedCountryOrTerritory('New York')).toBe(false);
    });

    it('accepts supplier variants after alias normalization', () => {
      expect(normalizeCountry('Macedonia')).toBe('North Macedonia');
      expect(normalizeCountry('Suisse')).toBe('Switzerland');
      expect(isRecognizedCountryOrTerritory('Kingdom of Saudi Arabia')).toBe(true);
    });
  });

  describe('already correct — passthrough', () => {
    it('returns correct full name unchanged', () => {
      expect(normalizeCountry('Switzerland')).toBe('Switzerland');
    });

    it('returns unrecognised value trimmed and unchanged', () => {
      expect(normalizeCountry('  Narnia  ')).toBe('Narnia');
    });
  });
});
