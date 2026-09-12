// netlify/functions/utils/email.js
//
// Thin wrapper around Brevo's transactional email API (api.brevo.com),
// used for the raffle-alert emails (see notify-raffle-subscribers.js and
// the "drawn" email sent from draw-raffle.js). Free tier: 300 emails/day,
// no card required — console.brevo.com.
//
// Env vars required:
//   BREVO_API_KEY      — Brevo → Settings (SMTP & API) → API Keys → Generate
//   BREVO_SENDER_EMAIL — the single sender address you verified in Brevo
//                        (Senders, Domains & Dedicated IPs → Senders → Add
//                        a Sender → click the confirmation link Brevo
//                        emails you). Must match a verified sender exactly.
//   BREVO_SENDER_NAME  — optional, defaults to "BLOC Raffles" below.
//
// Sends are one-at-a-time and best-effort: a failed send is logged and
// skipped rather than throwing, so one bad address never blocks the rest
// of a batch or breaks the raffle logic that calls this.

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL;
const BREVO_SENDER_NAME = process.env.BREVO_SENDER_NAME || 'BLOC Raffles';

// Same brand colors as index.html/staking's :root (kept as literal hex here,
// not var(--...), because most email clients strip <style> blocks and don't
// support CSS custom properties at all — every color below has to be
// inlined). Update both places if the site's palette ever changes.
const BRAND = {
  bg: '#0a0a0a',
  card: '#131110',
  border: '#24201a',
  gold: '#c9a84c',
  goldBright: '#e0c06e',
  cream: '#f4efe6',
  gray: '#a8a29a',
  grayDim: '#6b665f',
};

// Hosted at the repo root, next to BLOC-Logo.webp — a PNG copy specifically
// for emails, since Outlook (desktop/Windows) doesn't render WebP and would
// otherwise show a broken image. Regenerate it (resize BLOC-Logo.webp to
// ~160x160 and export PNG) if the logo ever changes.
const LOGO_URL = 'https://blocolony.com/BLOC-Logo-email.png';

// Wraps a raffle email's inner content in BLOC's dark/gold branded shell —
// logo, card, footer unsubscribe note. Table-based layout with every style
// inlined on purpose: this is what actually survives Gmail/Outlook/Apple
// Mail's aggressive CSS stripping, not a style preference.
//   preheader — short hidden text shown as the inbox preview snippet
//   heading   — bold title inside the card (e.g. "New raffle open!")
//   bodyHtml  — the message-specific HTML (already brand-colored inline)
//   ctaText / ctaUrl — optional pill button
function emailLayout({ preheader, heading, bodyHtml, ctaText, ctaUrl }) {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background-color:${BRAND.bg};">
    <span style="display:none;font-size:1px;color:${BRAND.bg};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${preheader || ''}</span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BRAND.bg};padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:${BRAND.card};border:1px solid ${BRAND.border};border-radius:16px;">
            <tr>
              <td style="padding:32px 32px 20px;text-align:center;">
                <img src="${LOGO_URL}" width="64" height="64" alt="BLOC" style="display:block;margin:0 auto 12px;border-radius:50%;" />
                <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${BRAND.gold};font-weight:700;">Beaver Lodge Original Colony</div>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px;">
                <div style="border-top:1px solid ${BRAND.border};margin:0 0 24px;"></div>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px;font-family:Arial,Helvetica,sans-serif;color:${BRAND.cream};font-size:15px;line-height:1.6;">
                ${heading ? `<div style="margin:0 0 16px;font-size:20px;font-weight:700;color:${BRAND.cream};">${heading}</div>` : ''}
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:${ctaText && ctaUrl ? '8px 32px 32px' : '0 32px 32px'};text-align:center;">
                ${ctaText && ctaUrl
                  ? `<a href="${ctaUrl}" style="display:inline-block;background-color:${BRAND.gold};color:${BRAND.bg};font-family:Arial,Helvetica,sans-serif;font-weight:700;font-size:14px;text-decoration:none;padding:12px 32px;border-radius:999px;">${ctaText}</a>`
                  : ''}
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px;border-top:1px solid ${BRAND.border};font-family:Arial,Helvetica,sans-serif;color:${BRAND.grayDim};font-size:12px;line-height:1.5;text-align:center;">
                You're getting this because you subscribed to raffle alerts on the BLOC staking site. To stop, reconnect your wallet there and click Unsubscribe.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

async function sendEmail({ to, subject, html }) {
  if (!BREVO_API_KEY || !BREVO_SENDER_EMAIL) {
    console.error('email: BREVO_API_KEY or BREVO_SENDER_EMAIL is not set — skipping send to', to);
    return false;
  }
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'api-key': BREVO_API_KEY,
      },
      body: JSON.stringify({
        sender: { email: BREVO_SENDER_EMAIL, name: BREVO_SENDER_NAME },
        to: [{ email: to }],
        subject,
        htmlContent: html,
      }),
    });

    if (!res.ok) {
      console.error('email send failed:', to, res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error('email send error:', to, err);
    return false;
  }
}

// Sends one email per subscriber. `buildHtml(subscriber)` lets the caller
// personalize content (e.g. "you won!" vs "check who won") — pass a plain
// function returning the same string for everyone if no personalization is
// needed. Returns how many sends succeeded.
async function sendToSubscribers(subscribers, { subject, buildHtml }) {
  let sent = 0;
  for (const sub of subscribers) {
    const ok = await sendEmail({ to: sub.email, subject, html: buildHtml(sub) });
    if (ok) sent += 1;
  }
  return sent;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = { sendEmail, sendToSubscribers, escapeHtml, emailLayout, BRAND };
