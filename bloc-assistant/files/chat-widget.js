// chat-widget.js
// Logic + knowledge base for the "Ask BLOC" chat widget. Fully self-contained
// FAQ bot — no API, no backend. Everything it can answer lives in the
// BLOC_FAQ array below, sourced from index.html's sections and the
// published articles. To add or change what it knows, edit BLOC_FAQ (see
// the comment above it). Needs chat-widget.css (styling) and the markup
// in chat-widget.html to be present on the page for the buttons/panel to
// exist before this runs.

(function () {
  // ── BLOC_FAQ ──────────────────────────────────────────────────────
  // Everything the bot knows lives here, hardcoded, in this repo — no
  // API, no external service, nothing that can be shut down or expire.
  // Sourced from index.html's own sections plus the published articles
  // (Competition Series recaps, the staking explainer, Celestial Yokais).
  //
  // To add a new question: add an entry with a short list of `keywords`
  // (words/phrases a visitor might type) and the exact `answer` to show.
  // Matching is simple keyword overlap, not real language understanding
  // — so list a few natural variations of how someone might phrase it.
  //
  // NOTE: if a keyword phrase contains an apostrophe (can't, it's, etc.)
  // and the list uses single quotes, the apostrophe MUST be escaped with
  // a backslash (e.g. 'i can\'t stake') or it breaks the whole file —
  // every entry after the mistake silently stops working too.
  var BLOC_FAQ = [
    {
      id: 'about',
      keywords: ['what is bloc', 'about bloc', 'what\'s bloc', 'beaver lodge', 'what is this project', 'who are you', 'what is this site'],
      answer: "BLOC (Beaver Lodge Original Colony) is a collection of 999 hand-drawn Beaver NFTs on Solana, with 187+ unique traits, built around real builders in the crypto space."
    },
    {
      id: 'mint-price',
      keywords: ['mint price', 'mint cost', 'how much to mint', 'how much is minting', 'cost to mint', 'sol to mint', 'whitelist price', 'wl price', 'public mint'],
      answer: "Public Mint is 18 SOL, and Whitelist Mint is 12.50 SOL."
    },
    {
      id: 'apply-whitelist',
      keywords: ['how to get whitelist', 'whitelist spot', 'discount', 'secure whitelist', 'i want whitelist'],
      answer: "You can currently get whitelisted if you hold one of our partner projects, check them out on our collab project section. If not, we offer spots for those interested to secure a number of beavers. Just dm us on our x account @999BVERS."
    },
    {
      id: 'supply',
      keywords: ['how many beavers', 'total supply', 'total nfts', 'collection size', 'how many traits', 'unique traits', 'traits'],
      answer: "There are 999 Beaver NFTs total, with 187+ unique hand-drawn traits."
    },
    {
      id: 'trait-store',
      keywords: ['trait store', 'muddy', 'customize my beaver', 'angel wings', 'lil devil', 'buy a trait', 'extra traits'],
      answer: "Muddy's Trait Store lets holders buy extra traits, like Angel Wings or Lil Devil and many more to customize their Beaver."
    },
    {
      id: 'how-to-stake',
      keywords: ['how to stake', 'i can\'t stake', 'staking site can\'t read my wallet', 'staking site not working', 'staking site issue', 'staking site bug', 'phantom wallet not working when i stake', 'solflare wallet not working when i stake', 'backpack wallet not working when i stake'],
      answer: "When using a computer, check if you downloaded a wallet extension that you want to use. If you're using mobile phone, kindly use the built in browser inside your wallet. If problem is still present, please let us know by sending a dm on our official x account @999BVERS. Thank you."
    },
     {
      id: 'wallet-supported',
      keywords: ['what wallet can i use', 'wallet should i use', 'wallet to use for staking'],
      answer: "Currently, the supported wallet for our staking site are the following; phantom, solflare, and backpack. But if you want to request other wallets, we are hear to listen. Just send your suggestion on our x official account @999BVERS."
    },
    {
      id: 'staking-basics',
      keywords: ['staking', 'stake my beaver', 'how does staking work', 'what is staking'],
      answer: "Staking lets you make your Beaver work for you instead of just holding it. Each staked NFT earns points daily, which you can use to fell logs for bounty pool rewards or spend $CHEW to enter raffles."
    },
    {
      id: 'chew-token',
      keywords: ['chew', '$chew', 'what is chew', 'chew token', 'chew coin'],
      answer: "$CHEW is BLOC's ecosystem currency — it's not a memecoin nor a shitcoin and isn't meant to trade as a standalone crypto. It's used inside the BLOC ecosystem, mainly for felling trees and entering raffles, with more uses planned in the future."
    },
    {
      id: 'staking-mechanics',
      keywords: ['points', 'fell a log', 'fell logs', 'soft tree', 'hard tree', 'how many times', 'per day'],
      answer: "Each staked NFT earns 200 points a day, and you can fell logs (Soft or Hard Tree) up to 4 times a day if you have enough points. Felling a log gives you a chance to win a reward from the BLOC bounty pool. You can also use it to enter a raffle up to 5 times if there's an open one."
    },
    {
      id: 'staking-fees',
      keywords: ['gas fee', 'transaction fee', 'is staking free', 'does staking cost', 'wallet connect', 'transfer my nft'],
      answer: "Staking is completely free and transactionless — it just reads your NFT holdings, so there's no gas, no fees, and you never have to transfer your NFT."
    },
    {
      id: 'staking-boosts',
      keywords: ['holder boost', 'boost', 'collaborated collection', 'stack boost', 'collab collection'],
      answer: "Holding NFTs from BLOC's collaborated collections gives you a boost in staking — 1% per NFT, stacking up to 5% if you hold five from the same collection. The boost can increase if the collaborating project contributed to the bounty poll."
    },
    {
      id: 'bounty-pool',
      keywords: ['bounty pool', 'bounty', 'where do rewards come from'],
      answer: "The bounty pool is mainly funded by BLOC but is open to accept contributions from collaborated projects, it can be SOL, tokens, NFTs, or other rewards for holders to win by felling logs."
    },
    {
      id: 'competition-series',
      keywords: ['competition series', 'bloc competition', 'contest', 'how to join competition'],
      answer: "The BLOC Competition Series is a seasonal creative competition open to holders and non-holders alike — each season focuses on one creative discipline (Season 1 was poster design)."
    },
    {
      id: 'team',
      keywords: ['team', 'who made bloc', 'founder', 'artist', 'cfo', 'lore author', 'who is behind bloc', 'who runs bloc'],
      answer: "The founding team: Buzz (Founder), FabQuilp (Artist), Thirty (Creative Spark), DJDave (CFO), and AKCMetaBeast (Lore Author). For more information about them, navigate the team section."
    },
    {
      id: 'lore',
      keywords: ['lore', 'story of bloc', 'bloc universe', 'backstory'],
      answer: "BLOC's lore section is still marked Coming Soon — the story hasn't been published yet. Keep an eye on Discord or Twitter/X for when it drops."
    },
    {
      id: 'bbb',
      keywords: ['bbb', 'better business beaver', 'business spotlight', 'apply for a feature'],
      answer: "Better Business Beaver (BBB) is our upcoming feature spotlighting businesses our members are building — it's marked Coming Soon right now."
    },
    {
      id: 'partners',
      keywords: ['partners', 'partnership', 'who do you partner with', 'nestgrow', 'the hub', 'brandvault'],
      answer: "Our formal Partners section is still Coming Soon, but BLOC already works with collab projects like Dead Bunnies, Celestial Yokais, Stone Gods, and LeSuit DAO."
    },
    {
      id: 'community',
      keywords: ['discord', 'twitter', ' x ', 'community link', 'social media', 'contact you', 'how do i join'],
      answer: "Join us on Discord or follow us on Twitter/X — both are linked in the site nav!"
    },
    {
      id: 'games',
      keywords: ['game', 'games', 'beaver builder', 'play a game'],
      answer: "Yep — check out Beaver Builder and the rest of the BLOC Games hub for fun mini-games."
    }
  ];

  // Money-talk gets its own honest, human answer instead of being treated
  // like a normal FAQ lookup — the bot should never sound like it's
  // predicting prices or giving investment advice.
  var FINANCIAL_KEYWORDS = [
    'financial advice', 'investment advice', 'should i buy', 'should i invest',
    'should i sell', 'worth buying', 'worth investing', 'worth it',
    'good investment', 'make money', 'get rich', 'floor price', 'price prediction',
    'predict the price', 'predict the market', 'will it moon', 'gonna moon',
    'will the price', 'price go up', 'price going up', 'price will go up',
    'go up in value', 'go up in price', 'will it pump', 'pump', 'to the moon',
    'is it a good buy', 'roi', 'profit', 'moon'
  ];

  var GREETING_KEYWORDS = ['hello', 'hi ', 'hi!', 'hey', 'yo ', 'good morning', 'good afternoon', 'good evening', 'sup'];
  var THANKS_KEYWORDS = ['thank you', 'thanks', 'thx', 'appreciate it'];
  var FAREWELL_KEYWORDS = ['bye', 'goodbye', 'see you', 'see ya', 'later'];
  var IDENTITY_KEYWORDS = ['are you human', 'are you a bot', 'are you real', 'are you ai', 'are you a real person'];

  var FALLBACK_ANSWER = "There's no information available on that yet. Feel free to ask about minting, staking, the trait store, the Competition Series, or the team instead.";
  var FINANCIAL_ANSWER = "I can't give financial advice or predict where the price or market will go — that depends on way too many factors for anyone to say for sure. What I can tell you is this: BLOC is here to stay, regardless.";

  function normalize(text) {
    return ' ' + text.toLowerCase().replace(/[^\w\s'$]/g, ' ') + ' ';
  }

  function includesAny(q, list) {
    for (var i = 0; i < list.length; i++) {
      if (q.indexOf(list[i]) !== -1) return true;
    }
    return false;
  }

  // Small scorer: for each entry, sums the word-count of every keyword
  // phrase found in the message (so a specific 3-word phrase outweighs a
  // generic single-word one shared by several entries), picks the best
  // match. Good enough for a fixed FAQ — not meant to understand
  // free-form language the way a real AI model would.
  function findFaqAnswer(q) {
    var best = null, bestScore = 0;
    for (var i = 0; i < BLOC_FAQ.length; i++) {
      var entry = BLOC_FAQ[i];
      var score = 0;
      for (var j = 0; j < entry.keywords.length; j++) {
        var kw = entry.keywords[j].toLowerCase();
        if (q.indexOf(kw) !== -1) score += kw.trim().split(/\s+/).length;
      }
      if (score > bestScore) { bestScore = score; best = entry; }
    }
    return best ? best.answer : null;
  }

  function findAnswer(rawText) {
    var q = normalize(rawText);

    if (includesAny(q, FINANCIAL_KEYWORDS)) return FINANCIAL_ANSWER;
    if (includesAny(q, IDENTITY_KEYWORDS)) return "I'm BLOC's site assistant, not a real person. Just here to help you find what you need about the Colony.";
    if (includesAny(q, THANKS_KEYWORDS)) return "You're welcome! Let me know if there's anything else you'd like to know about BLOC.";
    if (includesAny(q, FAREWELL_KEYWORDS)) return "See you around the Colony!🦫";
    if (includesAny(q, GREETING_KEYWORDS) && rawText.trim().split(/\s+/).length <= 4) {
      return "Hey! What would you like to know about BLOC?";
    }

    return findFaqAnswer(q) || FALLBACK_ANSWER;
  }

  var btn = document.getElementById('bloc-chat-btn');
  var panel = document.getElementById('bloc-chat-panel');
  var closeBtn = document.getElementById('bloc-chat-close');
  var messagesEl = document.getElementById('bloc-chat-messages');
  var form = document.getElementById('bloc-chat-form');
  var input = document.getElementById('bloc-chat-input');

  var greeted = false;

  function addMessage(role, text) {
    var el = document.createElement('div');
    el.className = 'bloc-msg ' + (role === 'user' ? 'user' : 'bot');
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function openPanel() {
    panel.classList.add('open');
    if (!greeted) {
      greeted = true;
      addMessage('bot', "Hey! I'm Quil, the BLOC's site assistant. Take your time and ask me anything about Beaver Lodge Original Colony.");
    }
    input.focus();
  }

  btn.addEventListener('click', function () {
    panel.classList.contains('open') ? panel.classList.remove('open') : openPanel();
  });
  closeBtn.addEventListener('click', function () { panel.classList.remove('open'); });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    addMessage('user', text);
    addMessage('bot', findAnswer(text));
  });
})();
