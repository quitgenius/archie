'use strict';

const crypto = require('node:crypto');

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

function generateFileRef(fileId, secret, { ttlMs = DEFAULT_TTL_MS } = {}) {
  const expiry = Math.floor((Date.now() + ttlMs) / 1000);
  const payload = `${fileId}.${expiry}`;
  const hmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return Buffer.from(`${payload}.${hmac}`).toString('base64url');
}

function parseFileRef(ref, secret) {
  let decoded;
  try {
    decoded = Buffer.from(ref, 'base64url').toString('utf8');
  } catch {
    return { valid: false, error: 'malformed_ref' };
  }
  const parts = decoded.split('.');
  if (parts.length !== 3) return { valid: false, error: 'malformed_ref' };
  const [fileId, expiryStr, hmac] = parts;
  const expiry = parseInt(expiryStr, 10);
  if (!fileId || !expiry || !hmac) return { valid: false, error: 'malformed_ref' };

  const expected = crypto.createHmac('sha256', secret)
    .update(`${fileId}.${expiryStr}`).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expected))) {
    return { valid: false, error: 'invalid_signature' };
  }
  if (Math.floor(Date.now() / 1000) > expiry) {
    return { valid: false, error: 'expired' };
  }
  return { valid: true, fileId };
}

module.exports = { generateFileRef, parseFileRef, DEFAULT_TTL_MS };
