// netlify/functions/utils/auth.js
//
// Lightweight session tokens issued after a wallet proves ownership via
// signature (see create-session.js). Every write action (stake, unstake,
// fell-tree, etc.) requires a valid token whose wallet matches the wallet
// in the request body — this is what prevents anyone from impersonating
// another wallet in API calls.
//
// Env var required: SESSION_SECRET (a long random string, set in Netlify)

const crypto = require('crypto');

const SESSION_SECRET = process.env.SESSION_SECRET;
const SESSION_DURATION_MS = 60 * 60 * 1000; // 1 hour

function signSession(wallet) {
  const expiresAt = Date.now() + SESSION_DURATION_MS;
  const payload = `${wallet}.${expiresAt}`;
  const hmac = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  const token = Buffer.from(`${payload}.${hmac}`).toString('base64');
  return { token, expiresAt };
}

function verifySession(token, expectedWallet) {
  if (!token || !expectedWallet) return false;
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const parts = decoded.split('.');
    if (parts.length !== 3) return false;
    const [wallet, expiresAtStr, hmac] = parts;

    const payload = `${wallet}.${expiresAtStr}`;
    const expectedHmac = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');

    // Constant-time comparison to avoid timing attacks
    const a = Buffer.from(hmac);
    const b = Buffer.from(expectedHmac);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;

    if (Date.now() > parseInt(expiresAtStr, 10)) return false;
    if (wallet !== expectedWallet) return false;

    return true;
  } catch (e) {
    return false;
  }
}

// Extracts and verifies the session token from an event's Authorization header.
// Returns true/false. Use at the top of every write-action function.
function requireValidSession(event, wallet) {
  const authHeader = event.headers?.authorization || event.headers?.Authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
  const token = authHeader.slice(7);
  return verifySession(token, wallet);
}

module.exports = { signSession, verifySession, requireValidSession };
