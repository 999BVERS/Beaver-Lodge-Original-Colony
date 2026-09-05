// netlify/functions/chatbot.js
//
// AI FALLBACK for the "Ask BLOC" chat widget — only called when
// chat-widget.js's local BLOC_FAQ matcher can't confidently answer a
// message (unclear phrasing, or a question BLOC_FAQ doesn't cover). Most
// common questions never reach this function at all; it exists so the
// bot can understand paraphrased/novel questions and ask a clarifying
// question when it genuinely isn't sure what's being asked, instead of
// requiring near-exact keyword matches.
//
// Proxies to Groq's free chat-completions API (OpenAI-compatible) so the
// API key never reaches the browser. Groq's free tier needs no credit
// card and is generous enough for a small site's fallback traffic — see
// console.groq.com/docs/rate-limits if answers start getting rate-limited.
//
// Env var required: GROQ_API_KEY  (create one free at console.groq.com)
//
// MODEL LIFESPAN NOTE: Groq regularly retires older models (they post
// upcoming shutdowns at console.groq.com/docs/deprecations, usually with
// ~2 months' notice). To keep this bot running with zero maintenance
// through those retirements, MODELS below is an ordered fallback list —
// if the first model has been decommissioned, it automatically retries
// with the next one. You only need to touch this file if EVERY model in
// the list eventually gets retired (check the deprecations page above
// every so often, or if the bot starts replying with the "trouble
// answering" fallback message consistently).
const MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'];

const GROQ_API_KEY = process.env.GROQ_API_KEY;

// Keeps the bot's knowledge accurate and its tone simple. IMPORTANT: keep
// this in sync with BLOC_FAQ in bloc-assistant/files/chat-widget.js — the
// two are separate copies of the same facts (one for instant local
// matches, one grounding this AI fallback), so update both whenever real
// site content changes (mint price, Lore/BBB/Partners going live, etc.).
const SYSTEM_PROMPT = `You are Quil, the friendly assistant on the Beaver Lodge Original Colony (BLOC) website (blocolony.com).

Answer visitor questions about BLOC in a short, simple, non-technical way — 1 to 4 short sentences, plain language, no crypto/dev jargon unless the visitor used it first. No bullet lists or headers, just a friendly reply like you're texting. Use the conversation history to understand follow-up questions and context (e.g. "how much is that" after asking about the trait store).

Facts you can rely on (do not invent numbers or details beyond these):
- Collection: 999 hand-drawn Beaver NFTs on Solana, 187+ unique traits, representing real builders in the crypto space. Est. 2026.
- Minting: Public Mint is 18 SOL. Whitelist Mint is 12.50 SOL. Whitelist spots: holding one of BLOC's partner/collab projects can qualify a wallet; otherwise interested people can DM @999BVERS on X to ask about securing a spot.
- Muddy's Trait Store lets holders buy extra traits (e.g. Angel Wings, Lil Devil, and more) to customize their Beaver.
- Staking: holders stake their Beaver(s) (free, transactionless — no gas, no NFT transfer, it just reads wallet holdings) to earn 200 points/day per staked NFT. Points can fell logs (Soft Tree or Hard Tree, up to 4 times/day) for a chance at bounty-pool rewards, and $CHEW can be used to enter raffles (up to 5 times when one is open).
- $CHEW is BLOC's ecosystem currency — not a memecoin, not meant to trade as a standalone crypto, used inside the ecosystem (mainly felling logs and raffles), with more uses planned.
- Holding NFTs from BLOC's collaborated collections gives a staking boost: 1% per NFT, stacking up to 5% for five from the same collection; the boost can be higher if that project contributed to the bounty pool.
- The bounty pool is funded mainly by BLOC, plus contributions (SOL, tokens, NFTs, etc.) from collaborated projects.
- Staking troubleshooting: on desktop, the visitor needs a wallet browser extension installed; on mobile, they should use the built-in browser inside their wallet app, not their regular mobile browser. Supported wallets: Phantom, Solflare, Backpack. If problems persist, or they want another wallet supported, tell them to DM @999BVERS on X.
- The BLOC Competition Series is a seasonal creative competition, open to holders and non-holders alike, each season focused on one creative discipline (Season 1 was poster design, run in three chapters with real winners and a Season Finals grand prize of a custom 1-of-1 Beaver).
- Community/socials: Twitter/X (@999BVERS) and Discord (linked in the site nav) are the best places for the latest news, announcements, and support.
- Team: Buzz (Founder), FabQuilp (Artist), Thirty (Creative Spark), DJDave (CFO), AKCMetaBeast (Lore Author).
- Collab/partner projects: Dead Bunnies, Celestial Yokais, Stone Gods, and LeSuit DAO.
- Lore, Better Business Beaver (BBB), and a formal Partners page are still marked "Coming Soon" on the site — if asked about them, say they're on the way and to follow the socials for updates. Don't make up lore, roadmap dates, or partner names beyond what's listed here.

How to handle unclear questions (this is your main job — you're only ever asked something when a simpler keyword match already failed):
- If the message clearly relates to one or more of the facts above, answer using only those facts, even if it's phrased in a totally different way than the facts are written.
- If it's genuinely ambiguous which topic the visitor means (could be more than one of the facts above), ask a short, specific clarifying question — e.g. "Do you mean staking rewards, or the trait store?" — instead of guessing.
- If the message is a bit vague or incomplete, ask them to elaborate in a friendly way — e.g. "Could you tell me a bit more about what you're running into?" — rather than giving a generic non-answer.
- Only if it's clearly unrelated to BLOC entirely, or asks for something not covered above at all, say plainly you don't have that information and point them to Discord or Twitter/X.

Rules:
- Never give financial or investment advice, and never predict or promise that price/value will go up. If asked, say you can't predict the market, but BLOC itself is here to stay regardless.
- Never claim to be human. If asked, say you're Quil, BLOC's site assistant.
- Keep replies short — visitors are usually on mobile.`;

