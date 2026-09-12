// netlify/functions/notify-raffle-subscribers.js
//
// Scheduled to run every 5 minutes (see netlify.toml), same cadence as
// draw-raffle.js. Finds any raffle that's active and hasn't had its
// "new raffle" email sent yet, emails every address in raffle_subscribers
// with the prize (title/description) and end time, then marks it sent —
// so each raffle only ever triggers this email once no matter how many
// times this function runs while that raffle stays active.
//
// Env vars required: SUPABASE_URL, SUPABASE_SERVICE_KEY, BREVO_API_KEY,
// BREVO_SENDER_EMAIL (see utils/email.js)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const { sendToSubscribers, escapeHtml, emailLayout, BRAND } = require('./utils/email');

const STAKING_URL = 'https://blocolony.com/staking/';

const sbHeaders = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

function formatEndsAt(iso) {
  return new Date(iso).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }) + ' UTC';
}

exports.handler = async () => {
  try {
    // Raffles that are live right now and haven't had their "opened" email
    // sent yet.
    const raffleRes = await fetch(
      `${SUPABASE_URL}/rest/v1/raffles?status=eq.active&opened_email_sent=eq.false&select=id,title,description,ends_at`,
      { headers: sbHeaders }
    );
    const raffles = await raffleRes.json();

    if (!Array.isArray(raffles) || raffles.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ notified: 0 }) };
    }

    const subsRes = await fetch(`${SUPABASE_URL}/rest/v1/raffle_subscribers?select=email`, { headers: sbHeaders });
    const subscribers = await subsRes.json();

    let totalSent = 0;

    for (const raffle of raffles) {
      if (Array.isArray(subscribers) && subscribers.length > 0) {
        const bodyHtml = `
          <p style="margin:0 0 14px;">A new BLOC raffle just opened — here's what's up for grabs.</p>
          <p style="margin:0 0 6px;font-size:18px;font-weight:700;color:${BRAND.goldBright};">${escapeHtml(raffle.title)}</p>
          ${raffle.description ? `<p style="margin:0 0 20px;color:${BRAND.gray};">${escapeHtml(raffle.description)}</p>` : '<div style="margin-bottom:8px;"></div>'}
          <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;background-color:${BRAND.bg};border:1px solid ${BRAND.border};border-radius:10px;">
            <tr>
              <td style="padding:14px 16px;font-family:'Courier New',monospace;color:${BRAND.gold};font-weight:700;font-size:14px;">Ends: ${formatEndsAt(raffle.ends_at)}</td>
            </tr>
          </table>
        `;

        const html = emailLayout({
          preheader: `${raffle.title} — enter before ${formatEndsAt(raffle.ends_at)}`,
          heading: '🪵 New raffle open!',
          bodyHtml,
          ctaText: 'Enter the raffle',
          ctaUrl: STAKING_URL,
        });

        totalSent += await sendToSubscribers(subscribers, {
          subject: `New BLOC raffle: ${raffle.title}`,
          buildHtml: () => html,
        });
      }

      // Mark it sent even if there were zero subscribers at the time — a
      // holder who subscribes after this raffle already opened will still
      // catch it live on the staking page, and will get the "drawn" email
      // like everyone else.
      await fetch(`${SUPABASE_URL}/rest/v1/raffles?id=eq.${raffle.id}`, {
        method: 'PATCH',
        headers: sbHeaders,
        body: JSON.stringify({ opened_email_sent: true }),
      });
    }

    return { statusCode: 200, body: JSON.stringify({ raffles: raffles.length, emailsSent: totalSent }) };
  } catch (err) {
    console.error('notify-raffle-subscribers error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to send raffle notifications' }) };
  }
};
