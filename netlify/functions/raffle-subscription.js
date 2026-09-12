// netlify/functions/raffle-subscription.js
//
// Lets a connected holder view, set, or remove their raffle-alert email
// (the opt-in box on the staking page, near the raffle card):
//   GET    → { subscribed, email }  — their current subscription, if any
//   POST   { wallet, email } → subscribe, or update the email on file
//   DELETE { wallet }        → unsubscribe
//
// All three require the same wallet session token as every other write
// action (see utils/auth.js) — GET included, so nobody can look up which
// email is on file for a wallet they don't control.
//
// Env vars required: SUPABASE_URL, SUPABASE_SERVICE_KEY

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const { requireValidSession } = require('./utils/auth');

const sbHeaders = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

exports.handler = async (event) => {
  const method = event.httpMethod;
  let wallet = null;
  let email = null;

  if (method === 'GET') {
    wallet = event.queryStringParameters?.wallet || null;
  } else if (method === 'POST' || method === 'DELETE') {
    try {
      const body = JSON.parse(event.body || '{}');
      wallet = body.wallet;
      email = typeof body.email === 'string' ? body.email.trim() : null;
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
    }
  } else {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (!wallet) {
    return { statusCode: 400, body: JSON.stringify({ error: 'wallet is required' }) };
  }
  if (!requireValidSession(event, wallet)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired session — please reconnect your wallet' }) };
  }

  try {
    if (method === 'GET') {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/raffle_subscribers?wallet=eq.${wallet}&select=email`,
        { headers: sbHeaders }
      );
      const rows = await res.json();
      const current = Array.isArray(rows) && rows[0] ? rows[0].email : null;
      return { statusCode: 200, body: JSON.stringify({ subscribed: !!current, email: current }) };
    }

    if (method === 'POST') {
      if (!email || !EMAIL_RE.test(email)) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Please enter a valid email address' }) };
      }

      const res = await fetch(`${SUPABASE_URL}/rest/v1/raffle_subscribers?on_conflict=wallet`, {
        method: 'POST',
        headers: { ...sbHeaders, Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({ wallet, email }),
      });
      if (!res.ok) throw new Error(`Failed to save subscription: ${res.status}`);

      return { statusCode: 200, body: JSON.stringify({ subscribed: true, email }) };
    }

    if (method === 'DELETE') {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/raffle_subscribers?wallet=eq.${wallet}`, {
        method: 'DELETE',
        headers: sbHeaders,
      });
      if (!res.ok) throw new Error(`Failed to unsubscribe: ${res.status}`);

      return { statusCode: 200, body: JSON.stringify({ subscribed: false }) };
    }
  } catch (err) {
    console.error('raffle-subscription error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to update subscription' }) };
  }
};
