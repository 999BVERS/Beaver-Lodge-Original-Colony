// netlify/functions/get-tree-rewards.js
//
// Public, read-only. Returns just the NAMES of currently active rewards per
// tree type, so the staking page's "Possible Rewards" list reflects
// whatever's actually in tree_rewards instead of being hardcoded HTML.
// No wallet/session required — anyone can see what's possible to win,
// same as the quest visibility principle from earlier (see anywhere can
// look, only holders can act).
//
// Deliberately does NOT return weight or stock — those are internal odds
// info, no reason to expose them to the frontend.
//
// Env vars required: SUPABASE_URL, SUPABASE_SERVICE_KEY

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

exports.handler = async () => {
  try {
    const res = await fetch(
      // Shows active, in-stock rewards only — one that's genuinely sold
      // out (stock_remaining = 0) disappears from the list automatically.
      // This does NOT affect the separate "disable but keep visible" trick
      // of setting weight = 0 on a reward — that only affects draw odds,
      // never touches stock, so a manually-disabled reward with normal
      // stock still stays listed as intended.
      `${SUPABASE_URL}/rest/v1/tree_rewards?active=eq.true&or=(stock_remaining.is.null,stock_remaining.gt.0)&select=name,tree_type&order=name.asc`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
      }
    );
    const rows = await res.json();

    if (!Array.isArray(rows)) {
      throw new Error('Unexpected response from Supabase');
    }

    // tree_type is stored lowercase ('soft'/'hard') in the DB.
    const softTree = rows.filter((r) => r.tree_type === 'soft').map((r) => r.name);
    const hardTree = rows.filter((r) => r.tree_type === 'hard').map((r) => r.name);

    return {
      statusCode: 200,
      body: JSON.stringify({ softTree, hardTree }),
    };
  } catch (err) {
    console.error('get-tree-rewards error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to load rewards' }) };
  }
};
