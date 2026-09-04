// netlify/functions/fell-tree.js
//
// Spends $CHEW to "fell a tree" — atomically deducts the cost, picks a
// weighted-random reward from tree_rewards, generates a claim code, and
// logs the result to tree_fellings for manual fulfillment (see Step 10
// of the execution guide).
//
// Unlike stake/unstake, this moves real balance, so the deduction goes
// through the spend_chew() Postgres RPC (atomic, row-locked) instead of a
// JS read-then-write — see spend_chew_rpc.sql, must be run once in
// Supabase SQL Editor before this function will work.
//
// Env vars required: SUPABASE_URL, SUPABASE_SERVICE_KEY

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const { requireValidSession } = require('./utils/auth');

const sbHeaders = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

// Must match the costs shown on the staking page's chest cards.
const TREE_COSTS = {
  'Soft Tree': 500,
  'Hard Tree': 1500,
};

// tree_rewards.tree_type has a check constraint only allowing lowercase
// 'soft'/'hard' — this maps the frontend's display value to that.
const TREE_TYPE_DB_KEY = {
  'Soft Tree': 'soft',
  'Hard Tree': 'hard',
};

const CLAIM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity

function generateClaimCode() {
  let code = 'BLOC-';
  for (let i = 0; i < 6; i++) {
    code += CLAIM_CODE_CHARS[Math.floor(Math.random() * CLAIM_CODE_CHARS.length)];
  }
  return code;
}

// Picks one reward from a weighted pool. Expects rows with a numeric `weight`.
function weightedRandomPick(rewards) {
  const totalWeight = rewards.reduce((sum, r) => sum + r.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const reward of rewards) {
    roll -= reward.weight;
    if (roll <= 0) return reward;
  }
  return rewards[rewards.length - 1]; // floating-point fallback
}

