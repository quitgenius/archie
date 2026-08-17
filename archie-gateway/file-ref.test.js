'use strict';

const crypto = require('node:crypto');
const { generateFileRef, parseFileRef } = require('./file-ref');

const SECRET = 'test-dispatcher-secret-1234';
const FILE_ID = 'F08ABC123';

describe('generateFileRef', () => {
  it('returns a base64url-encoded string', () => {
    const ref = generateFileRef(FILE_ID, SECRET);
    expect(typeof ref).toBe('string');
    expect(ref).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('encodes fileId, expiry, and hmac', () => {
    const ref = generateFileRef(FILE_ID, SECRET);
    const decoded = Buffer.from(ref, 'base64url').toString('utf8');
    const parts = decoded.split('.');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe(FILE_ID);
    expect(Number(parts[1])).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(parts[2]).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces different refs for different file IDs', () => {
    const ref1 = generateFileRef('F001', SECRET);
    const ref2 = generateFileRef('F002', SECRET);
    expect(ref1).not.toBe(ref2);
  });

  it('produces different refs for different secrets', () => {
    const ref1 = generateFileRef(FILE_ID, 'secret-a');
    const ref2 = generateFileRef(FILE_ID, 'secret-b');
    expect(ref1).not.toBe(ref2);
  });

  it('respects custom ttlMs', () => {
    const ref = generateFileRef(FILE_ID, SECRET, { ttlMs: 5000 });
    const decoded = Buffer.from(ref, 'base64url').toString('utf8');
    const expiry = Number(decoded.split('.')[1]);
    const nowSec = Math.floor(Date.now() / 1000);
    expect(expiry).toBeGreaterThanOrEqual(nowSec + 4);
    expect(expiry).toBeLessThanOrEqual(nowSec + 6);
  });
});

describe('parseFileRef', () => {
  it('validates a freshly generated ref', () => {
    const ref = generateFileRef(FILE_ID, SECRET);
    const result = parseFileRef(ref, SECRET);
    expect(result).toEqual({ valid: true, fileId: FILE_ID });
  });

  it('rejects a ref signed with a different secret', () => {
    const ref = generateFileRef(FILE_ID, 'wrong-secret');
    const result = parseFileRef(ref, SECRET);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('invalid_signature');
  });

  it('rejects an expired ref', () => {
    const ref = generateFileRef(FILE_ID, SECRET, { ttlMs: -1000 });
    const result = parseFileRef(ref, SECRET);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('expired');
  });

  it('rejects garbage input', () => {
    const result = parseFileRef('not-a-valid-ref!!!', SECRET);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('malformed_ref');
  });

  it('rejects empty string', () => {
    const result = parseFileRef('', SECRET);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('malformed_ref');
  });

  it('rejects a ref with tampered fileId', () => {
    const ref = generateFileRef(FILE_ID, SECRET);
    const decoded = Buffer.from(ref, 'base64url').toString('utf8');
    const parts = decoded.split('.');
    parts[0] = 'F_TAMPERED';
    const tampered = Buffer.from(parts.join('.')).toString('base64url');
    const result = parseFileRef(tampered, SECRET);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('invalid_signature');
  });

  it('rejects a ref with tampered expiry', () => {
    const ref = generateFileRef(FILE_ID, SECRET);
    const decoded = Buffer.from(ref, 'base64url').toString('utf8');
    const parts = decoded.split('.');
    parts[1] = String(Number(parts[1]) + 9999);
    const tampered = Buffer.from(parts.join('.')).toString('base64url');
    const result = parseFileRef(tampered, SECRET);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('invalid_signature');
  });

  it('rejects a ref with only two parts', () => {
    const tampered = Buffer.from('F001.12345').toString('base64url');
    const result = parseFileRef(tampered, SECRET);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('malformed_ref');
  });

  it('rejects a ref with four parts', () => {
    const tampered = Buffer.from('F001.12345.abc.extra').toString('base64url');
    const result = parseFileRef(tampered, SECRET);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('malformed_ref');
  });

  it('roundtrips with various file IDs', () => {
    const ids = ['F08ABC123', 'FABCDEF', 'F000000001', 'F_with_underscores'];
    for (const id of ids) {
      const ref = generateFileRef(id, SECRET);
      const result = parseFileRef(ref, SECRET);
      expect(result).toEqual({ valid: true, fileId: id });
    }
  });
});
