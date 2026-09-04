// netlify/functions/verify-holdings.js
//
// Takes a connected wallet address, checks what BLOC NFTs and collab NFTs
// it holds (via Helius), cross-references staking status and $CHEW balance
// (via Supabase), and returns everything the staking page needs to render.
//
// Env vars required (set in Netlify):
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
//   HELIUS_API_KEY
//   BLOC_COLLECTION_ADDRESS   -> UaahVvu6X7V1CsfEMiq7s7Bzxcg8rsFrjM6SCViNujw

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const BLOC_COLLECTION_ADDRESS = process.env.BLOC_COLLECTION_ADDRESS;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let wallet;
  try {
    const body = JSON.parse(event.body);
    wallet = body.wallet;
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  if (!wallet || typeof wallet !== 'string' || wallet.length < 32 || wallet.length > 44) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid wallet address' }) };
  }

  try {
    // 1. Get all NFTs currently held by this wallet, via Helius DAS API
    const heliusRes = await fetch(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'verify-holdings',
        method: 'getAssetsByOwner',
        params: {
          ownerAddress: wallet,
          page: 1,
          limit: 1000,
        },
      }),
    });

    if (!heliusRes.ok) {
      throw new Error(`Helius request failed: ${heliusRes.status}`);
    }

    const heliusData = await heliusRes.json();
    const assets = heliusData.result?.items || [];

    // Extract mints that belong to the BLOC collection, with display name + image
    const heldBlocMints = assets
      .filter((asset) =>
        asset.grouping?.some(
          (g) => g.group_key === 'collection' && g.group_value === BLOC_COLLECTION_ADDRESS
        )
      )
      .map((asset) => ({
        mint: asset.id,
        name: asset.content?.metadata?.name || 'BLOC',
        image:
          asset.content?.links?.image ||
          asset.content?.files?.[0]?.uri ||
          null,
      }));

    // 2. Get active collab collections from Supabase
    const collabRes = await fetch(
      `${SUPABASE_URL}/rest/v1/collab_collections?active=eq.true&select=collection_address,name,bonus_per_nft,max_bonus`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
      }
    );
    const collabCollections = await collabRes.json();

    // Count held NFTs per collab collection
    const collabCounts = {}; // { collection_address: count }
    for (const asset of assets) {
      const groupings = asset.grouping || [];
      for (const g of groupings) {
        if (g.group_key === 'collection') {
          const match = collabCollections.find((c) => c.collection_address === g.group_value);
          if (match) {
            collabCounts[g.group_value] = (collabCounts[g.group_value] || 0) + 1;
          }
        }
      }
    }

    // Per-project bonus: each project has its OWN rate (bonus_per_nft) and
    // cap (max_bonus), instead of every project sharing a fixed formula —
    // this is what lets you boost one project for an event without
    // touching any others.
    let collabBonusPercent = 0;
    const collabBreakdown = [];
    for (const [address, count] of Object.entries(collabCounts)) {
      const project = collabCollections.find((c) => c.collection_address === address);
      const perNft = project?.bonus_per_nft ?? 1;
      const maxBonus = project?.max_bonus ?? 5;
      const capped = Math.min(count * perNft, maxBonus);
      collabBonusPercent += capped;
      const name = project?.name || 'Unknown';
      collabBreakdown.push({ name, held: count, cappedBonus: capped });
    }

    // 3. Get this wallet's currently staked NFTs from Supabase
    const stakedRes = await fetch(
      `${SUPABASE_URL}/rest/v1/staked_nfts?wallet=eq.${wallet}&active=eq.true&select=mint,staked_at,total_earned`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
      }
    );
    const stakedNfts = await stakedRes.json();

    // 4. Get $CHEW balance, plus when it was last confirmed — the frontend
    // The frontend's per-NFT live ticker needs to know exactly when the
    // last TRUE daily payout happened — not just "whenever this balance
    // was last touched for any reason." Those are different things:
    // unstaking, fell-tree refunds, etc. also touch this balance, but only
    // calculate-points.js writes last_daily_payout_at. Using the generic
    // updated_at here caused a real bug: unstaking one NFT would touch
    // updated_at, which every OTHER staked NFT's ticker anchored to,
    // incorrectly resetting their displayed earnings to ~0 too.
    const balanceRes = await fetch(
      `${SUPABASE_URL}/rest/v1/point_balances?wallet=eq.${wallet}&select=balance,last_daily_payout_at`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
      }
    );
    const balanceData = await balanceRes.json();
    const chewBalance = balanceData[0]?.balance ?? 0;
    const lastDailyPayoutAt = balanceData[0]?.last_daily_payout_at ?? null;

    return {
      statusCode: 200,
      body: JSON.stringify({
        wallet,
        heldBlocMints,       // all BLOC NFTs in wallet right now (staked or not)
        stakedNfts,          // which of those are currently staked
        collabBonusPercent,  // total % bonus, capped per project, summed
        collabBreakdown,     // per-project detail, useful for UI display later
        chewBalance,
        lastDailyPayoutAt,
      }),
    };
  } catch (err) {
    console.error('verify-holdings error:', err);
