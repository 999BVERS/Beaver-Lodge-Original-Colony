// netlify/functions/unstake-nft.js
//
// Unstakes an NFT — marks the staked_nfts row inactive rather than deleting
// it, preserving history (e.g. for later "days staked" calculations).
// The NFT was never moved on-chain, so there's nothing to transfer back;
// this just stops it from accruing $CHEW going forward.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const { requireValidSession } = require('./utils/auth');

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
    // Only allow unstaking a mint that's actively staked BY THIS wallet —
    // prevents one wallet from unstaking another wallet's NFT via a crafted request.
    const findRes = await fetch(
      `${SUPABASE_URL}/rest/v1/staked_nfts?mint=eq.${mint}&wallet=eq.${wallet}&active=eq.true&select=id`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
      }
    );
    const found = await findRes.json();

    if (found.length === 0) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'No active stake found for this wallet/mint' }),
      };
    }

    const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/staked_nfts?id=eq.${found[0].id}`, {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ active: false }),
    });

    if (!patchRes.ok) {
      throw new Error(`Update failed: ${patchRes.status}`);
    }

    return { statusCode: 200, body: JSON.stringify({ message: 'Unstaked successfully' }) };
  } catch (err) {
    console.error('unstake-nft error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to unstake NFT' }) };
  }
};
