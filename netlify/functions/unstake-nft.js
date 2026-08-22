// netlify/functions/unstake-nft.js
//
// Unstakes an NFT — marks the staked_nfts row inactive rather than deleting
// it, preserving history.
//
// IMPORTANT: calculate-points.js only pays 200 $CHEW/day to whatever is
// ACTIVELY staked at the moment it runs (once daily) — it does not look
// back at what was staked earlier in the day. That means, without this
// function doing anything extra, unstaking before that daily run has fired
// would mean genuinely earning nothing for that period, not partial credit.
//
// To fix that, this function calculates exactly how much this specific NFT
// has earned since the later of (a) when it was staked, or (b) the wallet's
// last confirmed payout — same math the live ticker on the frontend shows —
// and credits that amount into point_balances for real, right now, before
// deactivating the stake. This makes what the ticker was showing actually
// true money instead of an estimate that could vanish on unstake.
//
// No double-payment risk: calculate-points only ever pays currently-ACTIVE
// stakes, and this NFT's row is set inactive in the same request, so it
// will never also be paid for this same period by the next scheduled run.
//
// Env vars required: SUPABASE_URL, SUPABASE_SERVICE_KEY, HELIUS_API_KEY,
// BLOC_COLLECTION_ADDRESS

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const BLOC_COLLECTION_ADDRESS = process.env.BLOC_COLLECTION_ADDRESS;
const { requireValidSession } = require('./utils/auth');

const sbHeaders = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

// Same collab bonus calculation calculate-points.js uses, kept in sync so
// this partial payout and the daily payout never disagree on rate.
async function getCollabBonusPercent(wallet) {
  const heliusRes = await fetch(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'unstake-collab-check',
      method: 'getAssetsByOwner',
      params: { ownerAddress: wallet, page: 1, limit: 1000 },
    }),
  });
  const heliusData = await heliusRes.json();
  const assets = heliusData.result?.items || [];

  const collabRes = await fetch(
    `${SUPABASE_URL}/rest/v1/collab_collections?active=eq.true&select=collection_address`,
    { headers: sbHeaders }
  );
  const collabCollections = await collabRes.json();

  const collabCounts = {};
  for (const asset of assets) {
    for (const g of asset.grouping || []) {
      if (g.group_key === 'collection') {
        const match = collabCollections.find((c) => c.collection_address === g.group_value);
        if (match) collabCounts[g.group_value] = (collabCounts[g.group_value] || 0) + 1;
      }
    }
  }

  let bonusPercent = 0;
  for (const count of Object.values(collabCounts)) {
    bonusPercent += Math.min(count, 5);
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
    // Only allow unstaking a mint that's actively staked BY THIS wallet —
    // prevents one wallet from unstaking another wallet's NFT via a crafted
    // request. Now also fetching staked_at, needed for the payout math.
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

    // 1. Figure out how much this NFT has genuinely earned since it started
    // counting (its own staked_at, or the last confirmed payout if that's
    // more recent — anything before that point is already inside the
    // confirmed balance and shouldn't be paid again).
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
      const collabBonusPercent = await getCollabBonusPercent(wallet);
      const ratePerSecond = (200 * (1 + collabBonusPercent / 100)) / 86400;
      payoutAmount = Math.round(ratePerSecond * elapsedSeconds * 100) / 100; // 2 decimal places
    }

    // 2. Credit it for real, right now — same atomic increment used
    // elsewhere for adding $CHEW.
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
    }

    // 3. Now deactivate the stake — after the payout is safely banked, so
    // a failure earlier in this request never leaves the NFT unstaked
    // without having been paid for its time.
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
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to unstake NFT' }) };
  }
};
