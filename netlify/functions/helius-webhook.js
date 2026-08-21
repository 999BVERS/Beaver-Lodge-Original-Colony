// netlify/functions/helius-webhook.js
//
// Receives real-time transfer notifications from Helius for every mint in
// the BLOC collection (see helius-webhook-setup.js for how that watch list
// gets configured). If a mint that's actively staked moves to a different
// wallet, its stake is deactivated immediately — this is the fast path;
// calculate-points' live re-check is the daily safety net in case this
// webhook is ever missed or delayed.
//
// Security: Helius echoes back whatever `authHeader` value the webhook was
// created with, on every delivery, in the Authorization header. We compare
// that against HELIUS_WEBHOOK_SECRET so a random POST to this URL can't
// trigger unstaking. This is a shared secret, not a signature — treat
// HELIUS_WEBHOOK_SECRET like a password.
//
// Env vars required: SUPABASE_URL, SUPABASE_SERVICE_KEY, HELIUS_WEBHOOK_SECRET

const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const HELIUS_WEBHOOK_SECRET = process.env.HELIUS_WEBHOOK_SECRET;

const sbHeaders = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

function isAuthorized(event) {
  const provided = event.headers?.authorization || event.headers?.Authorization || '';
  const expected = HELIUS_WEBHOOK_SECRET || '';
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // Buffers of different length would throw in timingSafeEqual, so guard first.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (!isAuthorized(event)) {
    // Wrong/missing secret — could be a stray request or a misconfigured
    // webhook. Reject without leaking why.
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let transactions;
  try {
    transactions = JSON.parse(event.body);
    if (!Array.isArray(transactions)) transactions = [transactions];
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid payload' }) };
  }

  try {
    // Collect every (mint, newOwner) pair implied by this batch of
    // transactions' NFT-sized token transfers (amount === 1, decimals 0).
    const transfers = [];
    for (const tx of transactions) {
      const tokenTransfers = tx.tokenTransfers || [];
      for (const t of tokenTransfers) {
        if (!t.mint || !t.toUserAccount) continue;
        // NFTs move as a single indivisible token; this filters out
        // fungible token transfers that might share the same webhook.
        if (t.tokenAmount !== 1) continue;
        transfers.push({ mint: t.mint, toWallet: t.toUserAccount, fromWallet: t.fromUserAccount });
      }
    }

    if (transfers.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ message: 'No relevant transfers' }) };
    }

    for (const { mint, toWallet, fromWallet } of transfers) {
      // Find an active stake for this mint, regardless of which wallet we
      // think it belongs to — the on-chain transfer is the source of truth.
      const findRes = await fetch(
        `${SUPABASE_URL}/rest/v1/staked_nfts?mint=eq.${mint}&active=eq.true&select=id,wallet`,
        { headers: sbHeaders }
      );
      const found = await findRes.json();

      if (!Array.isArray(found) || found.length === 0) continue; // not staked, nothing to do

      const stakeRow = found[0];

      // If it moved to the same wallet that already had it staked (e.g. a
      // wrapped/rewrapped transaction), there's nothing to unstake.
      if (stakeRow.wallet === toWallet) continue;

      await fetch(`${SUPABASE_URL}/rest/v1/staked_nfts?id=eq.${stakeRow.id}`, {
        method: 'PATCH',
        headers: sbHeaders,
        body: JSON.stringify({ active: false }),
      });

      console.log(`Auto-unstaked ${mint}: transferred from ${fromWallet || stakeRow.wallet} to ${toWallet}`);
    }

    return { statusCode: 200, body: JSON.stringify({ processed: transfers.length }) };
  } catch (err) {
    console.error('helius-webhook error:', err);
    // Still return 200 here — Helius retries failed deliveries, and a bug
    // in our processing shouldn't cause Helius to hammer this endpoint.
    // calculate-points' daily re-check covers us if an event is truly lost.
    return { statusCode: 200, body: JSON.stringify({ error: 'Processing error, logged' }) };
  }
};
