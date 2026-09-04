// netlify/functions/unstake-nft.js
//
// Unstakes an NFT — marks the staked_nfts row inactive rather than deleting
// it, preserving history.
//
// Collab bonus is now read from the collab_holdings cache table (written by
// verify-holdings.js on wallet connect) instead of calling Helius directly,
// saving an API call and improving response time.
//
// Env vars required: SUPABASE_URL, SUPABASE_SERVICE_KEY, HELIUS_API_KEY,
// BLOC_COLLECTION_ADDRESS

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BLOC_COLLECTION_ADDRESS = process.env.BLOC_COLLECTION_ADDRESS;
const { requireValidSession } = require('./utils/auth');

const sbHeaders = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

// Reads collab bonus from the collab_holdings cache instead of calling
// Helius — verify-holdings.js writes this on every wallet connect so
// it's always fresh relative to when the user last loaded the staking page.
async function getCollabBonusPercent(wallet) {
  // Get this wallet's cached collab holdings
  const holdingsRes = await fetch(
    `${SUPABASE_URL}/rest/v1/collab_holdings?wallet=eq.${wallet}&select=collection_address,nft_count`,
    { headers: sbHeaders }
  );
  const holdings = await holdingsRes.json();

  if (!Array.isArray(holdings) || holdings.length === 0) return 0;

  // Get active collab collection rates
  const collabRes = await fetch(
    `${SUPABASE_URL}/rest/v1/collab_collections?active=eq.true&select=collection_address,bonus_per_nft,max_bonus`,
    { headers: sbHeaders }
  );
  const collabCollections = await collabRes.json();

  let bonusPercent = 0;
  for (const holding of holdings) {
    const project = collabCollections.find(
      (c) => c.collection_address === holding.collection_address
    );
    if (!project) continue;
    const perNft = project.bonus_per_nft ?? 1;
    const maxBonus = project.max_bonus ?? 5;
    bonusPercent += Math.min(holding.nft_count * perNft, maxBonus);
  }
  return bonusPercent;
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
    // Only allow unstaking a mint that's actively staked BY THIS wallet
    const findRes = await fetch(
      `${SUPABASE_URL}/rest/v1/staked_nfts?mint=eq.${mint}&wallet=eq.${wallet}&active=eq.true&select=id,staked_at`,
      { headers: sbHeaders }
    );
    const found = await findRes.json();

    if (found.length === 0) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'No active stake found for this wallet/mint' }),
      };
    }

    const stakeRow = found[0];

    // Calculate how much this NFT has earned since last confirmed payout
    const balanceRes = await fetch(
      `${SUPABASE_URL}/rest/v1/point_balances?wallet=eq.${wallet}&select=last_daily_payout_at`,
      { headers: sbHeaders }
    );
    const balanceData = await balanceRes.json();
    const lastPayoutTime = balanceData[0]?.last_daily_payout_at
      ? new Date(balanceData[0].last_daily_payout_at).getTime()
      : null;
    const stakedAtMs = new Date(stakeRow.staked_at).getTime();
    const anchor = lastPayoutTime ? Math.max(lastPayoutTime, stakedAtMs) : stakedAtMs;

    const elapsedSeconds = Math.min(86400, Math.max(0, (Date.now() - anchor) / 1000));

    let payoutAmount = 0;
    if (elapsedSeconds > 0) {
      // Read from cache instead of calling Helius
      const collabBonusPercent = await getCollabBonusPercent(wallet);
      const ratePerSecond = (200 * (1 + collabBonusPercent / 100)) / 86400;
      payoutAmount = Math.round(ratePerSecond * elapsedSeconds * 100) / 100;
    }

    // Credit the earned amount
    if (payoutAmount > 0) {
      const creditRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/refund_chew`, {
        method: 'POST',
        headers: sbHeaders,
        body: JSON.stringify({ p_wallet: wallet, p_amount: payoutAmount }),
      });
      if (!creditRes.ok) {
        throw new Error(`Failed to credit partial payout: ${creditRes.status}`);
      }

      await fetch(`${SUPABASE_URL}/rest/v1/point_ledger`, {
        method: 'POST',
        headers: sbHeaders,
        body: JSON.stringify({
          wallet,
          amount: payoutAmount,
          reason: `unstake_payout (${mint}, ${Math.round(elapsedSeconds)}s staked since last payout)`,
        }),
      });

      await fetch(`${SUPABASE_URL}/rest/v1/rpc/increment_nft_earned`, {
        method: 'POST',
        headers: sbHeaders,
        body: JSON.stringify({ p_staked_nft_id: stakeRow.id, p_amount: payoutAmount }),
      });
    }

    // Deactivate the stake
    const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/staked_nfts?id=eq.${stakeRow.id}`, {
      method: 'PATCH',
      headers: sbHeaders,
      body: JSON.stringify({ active: false }),
    });

    if (!patchRes.ok) {
      throw new Error(`Update failed: ${patchRes.status}`);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Unstaked successfully', payoutAmount }),
    };
  } catch (err) {
    console.error('unstake-nft error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};
