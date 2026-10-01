import { describe, it, expect } from 'vitest';
import {
  brandConfigIdToDisplayName,
  normalizeBrandsCsvField,
  normalizeTagsCsvField,
  removeBrandFromCsvField,
  removeBrandsFromCustomBrandsField,
} from '../../utils/brand-display-name';

describe('brandConfigIdToDisplayName', () => {
  it('strips _stores and uppercases', () => {
    expect(brandConfigIdToDisplayName('accutron_stores')).toBe('ACCUTRON');
    expect(brandConfigIdToDisplayName('breva_stores')).toBe('BREVA');
  });

  it('maps known multi-word brands', () => {
    expect(brandConfigIdToDisplayName('bell_ross_stores')).toBe('BELL & ROSS');
  });

  it('merges spelling variants for premium / map filters', () => {
    expect(brandConfigIdToDisplayName('tagheuer_stores')).toBe('TAG HEUER');
    expect(brandConfigIdToDisplayName('TAG-HEUER')).toBe('TAG HEUER');
    expect(brandConfigIdToDisplayName('baume_mercier')).toBe('BAUME & MERCIER');
    expect(brandConfigIdToDisplayName('citizen_watch_stores')).toBe('CITIZEN');
    // "ball_watch" config id and stored "BALL WATCH"/"BALL WATCHES" variants all
    // collapse to the canonical BALL so the map filter shows one checkbox.
    expect(brandConfigIdToDisplayName('ball_watch')).toBe('BALL');
    expect(brandConfigIdToDisplayName('BALL WATCH')).toBe('BALL');
    expect(brandConfigIdToDisplayName('Ball Watches')).toBe('BALL');
    expect(brandConfigIdToDisplayName('BALL')).toBe('BALL');
  });

  it('leaves already-clean tokens uppercased', () => {
    expect(brandConfigIdToDisplayName('OMEGA')).toBe('OMEGA');
  });

  it('normalizes manually-added config ids into display names', () => {
    expect(brandConfigIdToDisplayName('tudor_watches')).toBe('TUDOR');
    expect(brandConfigIdToDisplayName('hamilton_stores')).toBe('HAMILTON');
  });

  it('strips simple HTML in a single token (scraper/CSV error)', () => {
    expect(
      brandConfigIdToDisplayName(
        '<A HREF="HTTPS://WATCHDNA.COM/BLOGS/HISTORY/HAMILTON">HAMILTON'
      )
    ).toBe('HAMILTON');
  });

  it('drops truncated anchor markup and leading quote-greater-than junk', () => {
    expect(
      brandConfigIdToDisplayName('<A HREF="HTTPS://WATCHDNA.COM/BLOGS/HISTORY/FLIK-FLAK')
    ).toBe('');
    expect(brandConfigIdToDisplayName('">FLIK FLAK')).toBe('FLIK FLAK');
  });

  it('drops address-like lines mistaken for a brand', () => {
    expect(brandConfigIdToDisplayName('88 RUE DU RHONE')).toBe('');
  });
});

describe('normalizeBrandsCsvField', () => {
  it('dedupes case-insensitively', () => {
    expect(normalizeBrandsCsvField('omega, OMEGA, omega_stores')).toBe('OMEGA');
  });
});

describe('removeBrandFromCsvField', () => {
  it('removes one brand and keeps the stored form of the rest', () => {
    expect(removeBrandFromCsvField('TAG HEUER, ROLEX, OMEGA', 'ROLEX')).toBe('TAG HEUER, OMEGA');
  });

  it('removes spelling variants of the target together', () => {
    expect(removeBrandFromCsvField('BALL WATCH, OMEGA', 'BALL')).toBe('OMEGA');
    expect(removeBrandFromCsvField('TAG-HEUER, ROLEX', 'tagheuer_stores')).toBe('ROLEX');
  });

  it('returns null when nothing remains', () => {
    expect(removeBrandFromCsvField('ROLEX', 'ROLEX')).toBeNull();
    expect(removeBrandFromCsvField('', 'ROLEX')).toBeNull();
    expect(removeBrandFromCsvField(null, 'ROLEX')).toBeNull();
  });

  it('leaves the field alone when the brand is not present', () => {
    expect(removeBrandFromCsvField('OMEGA, TISSOT', 'ROLEX')).toBe('OMEGA, TISSOT');
  });
});

describe('removeBrandsFromCustomBrandsField', () => {
  it('removes matching anchor links and keeps the rest', () => {
    const html = '<a href="https://watchdna.com/blogs/history/MARATHON">MARATHON</A>, <a href="https://watchdna.com/blogs/history/ROLEX">ROLEX</a>';
    expect(removeBrandsFromCustomBrandsField(html, ['MARATHON'])).toBe(
      '<a href="https://watchdna.com/blogs/history/ROLEX">ROLEX</a>'
    );
  });

  it('returns null when the last anchor is removed', () => {
    const html = '<a href="https://watchdna.com/blogs/history/MARATHON">MARATHON</A>';
    expect(removeBrandsFromCustomBrandsField(html, ['marathon'])).toBeNull();
  });

  it('handles plain comma-separated values and spelling variants', () => {
    expect(removeBrandsFromCustomBrandsField('BALL WATCH, OMEGA', ['BALL'])).toBe('OMEGA');
  });

  it('leaves the field alone when nothing was removed', () => {
    const html = '<a href="x">ROLEX</a>';
    expect(removeBrandsFromCustomBrandsField(html, [])).toBe(html);
    expect(removeBrandsFromCustomBrandsField(html, ['OMEGA'])).toBe(html);
    expect(removeBrandsFromCustomBrandsField(null, ['OMEGA'])).toBeNull();
  });
});

describe('normalizeTagsCsvField', () => {
  it('rewrites only *_stores-like tokens', () => {
    expect(normalizeTagsCsvField('accutron_stores, boutique')).toBe('ACCUTRON, boutique');
  });
});
