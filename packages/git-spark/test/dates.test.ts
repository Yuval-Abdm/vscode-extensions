import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { relativeTime, shortDate } from '../src/shared/dates.ts';

const now = Date.parse('2026-10-06T12:00:00Z');
const at = (iso: string) => Date.parse(iso) / 1000;

describe('relativeTime', () => {
  it('anglais', () => {
    assert.equal(relativeTime(at('2026-10-06T11:59:30Z'), now, 'en'), 'now');
    assert.equal(relativeTime(at('2026-10-06T11:55:00Z'), now, 'en'), '5 minutes ago');
    assert.equal(relativeTime(at('2026-10-06T10:00:00Z'), now, 'en'), '2 hours ago');
    assert.equal(relativeTime(at('2026-10-05T12:00:00Z'), now, 'en'), 'yesterday');
    assert.equal(relativeTime(at('2026-10-03T12:00:00Z'), now, 'en'), '3 days ago');
    assert.equal(relativeTime(at('2026-09-22T12:00:00Z'), now, 'en'), '2 weeks ago');
    assert.equal(relativeTime(at('2026-06-06T12:00:00Z'), now, 'en'), '4 months ago');
    assert.equal(relativeTime(at('2023-10-06T12:00:00Z'), now, 'en'), '3 years ago');
  });

  it('français', () => {
    assert.equal(relativeTime(at('2026-10-03T12:00:00Z'), now, 'fr'), 'il y a 3 jours');
    assert.equal(relativeTime(at('2026-10-05T12:00:00Z'), now, 'fr'), 'hier');
  });
});

describe('shortDate', () => {
  it('jour, mois, année sur deux chiffres', () => {
    assert.equal(shortDate(at('2026-02-01T10:00:00Z'), 'fr'), '01/02/2026');
    assert.equal(shortDate(at('2026-02-01T10:00:00Z'), 'en'), '02/01/2026');
  });
});