function corsHeaders() {
  return {
    'Content-Type': 'application/json',
  };
}

// Tries each model in MODELS in order. Falls through to the next one on a
// decommissioned/invalid-model error (400/404) so a Groq-side retirement
// doesn't take the whole bot down; a real failure (bad key, rate limit,
// network) just returns null on the first attempt without wasting the
// extra round trip.
async function callGroq(messages) {
  let lastErr = null;
  for (const model of MODELS) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${GROQ_API_KEY}`,
        },
        body: JSON.stringify({ model, messages, temperature: 0.4, max_tokens: 220 }),
      });

      if (res.ok) {
        const data = await res.json();
        return data?.choices?.[0]?.message?.content?.trim() || null;
      }

      const errText = await res.text();
      console.error('chatbot Groq error:', model, res.status, errText);
      lastErr = { status: res.status, body: errText };

      // Only a "this model no longer exists" style error is worth trying
      // the next model for — a bad key or rate limit will fail the same
      // way for every model, so stop immediately instead of burning
      // requests against the free-tier quota.
      const looksLikeBadModel = res.status === 400 || res.status === 404;
      if (!looksLikeBadModel) break;
    } catch (err) {
      console.error('chatbot fetch error:', model, err);
      lastErr = err;
      break;
    }
  }
  if (lastErr) console.error('chatbot: all models failed, last error:', lastErr);
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders(), body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (!GROQ_API_KEY) {
    console.error('chatbot error: GROQ_API_KEY is not set');
    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({ reply: "The chat assistant isn't set up yet — try our Discord or Twitter/X in the meantime!" }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const message = typeof payload.message === 'string' ? payload.message.trim() : '';
  const history = Array.isArray(payload.history) ? payload.history : [];

  if (!message) {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Message is required' }) };
  }
  if (message.length > 500) {
    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({ reply: "That's a bit long for me! Could you ask in a shorter message?" }),
    };
  }

  // Only keep the last few turns, and only well-formed ones — keeps the
  // request small/cheap and stops a tampered client payload from injecting
  // extra system messages.
  const trimmedHistory = history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-6)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 500) }));

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...trimmedHistory,
    { role: 'user', content: message },
  ];

  try {
    const reply = await callGroq(messages);
    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({
        reply: reply || "Sorry, I'm having trouble answering right now — try Discord or Twitter/X for a quick answer!",
      }),
    };
  } catch (err) {
    console.error('chatbot error:', err);
    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({ reply: "Sorry, something went wrong on my end — try again in a bit!" }),
    };
  }
};
