import { describe, expect, it } from 'vitest';
import {
  assessBranch,
  clampAnswers,
  evaluatePolicy,
  type PolicyRule,
  type PolicySubject,
  parsePolicyRules,
} from '../src/index';

const doc = (text: string) => ({
  nodeType: 'document',
  content: [{ nodeType: 'paragraph', content: [{ nodeType: 'text', value: text }] }],
});

const subject: PolicySubject = {
  fields: {
    title: { 'en-US': 'Spring launch' },
    summary: { 'en-US': '' },
    body: {
      'en-US': {
        ...doc('One two three four five'),
        content: [
          ...doc('One two three four five').content,
          {
            nodeType: 'embedded-asset-block',
            data: { target: { id: 'img2', linkType: 'Asset' } },
          },
        ],
      },
    },
    hero: { 'en-US': { id: 'img1', linkType: 'Asset' } },
    related: {
      'en-US': [
        { id: 'e2', linkType: 'Entry' },
        { id: 'e3', linkType: 'Entry' },
      ],
    },
  },
  assetAltText: { img1: { 'en-US': 'A launch photo' }, img2: { 'en-US': '' } },
};

const run = (rules: PolicyRule[], s = subject, now = Date.UTC(2026, 9, 28, 10)) =>
  evaluatePolicy(rules, s, now);

describe('evaluatePolicy', () => {
  it('passes when every rule holds', () => {
    expect(
      run([
        { rule: 'required_fields', fields: ['title'] },
        { rule: 'min_words', field: 'body', words: 5 },
        { rule: 'max_words', field: 'body', words: 5 },
        { rule: 'min_references', field: 'related', count: 2 },
        { rule: 'forbidden_terms', terms: ['lorem'] },
      ]),
    ).toEqual({ pass: true, failures: [] });
  });

  it('collects every failure', () => {
    const r = run([
      { rule: 'required_fields', fields: ['title', 'summary', 'slug'] },
      { rule: 'min_words', field: 'body', words: 6 },
      { rule: 'max_words', field: 'title', words: 1 },
      { rule: 'forbidden_terms', terms: ['launch', 'pring'] },
      { rule: 'has_alt_text' },
      { rule: 'min_references', field: 'related', count: 3 },
    ]);
    expect(r.pass).toBe(false);
    expect(r.failures).toEqual([
      'Missing required fields: summary, slug',
      'body has 5 words; at least 6 needed',
      'title has 2 words; at most 1 allowed',
      'Contains forbidden terms: launch',
      'Images without alt text: img2',
      'related links 2; at least 3 needed',
    ]);
  });

  it('checks business hours in a time zone', () => {
    const rule: PolicyRule = {
      rule: 'business_hours',
      start: 9,
      end: 17,
      days: [1, 2, 3, 4, 5],
      timeZone: 'America/New_York',
    };
    // Wed 2026-10-28 15:00 UTC = 11:00 New York.
    expect(run([rule], subject, Date.UTC(2026, 9, 28, 15)).pass).toBe(true);
    // 10:00 UTC = 06:00 New York.
    expect(run([rule]).failures).toEqual(['Outside business hours (9:00–17:00 America/New_York)']);
  });
});

describe('parsePolicyRules', () => {
  it('fills business_hours defaults', () => {
    expect(parsePolicyRules([{ rule: 'business_hours', start: 9, end: 17 }])).toEqual({
      ok: true,
      rules: [
        { rule: 'business_hours', start: 9, end: 17, days: [1, 2, 3, 4, 5], timeZone: 'UTC' },
      ],
    });
  });

  it('reports bad rules', () => {
    const r = parsePolicyRules([
      { rule: 'min_words', field: 'body', words: -1 },
      { rule: 'business_hours', start: 9, end: 17, timeZone: 'Mars/Base' },
      { rule: 'nope' },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues).toEqual([
        'Rule 1: words must be a whole number',
        'Rule 2: unknown time zone',
        expect.stringMatching(/^Rule 3: rule must be one of/),
      ]);
    }
  });
});

describe('assess helpers', () => {
  it('clamps answers and branches with a confidence floor', () => {
    const answers = clampAnswers(
      { stale: { type: 'noul', instructions: 'Stale?' } },
      { stale: { noul: 0.55 }, extra: { noul: 1 } },
    );
    expect(Object.keys(answers)).toEqual(['stale']);
    expect(assessBranch(answers.stale)).toBe('yes');
    expect(assessBranch(answers.stale, 0.5)).toBe('unsure');
  });
});
