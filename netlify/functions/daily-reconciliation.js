// netlify/functions/daily-reconciliation.js
//
// Independent safety net, separate from calculate-points.js. Two jobs:
//
//   1. Duplicate detection — if staked_nfts somehow ends up with more than
//      one active=true row for the same mint (shouldn't happen given
//      stake-nft.js's own guard against this, but a reconciliation job
//      should verify that guard actually held, not just assume it), keep
//      only the most recently staked row active and deactivate the rest.
//
//   2. Independent ownership re-check — re-verifies every remaining active
//      stake against live Helius data, same check calculate-points.js does
//      internally. Running it here too, on its own schedule, means a wallet
//      that calculate-points failed to process on a given day (Helius
//      hiccup, rate limit, an unhandled error for that one wallet) still
//      gets caught before too long, instead of silently staying stale until
//      calculate-points happens to succeed for it again.
//
// This function does NOT touch point_balances or point_ledger — it only
// corrects staked_nfts. Point payout logic and its own live ownership check
// stay solely in calculate-points.js, so there's exactly one place that
// awards $CHEW.
//
// Scheduled to run daily, offset from calculate-points (see netlify.toml
// addition below) so the two runs are temporally independent rather than
// both hitting the same failure window.
//
// Env vars required: SUPABASE_URL, SUPABASE_SERVICE_KEY, HELIUS_API_KEY

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

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
      id: 'daily-reconciliation',
      method: 'getAssetsByOwner',
      params: { ownerAddress: wallet, page: 1, limit: 1000 },
    }),
  });
  const data = await res.json();
  return data.result?.items || [];
}

async function deactivateStake(id, reason) {
  await fetch(`${SUPABASE_URL}/rest/v1/staked_nfts?id=eq.${id}`, {
    method: 'PATCH',
    headers: sbHeaders,
    body: JSON.stringify({ active: false }),
  });
  console.log(`daily-reconciliation: deactivated staked_nfts.id=${id} (${reason})`);
}

exports.handler = async () => {
  try {
    // 1. Load every currently active stake, including staked_at so
    // duplicates can be resolved by keeping the most recent.
    const stakedRes = await fetch(
      `${SUPABASE_URL}/rest/v1/staked_nfts?active=eq.true&select=id,wallet,mint,staked_at&order=staked_at.desc`,
      { headers: sbHeaders }
    );
    const stakedRows = await stakedRes.json();

    if (!Array.isArray(stakedRows) || stakedRows.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ message: 'No active stakes to reconcile' }) };
    }

    // 2. Duplicate detection — group by mint, since a mint should only ever
    // have one active stake at a time. Rows are already sorted newest-first,
    // so the first occurrence of a mint is the one we keep.
    const seenMints = new Set();
    const duplicatesRemoved = [];
    const deduped = [];

    for (const row of stakedRows) {
      if (seenMints.has(row.mint)) {
        duplicatesRemoved.push(row);
        await deactivateStake(row.id, `duplicate active stake for mint ${row.mint}`);
        continue;
      }
      seenMints.add(row.mint);
      deduped.push(row);
    }

    // 3. Independent ownership re-check on whatever's left, grouped by
    // wallet to minimize Helius calls (one call covers all of a wallet's
    // staked mints at once).
    const walletMap = {};
    for (const row of deduped) {
      if (!walletMap[row.wallet]) walletMap[row.wallet] = [];
      walletMap[row.wallet].push(row);
    }

    const staleUnstaked = [];
    const walletsChecked = Object.keys(walletMap).length;

    for (const [wallet, rows] of Object.entries(walletMap)) {
      try {
        const assets = await getAssetsByOwner(wallet);
        const heldMints = new Set(assets.map((a) => a.id));

        for (const row of rows) {
          if (!heldMints.has(row.mint)) {
            staleUnstaked.push(row);
            await deactivateStake(row.id, `wallet ${wallet} no longer holds mint ${row.mint}`);
          }
        }
      } catch (walletErr) {
        // Same resilience pattern as calculate-points: one wallet's Helius
        // failure shouldn't stop reconciliation for everyone else. Left
        // uncorrected here just means it's caught on the next scheduled run.
        console.error(`daily-reconciliation error for wallet ${wallet}:`, walletErr);
      }
    }

    const summary = {
      walletsChecked,
      totalActiveStakesReviewed: stakedRows.length,
      duplicatesRemoved: duplicatesRemoved.length,
      staleStakesRemoved: staleUnstaked.length,
    };

    console.log('daily-reconciliation summary:', summary);
    return { statusCode: 200, body: JSON.stringify(summary) };
  } catch (err) {
    console.error('daily-reconciliation error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to run reconciliation' }) };
  }
};