async function refund(wallet, amount) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/refund_chew`, {
      method: 'POST',
      headers: sbHeaders,
      body: JSON.stringify({ p_wallet: wallet, p_amount: amount }),
    });
  } catch (e) {
    console.error('CRITICAL: refund_chew failed after a spend that could not be fulfilled', {
      wallet,
      amount,
      error: e.message,
    });
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let wallet, treeType;
  try {
    const body = JSON.parse(event.body);
    wallet = body.wallet;
    treeType = body.treeType;
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  if (!wallet || !treeType || !TREE_COSTS[treeType]) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'wallet and a valid treeType ("Soft Tree" or "Hard Tree") are required' }),
    };
  }

  if (!requireValidSession(event, wallet)) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: 'Invalid or expired session — please reconnect your wallet' }),
    };
  }

  const cost = TREE_COSTS[treeType];
  const dbTreeType = TREE_TYPE_DB_KEY[treeType];
  const DAILY_FELL_LIMIT = 4; // combined total, across BOTH tree types, per wallet, per UTC calendar day

  try {
    // 0. Daily limit check — BEFORE any $CHEW is touched, so a wallet at
    // the cap can't even get charged and then rejected. This counts ALL
    // fellings today regardless of tree type (a Soft + a Hard both count
    // toward the same shared limit of 2), reset at UTC midnight rather
    // than a rolling 24h window, so it's simple and predictable for both
    // players and you when checking logs.
    const now = new Date();
    const startOfTodayUTC = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()
    )).toISOString();

    const todaysFellsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/tree_fellings?wallet=eq.${wallet}&opened_at=gte.${startOfTodayUTC}&select=id`,
      { headers: sbHeaders }
    );
    const todaysFells = await todaysFellsRes.json();

    if (Array.isArray(todaysFells) && todaysFells.length >= DAILY_FELL_LIMIT) {
      return {
        statusCode: 429,
        body: JSON.stringify({
          error: `Daily limit reached — you can only fell ${DAILY_FELL_LIMIT} trees per day (combined, any type). Try again after midnight UTC.`,
        }),
      };
    }

    // 1. Atomically deduct the cost — fails cleanly if balance is insufficient,
    // and can't be double-spent by a duplicate/rapid request.
    const spendRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/spend_chew`, {
      method: 'POST',
      headers: sbHeaders,
      body: JSON.stringify({ p_wallet: wallet, p_amount: cost }),
    });

    if (!spendRes.ok) {
      throw new Error(`spend_chew RPC failed: ${spendRes.status}`);
    }

    const spendResult = await spendRes.json();
    const { success, new_balance } = Array.isArray(spendResult) ? spendResult[0] : spendResult;

    if (!success) {
      return {
        statusCode: 402,
        body: JSON.stringify({ error: 'Insufficient $CHEW balance', balance: new_balance }),
      };
    }

    // 2. Load the active, in-stock reward pool for this tree.
    const rewardsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/tree_rewards?tree_type=eq.${dbTreeType}&active=eq.true&or=(stock_remaining.is.null,stock_remaining.gt.0)&select=id,name,weight,stock_remaining`,
      { headers: sbHeaders }
    );
    const rewards = await rewardsRes.json();

    if (!Array.isArray(rewards) || rewards.length === 0) {
      // Nothing to award — refund immediately, don't leave the wallet short.
      await refund(wallet, cost);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'No rewards currently available for this tree — you have not been charged' }),
      };
    }

    // 3. Weighted-random pick.
    const picked = weightedRandomPick(rewards);

    // NEW: if this reward is a $CHEW amount (e.g. "10 $CHEW Bonus", "300
    // $CHEW Bonus"), credit it automatically instead of making the winner
    // DM a claim code — there's nothing for you to manually fulfill for a
    // points reward, so no reason to make them wait on you for it. Every
    // other reward type (Whitelist Spot, Bounty Slot, Rare 1-of-1, etc.)
    // is completely unaffected and still goes through the exact same
    // manual claim-code flow as before.
    const chewMatch = picked.name.match(/^(\d+(?:\.\d+)?)\s*\$CHEW\b/i);
    const isChewReward = !!chewMatch;
    const chewAmount = isChewReward ? parseFloat(chewMatch[1]) : 0;

    // NEW: if this reward has a pool of specific NFTs behind it (see
    // reward_nft_inventory_schema.sql), claim one automatically and reveal
    // it to the winner. The public rewards list only ever shows the
    // generic name ("Dead Bunny") — nobody sees which specific numbers
    // exist or how many are left. A reward with zero inventory rows here
    // is completely unaffected — this only activates for rewards you've
    // actually stocked with specific NFTs.
    let assignedNft = null;
    const inventoryCheckRes = await fetch(
      `${SUPABASE_URL}/rest/v1/reward_nft_inventory?reward_id=eq.${picked.id}&select=id&limit=1`,
      { headers: sbHeaders }
    );
    const inventoryExists = await inventoryCheckRes.json();
    const usesNftInventory = Array.isArray(inventoryExists) && inventoryExists.length > 0;

    if (usesNftInventory) {
      // Try a few times in case of a race with another simultaneous winner
      // claiming the same candidate row.
      for (let attempt = 0; attempt < 3 && !assignedNft; attempt++) {
        const candidateRes = await fetch(
          `${SUPABASE_URL}/rest/v1/reward_nft_inventory?reward_id=eq.${picked.id}&assigned_wallet=is.null&select=id,nft_identifier&limit=1`,
          { headers: sbHeaders }
        );
        const candidates = await candidateRes.json();
        if (!Array.isArray(candidates) || candidates.length === 0) break; // none left

        const candidate = candidates[0];
        const claimRes = await fetch(
          `${SUPABASE_URL}/rest/v1/reward_nft_inventory?id=eq.${candidate.id}&assigned_wallet=is.null`,
          {
            method: 'PATCH',
            headers: { ...sbHeaders, Prefer: 'return=representation' },
            body: JSON.stringify({ assigned_wallet: wallet, assigned_at: new Date().toISOString() }),
          }
        );
        const claimed = await claimRes.json();
        if (Array.isArray(claimed) && claimed.length > 0) {
          assignedNft = candidate.nft_identifier;
        }
        // else: another request won the race for that exact row — loop and try the next candidate.
      }

      if (!assignedNft) {
        // This reward is SUPPOSED to have inventory but none was available
        // to claim — stock_remaining is out of sync with real inventory.
        // Don't hand out an undeliverable promise; refund and stop clean.
        await refund(wallet, cost);
        return {
          statusCode: 500,
          body: JSON.stringify({ error: `${picked.name} is out of stock — you have not been charged` }),
        };
      }
    }

    // 4. If the reward has limited stock, decrement stock_remaining (never
    // the original `stock` column, which stays as the fixed total). The
    // optimistic check against the value we just read means that in the
    // rare case another request wins the race for the last unit, this
    // simply no-ops and the claim is still honored (the loss is one unit
    // of oversell on a very low-traffic path, not a lost or duplicated
    // $CHEW spend).
    if (picked.stock_remaining !== null && picked.stock_remaining !== undefined) {
      await fetch(
        `${SUPABASE_URL}/rest/v1/tree_rewards?id=eq.${picked.id}&stock_remaining=eq.${picked.stock_remaining}`,
        {
          method: 'PATCH',
          headers: sbHeaders,
          body: JSON.stringify({ stock_remaining: picked.stock_remaining - 1 }),
        }
      );
    }

    // 5. Generate a unique claim code (retry on the astronomically unlikely collision).
    // Still generated even for auto-credited $CHEW rewards, since
    // claim_code is a required column and it's harmless to keep one on
    // record for consistency/audit — it's just never shown to the winner
    // as something to act on in that case.
    let claimCode;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generateClaimCode();
      const existsRes = await fetch(
        `${SUPABASE_URL}/rest/v1/tree_fellings?claim_code=eq.${candidate}&select=id`,
        { headers: sbHeaders }
      );
      const existing = await existsRes.json();
      if (Array.isArray(existing) && existing.length === 0) {
        claimCode = candidate;
        break;
      }
    }

    if (!claimCode) {
      await refund(wallet, cost);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Failed to generate a unique claim code — you have not been charged' }),
      };
    }

    // 6. Record the felling. $CHEW rewards are logged as 'auto_credited'
    // (already fulfilled, nothing pending) instead of 'unclaimed', so they
    // never show up in your manual claim backlog.
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/tree_fellings`, {
      method: 'POST',
      headers: { ...sbHeaders, Prefer: 'return=representation' },
      body: JSON.stringify({
        wallet,
        tree_type: treeType,
        reward_id: picked.id,
        reward_name: picked.name,
        points_spent: cost,
        claim_code: claimCode,
        claim_status: isChewReward ? 'auto_credited' : 'unclaimed',
        share_bonus_claimed: false,
        assigned_nft: assignedNft,
      }),
    });

    if (!insertRes.ok) {
      await refund(wallet, cost);
      // If an NFT was already claimed from inventory, release it back —
      // otherwise it'd be stuck marked as assigned to a felling that never
      // actually got recorded.
      if (assignedNft) {
        await fetch(
          `${SUPABASE_URL}/rest/v1/reward_nft_inventory?reward_id=eq.${picked.id}&nft_identifier=eq.${encodeURIComponent(assignedNft)}&assigned_wallet=eq.${wallet}`,
          {
            method: 'PATCH',
            headers: sbHeaders,
            body: JSON.stringify({ assigned_wallet: null, assigned_at: null }),
          }
        );
      }
      throw new Error(`Failed to log tree felling: ${insertRes.status}`);
    }

    // Link the inventory row back to this specific felling record, now that we have its id.
    if (assignedNft) {
      const insertedRow = (await insertRes.json())[0];
      if (insertedRow?.id) {
        await fetch(
          `${SUPABASE_URL}/rest/v1/reward_nft_inventory?reward_id=eq.${picked.id}&nft_identifier=eq.${encodeURIComponent(assignedNft)}&assigned_wallet=eq.${wallet}`,
          {
            method: 'PATCH',
            headers: sbHeaders,
            body: JSON.stringify({ tree_felling_id: insertedRow.id }),
          }
        );
      }
    }

    // 7. Audit trail for the spend.
    await fetch(`${SUPABASE_URL}/rest/v1/point_ledger`, {
      method: 'POST',
      headers: sbHeaders,
      body: JSON.stringify({
        wallet,
        amount: -cost,
        reason: `fell_tree (${treeType} → ${picked.name})`,
      }),
    });

    // NEW: auto-credit the $CHEW reward, if that's what was won.
    let finalBalance = new_balance;
    if (isChewReward && chewAmount > 0) {
      const creditRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/refund_chew`, {
        method: 'POST',
        headers: sbHeaders,
        body: JSON.stringify({ p_wallet: wallet, p_amount: chewAmount }),
      });

      if (creditRes.ok) {
        finalBalance = new_balance + chewAmount;

        await fetch(`${SUPABASE_URL}/rest/v1/point_ledger`, {
          method: 'POST',
          headers: sbHeaders,
          body: JSON.stringify({
            wallet,
            amount: chewAmount,
            reason: `fell_tree_reward (${treeType} → ${picked.name})`,
          }),
        });
      } else {
        // Extremely unlikely, but if the credit itself fails, don't lie to
        // the winner about their new balance — log it loudly so it can be
        // manually corrected, but keep responding successfully since the
        // felling itself (spend + reward selection) already succeeded.
        console.error(`CRITICAL: failed to auto-credit ${chewAmount} $CHEW to ${wallet} for ${picked.name} (tree_felling claim_code: ${claimCode})`);
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        rewardName: picked.name,
        claimCode,
        newBalance: finalBalance,
        autoCredited: isChewReward,
        chewAmount: isChewReward ? chewAmount : undefined,
        assignedNft: assignedNft || undefined,
      }),
    };
  } catch (err) {
    console.error('fell-tree error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to fell tree' }) };
  }
};
