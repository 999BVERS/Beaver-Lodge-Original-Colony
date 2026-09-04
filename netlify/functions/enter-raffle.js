// netlify/functions/enter-raffle.js
//
// Buys one raffle entry. Each call = one entry = one row in raffle_entries
// (more entries = proportionally better odds, since draw-raffle.js picks a
// uniformly random ROW, not a random WALLET).
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

async function refund(wallet, amount) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/refund_chew`, {
      method: 'POST',
      headers: sbHeaders,
      body: JSON.stringify({ p_wallet: wallet, p_amount: amount }),
    });
  } catch (e) {
    console.error('CRITICAL: refund_chew failed after a raffle entry spend that could not be recorded', { wallet, amount, error: e.message });
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let wallet, raffleId, xUsername;
  try {
    const body = JSON.parse(event.body);
    wallet = body.wallet;
    raffleId = body.raffleId;
    xUsername = (body.xUsername || '').trim().replace(/^@/, ''); // strip leading @ for consistency
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  if (!wallet || !raffleId || !xUsername) {
    return { statusCode: 400, body: JSON.stringify({ error: 'wallet, raffleId, and xUsername are required' }) };
  }

  if (!requireValidSession(event, wallet)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired session — please reconnect your wallet' }) };
  }

  try {
    // 1. Confirm the raffle is real, active, and not expired.
    const raffleRes = await fetch(
      `${SUPABASE_URL}/rest/v1/raffles?id=eq.${raffleId}&select=id,status,ends_at,entry_cost,max_entries_per_wallet`,
      { headers: sbHeaders }
    );
    const raffles = await raffleRes.json();
    if (!Array.isArray(raffles) || raffles.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Raffle not found' }) };
    }
    const raffle = raffles[0];

    if (raffle.status !== 'active') {
      return { statusCode: 410, body: JSON.stringify({ error: 'This raffle is no longer accepting entries' }) };
    }
    if (new Date(raffle.ends_at) <= new Date()) {
      return { statusCode: 410, body: JSON.stringify({ error: 'This raffle has ended' }) };
    }

    // 2. Enforce the per-wallet entry cap AND username consistency — once
    // a wallet has entered this raffle with a given X username, every
    // additional entry for the SAME raffle must use that same username. A
    // different username is only allowed for a different (future) raffle.
    const existingRes = await fetch(
      `${SUPABASE_URL}/rest/v1/raffle_entries?raffle_id=eq.${raffleId}&wallet=eq.${wallet}&select=id,x_username`,
      { headers: sbHeaders }
    );
    const existing = await existingRes.json();
    const currentEntryCount = Array.isArray(existing) ? existing.length : 0;

    if (currentEntryCount >= raffle.max_entries_per_wallet) {
      return {
        statusCode: 403,
        body: JSON.stringify({ error: `You've already used the max ${raffle.max_entries_per_wallet} entries for this raffle` }),
      };
    }

    if (currentEntryCount > 0) {
      const lockedUsername = existing[0].x_username;
      if (lockedUsername.toLowerCase() !== xUsername.toLowerCase()) {
        return {
          statusCode: 409,
          body: JSON.stringify({
            error: `You already entered this raffle as @${lockedUsername} — use that same username for additional entries.`,
            lockedUsername,
          }),
        };
      }
    }

    // 3. Atomically deduct the entry cost.
    const cost = raffle.entry_cost;
    const spendRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/spend_chew`, {
      method: 'POST',
      headers: sbHeaders,
      body: JSON.stringify({ p_wallet: wallet, p_amount: cost }),
    });
    if (!spendRes.ok) throw new Error(`spend_chew RPC failed: ${spendRes.status}`);

    const spendResult = await spendRes.json();
    const { success, new_balance } = Array.isArray(spendResult) ? spendResult[0] : spendResult;

    if (!success) {
      return { statusCode: 402, body: JSON.stringify({ error: 'Insufficient $CHEW balance', balance: new_balance }) };
    }

    // 4. Record the entry.
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/raffle_entries`, {
      method: 'POST',
      headers: sbHeaders,
      body: JSON.stringify({ raffle_id: raffleId, wallet, x_username: xUsername }),
    });

    if (!insertRes.ok) {
      await refund(wallet, cost);
      throw new Error(`Failed to record raffle entry: ${insertRes.status}`);
    }

    // 5. Audit trail.
    await fetch(`${SUPABASE_URL}/rest/v1/point_ledger`, {
      method: 'POST',
      headers: sbHeaders,
      body: JSON.stringify({
        wallet,
        amount: -cost,
        reason: `raffle_entry (${raffleId})`,
      }),
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Entry confirmed',
        newBalance: new_balance,
        newEntryCount: currentEntryCount + 1,
      }),
    };
  } catch (err) {
    console.error('enter-raffle error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to enter raffle' }) };
  }
};
