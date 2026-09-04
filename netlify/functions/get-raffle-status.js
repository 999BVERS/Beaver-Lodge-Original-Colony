// netlify/functions/get-raffle-status.js
//
// Public, read-only — no wallet/session required, same principle as
// get-tree-rewards.js: anyone can see what's happening, only a connected
// wallet can actually enter (see enter-raffle.js).
//
// Returns the single most recent raffle (active or drawn), its full entry
// list aggregated by wallet (with counts), and the winner if it's been
// drawn. Returns { raffle: null } if no raffle has ever been created.
//
// Env vars required: SUPABASE_URL, SUPABASE_SERVICE_KEY

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const sbHeaders = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
};

exports.handler = async () => {
  try {
    const raffleRes = await fetch(
      `${SUPABASE_URL}/rest/v1/raffles?status=neq.cancelled&order=created_at.desc&limit=1`,
      { headers: sbHeaders }
    );
    const raffles = await raffleRes.json();

    if (!Array.isArray(raffles) || raffles.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ raffle: null }) };
    }

    const raffle = raffles[0];

    let winners = [];
    if (raffle.status === 'drawn') {
      const winnersRes = await fetch(
        `${SUPABASE_URL}/rest/v1/raffle_winners?raffle_id=eq.${raffle.id}&select=wallet,x_username&order=drawn_at.asc`,
        { headers: sbHeaders }
      );
      winners = await winnersRes.json();
    }

    const entriesRes = await fetch(
      `${SUPABASE_URL}/rest/v1/raffle_entries?raffle_id=eq.${raffle.id}&select=wallet,x_username&order=entered_at.asc`,
      { headers: sbHeaders }
    );
    const entries = await entriesRes.json();

    // Aggregate by wallet — the public list shows each entrant once with
    // their total entry count, not one row per individual entry.
    const byWallet = {};
    for (const e of entries) {
      if (!byWallet[e.wallet]) {
        byWallet[e.wallet] = { wallet: e.wallet, xUsername: e.x_username, entryCount: 0 };
      }
      byWallet[e.wallet].entryCount += 1;
    }
    const entrants = Object.values(byWallet).sort((a, b) => b.entryCount - a.entryCount);

    return {
      statusCode: 200,
      body: JSON.stringify({
        raffle: {
          id: raffle.id,
          title: raffle.title,
          description: raffle.description,
          projectXAccount: raffle.project_x_account,
          infoPostUrl: raffle.info_post_url,
          entryCost: raffle.entry_cost,
          maxEntriesPerWallet: raffle.max_entries_per_wallet,
          winnerCount: raffle.winner_count,
          endsAt: raffle.ends_at,
          status: raffle.status,
        },
        winners: Array.isArray(winners) ? winners.map((w) => ({ wallet: w.wallet, xUsername: w.x_username })) : [],
        entrants,
        totalEntries: entries.length,
      }),
    };
  } catch (err) {
    console.error('get-raffle-status error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to load raffle status' }) };
  }
};
