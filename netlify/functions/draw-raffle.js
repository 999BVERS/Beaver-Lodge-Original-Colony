// netlify/functions/draw-raffle.js
//
// Scheduled to run every 5 minutes (see netlify.toml addition below).
// Finds any raffle that's still marked 'active' but whose ends_at has
// passed, and draws it immediately — picking a uniformly random ROW from
// raffle_entries (not a random wallet), so more entries genuinely means
// better odds. Running every 5 minutes rather than once daily is what
// makes the draw feel instant relative to a raffle that ran for hours or
// days, without needing real-time infrastructure.
//
// Also emails everyone in raffle_subscribers once a raffle is drawn —
// winners get a "you won!" email, everyone else gets a "check who won"
// nudge — see utils/email.js.
//
// Env vars required: SUPABASE_URL, SUPABASE_SERVICE_KEY, and (for the
// drawn-raffle email) BREVO_API_KEY, BREVO_SENDER_EMAIL

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const { sendToSubscribers, escapeHtml, emailLayout, BRAND } = require('./utils/email');

const STAKING_URL = 'https://blocolony.com/staking/';

const sbHeaders = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

// Picks winnerCount distinct-wallet winners from the entry pool. A wallet
// with more entries has proportionally better odds of being picked as ONE
// of the winners, but can never fill more than one winner slot — once a
// wallet is drawn, all of its remaining entries are removed from the pool
// before the next winner is picked.
function drawWinners(entries, winnerCount) {
  const winners = [];
  let pool = [...entries];

  while (winners.length < winnerCount && pool.length > 0) {
    const index = Math.floor(Math.random() * pool.length);
    const picked = pool[index];
    winners.push(picked);
    pool = pool.filter((e) => e.wallet !== picked.wallet);
  }

  return winners; // may be shorter than winnerCount if fewer unique wallets entered than requested
}

// Emails every subscriber that this raffle has been drawn — winners get a
// "you won!" version, everyone else gets a "check who won" nudge. Best
// effort: any failure here is logged and swallowed, never allowed to
// affect the draw itself (already committed to the DB by the time this
// runs).
async function notifySubscribersOfDraw(raffle, winners) {
  try {
    const subsRes = await fetch(`${SUPABASE_URL}/rest/v1/raffle_subscribers?select=wallet,email`, { headers: sbHeaders });
    const subscribers = await subsRes.json();
    if (!Array.isArray(subscribers) || subscribers.length === 0) return 0;

    const winnerWallets = new Set(winners.map((w) => w.wallet));

    const sent = await sendToSubscribers(subscribers, {
      subject: `BLOC raffle drawn: ${raffle.title}`,
      buildHtml: (sub) => {
        const won = winnerWallets.has(sub.wallet);
        const bodyHtml = won
          ? `
            <p style="margin:0 0 14px;">The <strong style="color:${BRAND.goldBright};">${escapeHtml(raffle.title)}</strong> raffle has been drawn — and you're a winner!</p>
            <p style="margin:0;">Reach out on Discord or X (@999BVERS) to claim your prize.</p>
          `
          : `
            <p style="margin:0 0 14px;">The <strong style="color:${BRAND.goldBright};">${escapeHtml(raffle.title)}</strong> raffle has been drawn.</p>
            <p style="margin:0;color:${BRAND.gray};">Check the staking page to see who won this time — we'll email you the moment the next raffle opens.</p>
          `;

        return emailLayout({
          preheader: won ? `You won the ${raffle.title} raffle!` : `${raffle.title} has been drawn — see who won.`,
          heading: won ? '🎉 You won!' : 'Raffle drawn',
          bodyHtml,
          ctaText: 'View the raffle',
          ctaUrl: STAKING_URL,
        });
      },
    });
    return sent;
  } catch (err) {
    console.error('draw-raffle: failed to email subscribers for raffle', raffle.id, err);
    return 0;
  }
}

exports.handler = async () => {
  try {
    const nowIso = new Date().toISOString();

    const expiredRes = await fetch(
      `${SUPABASE_URL}/rest/v1/raffles?status=eq.active&ends_at=lte.${nowIso}&select=id,title,winner_count`,
      { headers: sbHeaders }
    );
    const expired = await expiredRes.json();

    if (!Array.isArray(expired) || expired.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ drawn: 0 }) };
    }

    const results = [];

    for (const raffle of expired) {
      const entriesRes = await fetch(
        `${SUPABASE_URL}/rest/v1/raffle_entries?raffle_id=eq.${raffle.id}&select=wallet,x_username`,
        { headers: sbHeaders }
      );
      const entries = await entriesRes.json();

      const winnerCount = raffle.winner_count || 1;
      const winners = Array.isArray(entries) ? drawWinners(entries, winnerCount) : [];

      if (winners.length > 0) {
        await fetch(`${SUPABASE_URL}/rest/v1/raffle_winners`, {
          method: 'POST',
          headers: sbHeaders,
          body: JSON.stringify(
            winners.map((w) => ({ raffle_id: raffle.id, wallet: w.wallet, x_username: w.x_username }))
          ),
        });
      }
      // If zero entries (or zero unique wallets), the raffle still gets
      // marked 'drawn' with zero winner rows — the frontend shows "No
      // entries were received" for this case.

      await fetch(`${SUPABASE_URL}/rest/v1/raffles?id=eq.${raffle.id}`, {
        method: 'PATCH',
        headers: sbHeaders,
        body: JSON.stringify({
          status: 'drawn',
          drawn_at: new Date().toISOString(),
          drawn_email_sent: true,
        }),
      });

      const emailsSent = await notifySubscribersOfDraw(raffle, winners);

      console.log(`draw-raffle: raffle ${raffle.id} drawn — ${winners.length}/${winnerCount} winners: ${winners.map((w) => w.x_username).join(', ') || 'none (no entries)'} — ${emailsSent} subscriber email(s) sent`);
      results.push({ raffleId: raffle.id, winners: winners.map((w) => w.x_username), emailsSent });
    }

    return { statusCode: 200, body: JSON.stringify({ drawn: results.length, results }) };
  } catch (err) {
    console.error('draw-raffle error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to draw raffle' }) };
  }
};
