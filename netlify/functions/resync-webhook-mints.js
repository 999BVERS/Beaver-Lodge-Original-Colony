// netlify/functions/resync-webhook-mints.js
//
// Scheduled to run daily (see netlify.toml addition below). Re-fetches every
// mint currently in the BLOC collection and pushes the full list to the
// existing Helius webhook, so newly minted NFTs get picked up automatically
// without anyone needing to re-run setup-helius-webhook.js by hand.
//
// This does NOT affect staking eligibility — stake-nft.js already checks
// ownership live, so new mints are stakeable the instant they're minted
// regardless of this function. This only keeps the *transfer* webhook (used
// for instant auto-unstake-on-sale) current during active minting.
//
// Env vars required: HELIUS_API_KEY, BLOC_COLLECTION_ADDRESS,
//   HELIUS_WEBHOOK_ID, WEBHOOK_URL, HELIUS_WEBHOOK_SECRET

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const BLOC_COLLECTION_ADDRESS = process.env.BLOC_COLLECTION_ADDRESS;
const HELIUS_WEBHOOK_ID = process.env.HELIUS_WEBHOOK_ID;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const HELIUS_WEBHOOK_SECRET = process.env.HELIUS_WEBHOOK_SECRET;

async function getAllCollectionMints() {
  const mints = [];
  let page = 1;
  const limit = 1000;

  while (true) {
    const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'resync-webhook-mints',
        method: 'getAssetsByGroup',
        params: { groupKey: 'collection', groupValue: BLOC_COLLECTION_ADDRESS, page, limit },
      }),
    });
    const data = await res.json();
    const items = data.result?.items || [];
    mints.push(...items.map((i) => i.id));

    if (items.length < limit) break;
    page++;
  }

  return mints;
}

exports.handler = async () => {
  if (!HELIUS_WEBHOOK_ID) {
    console.error('resync-webhook-mints: HELIUS_WEBHOOK_ID is not set — nothing to update. Run setup-helius-webhook.js once first.');
    return { statusCode: 200, body: JSON.stringify({ skipped: true, reason: 'HELIUS_WEBHOOK_ID not set' }) };
  }

  try {
    const mints = await getAllCollectionMints();

    const res = await fetch(
      `https://api-mainnet.helius-rpc.com/v0/webhooks/${HELIUS_WEBHOOK_ID}?api-key=${HELIUS_API_KEY}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          webhookURL: WEBHOOK_URL,
          transactionTypes: ['TRANSFER'],
          accountAddresses: mints,
          webhookType: 'enhanced',
          authHeader: HELIUS_WEBHOOK_SECRET,
        }),
      }
    );

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Helius update failed: ${res.status} ${errBody}`);
    }

    console.log(`resync-webhook-mints: watch list updated, ${mints.length} mints total`);
    return { statusCode: 200, body: JSON.stringify({ mintCount: mints.length }) };
  } catch (err) {
    console.error('resync-webhook-mints error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to resync webhook mints' }) };
  }
};
