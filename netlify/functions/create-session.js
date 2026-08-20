// netlify/functions/create-session.js
//
// Verifies a signed message from a connected wallet, proving the caller
// genuinely controls the private key for that address (not just typing
// in someone else's public address). Issues a short-lived session token
// on success — this token is required by every write action afterward.
//
// This does NOT move funds, does NOT approve any transaction, and costs
// no gas. It's a plain message signature, the same low-risk action as
// "Sign-In with Solana" used across the ecosystem.
//
// Env var required: SESSION_SECRET

const nacl = require('tweetnacl');
const bs58 = require('bs58');
const { signSession } = require('./utils/auth');

const MESSAGE_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let wallet, message, signature;
  try {
    const body = JSON.parse(event.body);
    wallet = body.wallet;
    message = body.message;
    signature = body.signature; // array of numbers (Uint8Array serialized)
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  if (!wallet || !message || !signature) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'wallet, message, and signature are required' }),
    };
  }

  // The signed message must contain a recent timestamp, so old captured
  // signatures can't be replayed later to create a fresh session.
  const timestampMatch = message.match(/(\d{13})/);
  if (!timestampMatch) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid message format' }) };
  }
  const messageTimestamp = parseInt(timestampMatch[1], 10);
  if (Math.abs(Date.now() - messageTimestamp) > MESSAGE_MAX_AGE_MS) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Message expired — please reconnect your wallet' }),
    };
  }

  try {
    const publicKeyBytes = bs58.decode(wallet);
    const messageBytes = new TextEncoder().encode(message);
    const signatureBytes = Uint8Array.from(signature);

    const isValid = nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);

    if (!isValid) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Signature verification failed' }) };
    }

    const { token, expiresAt } = signSession(wallet);

    return {
      statusCode: 200,
      body: JSON.stringify({ token, expiresAt }),
    };
  } catch (err) {
    console.error('create-session error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to create session' }) };
  }
};
