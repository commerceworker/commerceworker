import { describe, expect, it } from 'vitest';
import {
  redactApiTokens,
  redactBearerTokens,
  redactCredentials,
  redactUrlCredentials,
} from '../src/index';

describe('redactUrlCredentials', () => {
  it('masks the password but keeps user and host, which make a log diagnosable', () => {
    expect(
      redactUrlCredentials('connect failed: mysql://db_owner:hunter2@db-x.example.com/db'),
    ).toBe('connect failed: mysql://db_owner:***@db-x.example.com/db');
  });

  it('handles any URL scheme', () => {
    expect(redactUrlCredentials('amqp://user:pw@cache:6379')).toBe('amqp://user:***@cache:6379');
    expect(redactUrlCredentials('mysql://u:p@h/d')).toBe('mysql://u:***@h/d');
    expect(redactUrlCredentials('https://key:secret@api.example.com')).toBe(
      'https://key:***@api.example.com',
    );
  });

  it('masks several URLs in one message', () => {
    expect(redactUrlCredentials('a mysql://u:p1@h1/d and amqp://v:p2@h2')).toBe(
      'a mysql://u:***@h1/d and amqp://v:***@h2',
    );
  });

  it('leaves a URL without credentials alone', () => {
    expect(redactUrlCredentials('https://api.example.com/v1')).toBe('https://api.example.com/v1');
    // A port is not a password.
    expect(redactUrlCredentials('mysql://host:5432/db')).toBe('mysql://host:5432/db');
  });

  it('leaves text with no URL untouched', () => {
    expect(redactUrlCredentials('nothing to see')).toBe('nothing to see');
  });
});

describe('redactBearerTokens', () => {
  it('masks a bearer token in a header echo', () => {
    expect(redactBearerTokens('Authorization: Bearer abc123def456ghi')).toBe(
      'Authorization: Bearer ***',
    );
  });

  it('is case-insensitive', () => {
    expect(redactBearerTokens('bearer abc123def456')).toBe('bearer ***');
  });

  it('ignores the bare word', () => {
    expect(redactBearerTokens('bearer of bad news')).toBe('bearer of bad news');
  });
});

describe('redactApiTokens', () => {
  it('masks the secret but keeps the kind', () => {
    // Which *kind* of key was rejected is diagnostic; the secret is not.
    expect(redactApiTokens('rejected cwk_cma_7f3a9b2c1d4e5f60')).toBe('rejected cwk_cma_***');
    expect(redactApiTokens('cwk_cda_abc123def')).toBe('cwk_cda_***');
  });

  it('leaves a prefix with no secret alone', () => {
    expect(redactApiTokens('token shape is cwk_cma_')).toBe('token shape is cwk_cma_');
  });
});

describe('redactCredentials', () => {
  it('applies every rule at once', () => {
    const message =
      'POST https://api.x/y failed for cwk_cma_7f3a9b2c1d4e using Bearer abc123def456: ' +
      'mysql://u:hunter2@db-x.example.com/db';

    const redacted = redactCredentials(message);

    expect(redacted).not.toContain('hunter2');
    expect(redacted).not.toContain('abc123def456');
    expect(redacted).not.toContain('7f3a9b2c1d4e');
    // Everything diagnosable survives.
    expect(redacted).toContain('db-x.example.com');
    expect(redacted).toContain('cwk_cma_');
    expect(redacted).toContain('https://api.x/y');
  });

  it('accepts an Error directly, which is the shape at a catch boundary', () => {
    const err = new Error('connect failed: mysql://u:hunter2@h/d');
    expect(redactCredentials(err)).toBe('Error: connect failed: mysql://u:***@h/d');
  });

  it('accepts a non-error value without throwing', () => {
    expect(redactCredentials(undefined)).toBe('undefined');
    expect(redactCredentials(42)).toBe('42');
    expect(redactCredentials(null)).toBe('null');
  });

  it('is idempotent — redacting twice changes nothing', () => {
    const once = redactCredentials('mysql://u:hunter2@h/d');
    expect(redactCredentials(once)).toBe(once);
  });
});
