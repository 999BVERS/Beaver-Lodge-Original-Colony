// netlify/functions/stake-nft.js
//
// Stakes a single BLOC NFT for a wallet. Soft-staking only — the NFT never
// moves, no signature required beyond the wallet already being connected.
// Verifies actual on-chain ownership via Helius before recording anything,
// so the frontend can never fake a stake for an NFT it doesn't hold.
//
// Env vars required: SUPABASE_URL, SUPABASE_SERVICE_KEY, HELIUS_API_KEY,
// BLOC_COLLECTION_ADDRESS

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const BLOC_COLLECTION_ADDRESS = process.env.BLOC_COLLECTION_ADDRESS;
const { requireValidSession } = require('./utils/auth');

async function verifyOwnership(wallet, mint) {
  const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'verify-ownership',
      method: 'getAsset',
      params: { id: mint },
    }),
  });
  const data = await res.json();
  const asset = data.result;
  if (!asset) return false;

  const ownerMatches = asset.ownership?.owner === wallet;
  const isBlocCollection = asset.grouping?.some(
    (g) => g.group_key === 'collection' && g.group_value === BLOC_COLLECTION_ADDRESS
  );

  return ownerMatches && isBlocCollection;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let wallet, mint;
  try {
    const body = JSON.parse(event.body);
    wallet = body.wallet;
    mint = body.mint;
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  if (!wallet || !mint) {
    return { statusCode: 400, body: JSON.stringify({ error: 'wallet and mint are required' }) };
  }

  if (!requireValidSession(event, wallet)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired session — please reconnect your wallet' }) };
  }

  try {
    const owns = await verifyOwnership(wallet, mint);
    if (!owns) {
      return {
        statusCode: 403,
        body: JSON.stringify({ error: 'Wallet does not currently hold this BLOC NFT' }),
      };
    }

    // Check if this mint already has an active stake record (by anyone)
    const existingRes = await fetch(
      `${SUPABASE_URL}/rest/v1/staked_nfts?mint=eq.${mint}&active=eq.true&select=id,wallet`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
      }
    );
    const existing = await existingRes.json();

    if (existing.length > 0) {
      if (existing[0].wallet === wallet) {
        return { statusCode: 200, body: JSON.stringify({ message: 'Already staked' }) };
      }
      // Stale record from a previous owner who never unstaked before selling —
      // deactivate it before creating the new one.
      await fetch(`${SUPABASE_URL}/rest/v1/staked_nfts?id=eq.${existing[0].id}`, {
        method: 'PATCH',
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ active: false }),
      });
    }

    // Insert new stake record
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/staked_nfts`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({ wallet, mint, active: true }),
    });

    if (!insertRes.ok) {
      throw new Error(`Insert failed: ${insertRes.status}`);
    }

    return { statusCode: 200, body: JSON.stringify({ message: 'Staked successfully' }) };
  } catch (err) {
    console.error('stake-nft error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to stake NFT' }) };
  }
};
