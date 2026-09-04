// netlify/functions/calculate-points.js
//
// Scheduled to run once daily (see netlify.toml). For every wallet with
// active staked NFTs:
//   1. Re-checks current holdings live via Helius (fresh, not cached)
//   2. Confirms each "staked" NFT is still actually owned by that wallet —
//      if not (e.g. sold), auto-deactivates the stake as a safety net
//   3. Reads collab bonus from collab_holdings cache (written by
//      verify-holdings.js) — avoids a redundant Helius call per wallet.
//      Falls back to 0% if no cache entry exists (wallet never connected
//      since cache was introduced, or cache was cleared).
//   4. Awards 200 $CHEW per still-valid staked NFT, times the multiplier
//   5. Updates point_balances and logs the payout in point_ledger
//
// Env vars required: SUPABASE_URL, SUPABASE_SERVICE_KEY, HELIUS_API_KEY,
// BLOC_COLLECTION_ADDRESS

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const BLOC_COLLECTION_ADDRESS = process.env.BLOC_COLLECTION_ADDRESS;

const POINTS_PER_NFT_PER_DAY = 200;

const sbHeaders = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

async function getAssetsByOwner(wallet) {
  const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'calculate-points',
      method: 'getAssetsByOwner',
      params: { ownerAddress: wallet, page: 1, limit: 1000 },
    }),
  });
  const data = await res.json();
  return data.result?.items || [];
}

// Read collab bonus from cache table instead of calling Helius.
// Falls back to 0 if no cached data found for this wallet.
async function getCollabBonusFromCache(wallet, collabCollections) {
  const holdingsRes = await fetch(
    `${SUPABASE_URL}/rest/v1/collab_holdings?wallet=eq.${wallet}&select=collection_address,nft_count`,
    { headers: sbHeaders }
  );
  const holdings = await holdingsRes.json();

  if (!Array.isArray(holdings) || holdings.length === 0) return 0;

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

exports.handler = async () => {
  try {
    // 1. Get every wallet with at least one active staked NFT
    const stakedRes = await fetch(
      `${SUPABASE_URL}/rest/v1/staked_nfts?active=eq.true&select=id,wallet,mint`,
      { headers: sbHeaders }
    );
    const stakedRows = await stakedRes.json();

    if (!Array.isArray(stakedRows) || stakedRows.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ message: 'No active stakes to process' }) };
    }

    // Group by wallet
    const walletMap = {};
    for (const row of stakedRows) {
      if (!walletMap[row.wallet]) walletMap[row.wallet] = [];
      walletMap[row.wallet].push(row);
    }

    // 2. Get active collab collections once (shared across all wallets)
    const collabRes = await fetch(
      `${SUPABASE_URL}/rest/v1/collab_collections?active=eq.true&select=collection_address,name,bonus_per_nft,max_bonus`,
      { headers: sbHeaders }
    );
    const collabCollections = await collabRes.json();

    const results = [];

    for (const [wallet, stakedForWallet] of Object.entries(walletMap)) {
      try {
        // Still calls Helius once per wallet to verify ownership —
        // this is the source of truth for auto-unstaking sold NFTs.
        const assets = await getAssetsByOwner(wallet);
        const heldMints = new Set(assets.map((a) => a.id));

        // Auto-unstake any record where the wallet no longer holds that mint
        const stillValid = [];
        for (const staked of stakedForWallet) {
          if (heldMints.has(staked.mint)) {
            stillValid.push(staked);
          } else {
            await fetch(`${SUPABASE_URL}/rest/v1/staked_nfts?id=eq.${staked.id}`, {
              method: 'PATCH',
              headers: sbHeaders,
              body: JSON.stringify({ active: false }),
            });
          }
        }

        if (stillValid.length === 0) continue;

        // Read collab bonus from cache instead of re-processing Helius data
        const bonusPercent = await getCollabBonusFromCache(wallet, collabCollections);

        const basePoints = stillValid.length * POINTS_PER_NFT_PER_DAY;
        const totalPoints = Math.round(basePoints * (1 + bonusPercent / 100));

        // Upsert point_balances (increment)
        const balRes = await fetch(
          `${SUPABASE_URL}/rest/v1/point_balances?wallet=eq.${wallet}&select=balance`,
          { headers: sbHeaders }
        );
        const balData = await balRes.json();
        const currentBalance = balData[0]?.balance ?? 0;
        const newBalance = currentBalance + totalPoints;
        const now = new Date().toISOString();

        if (balData.length > 0) {
          await fetch(`${SUPABASE_URL}/rest/v1/point_balances?wallet=eq.${wallet}`, {
            method: 'PATCH',
            headers: sbHeaders,
            body: JSON.stringify({ balance: newBalance, updated_at: now, last_daily_payout_at: now }),
          });
        } else {
          await fetch(`${SUPABASE_URL}/rest/v1/point_balances`, {
            method: 'POST',
            headers: sbHeaders,
            body: JSON.stringify({ wallet, balance: newBalance, last_daily_payout_at: now }),
          });
        }

        // Credit each individual staked NFT's own lifetime total
        const perNftAmount = Math.round(200 * (1 + bonusPercent / 100) * 100) / 100;
        for (const staked of stillValid) {
          await fetch(`${SUPABASE_URL}/rest/v1/rpc/increment_nft_earned`, {
            method: 'POST',
            headers: sbHeaders,
            body: JSON.stringify({ p_staked_nft_id: staked.id, p_amount: perNftAmount }),
          });
        }

        // Log in ledger
        await fetch(`${SUPABASE_URL}/rest/v1/point_ledger`, {
          method: 'POST',
          headers: sbHeaders,
          body: JSON.stringify({
            wallet,
            amount: totalPoints,
            reason: `daily_staking (${stillValid.length} NFTs, +${bonusPercent}% collab)`,
          }),
        });

        results.push({ wallet, staked: stillValid.length, bonusPercent, totalPoints });
      } catch (walletErr) {
        console.error(`calculate-points error for wallet ${wallet}:`, walletErr);
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ processed: results.length, results }),
    };
  } catch (err) {
    console.error('calculate-points error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};
