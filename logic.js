// Chain-agnostic trace rules. A new chain adapter only has to emit transfers
// with a total order (block, txIndex, logIndex) and answer classify().

// EVM addresses are hex. Solana base58 is case-sensitive, so only 0x is folded.
export function addressKey(value) {
  const text = String(value ?? '').trim();
  return /^0x/i.test(text) ? text.toLowerCase() : text;
}

export function cmpXfer(a, b) {
  if (a.block !== b.block) return a.block < b.block ? -1 : 1;
  // ponytail: Alchemy has a log index and no tx index. Log index already orders one block.
  if (a.logIndex >= 0 && b.logIndex >= 0 && a.logIndex !== b.logIndex) {
    return a.logIndex < b.logIndex ? -1 : 1;
  }
  if (a.txIndex !== b.txIndex) return a.txIndex < b.txIndex ? -1 : 1;
  if (a.logIndex !== b.logIndex) return a.logIndex < b.logIndex ? -1 : 1;
  return 0;
}

export function isAfter(xfer, cursor) {
  if (!cursor) return true;
  return cmpXfer(xfer, cursor) > 0;
}

// Outflow at least `factor` times the post-theft inflow.
export function shouldPauseVolume(inSum, outSum, factor) {
  if (inSum <= 0n || outSum <= 0n) return false;
  return outSum >= inSum * BigInt(factor);
}

// Walk outs in time order. `alreadyTaken` skips a prefix already attributed.
// `maxCount` caps how many edges one click may add.
export function takeAttributed(outs, budget, alreadyTaken, maxCount = 10000) {
  let skip = alreadyTaken;
  let left = budget;
  const result = [];
  if (left <= 0n) return result;
  for (const o of outs) {
    if (result.length >= maxCount) break;
    let available = o.amount;
    if (skip > 0n) {
      if (skip >= available) {
        skip -= available;
        continue;
      }
      available -= skip;
      skip = 0n;
    }
    if (available <= 0n) continue;
    const take = available < left ? available : left;
    result.push({
      from: o.from,
      to: o.to,
      amount: take,
      txAmount: o.amount,
      block: o.block,
      txIndex: o.txIndex,
      logIndex: o.logIndex,
      txHash: o.txHash,
      timestamp: o.timestamp ?? null,
    });
    left -= take;
    if (left === 0n) break;
  }
  return result;
}

export function formatUnits(amount, decimals, maxFrac = 4) {
  const neg = amount < 0n;
  const v = neg ? -amount : amount;
  const scale = 10n ** BigInt(decimals);
  const whole = v / scale;
  const frac = v % scale;
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = neg ? '-' : '';
  if (frac === 0n || maxFrac <= 0) return sign + grouped;
  const full = frac.toString().padStart(decimals, '0');
  let digits = full.slice(0, maxFrac).replace(/0+$/, '');
  if (!digits) {
    const i = full.search(/[1-9]/);
    digits = full.slice(0, Math.max(maxFrac, i + 1));
  }
  return sign + grouped + '.' + digits;
}

// EIP-7702 delegation designator is exactly 23 bytes: 0xef0100 || address.
// Longer bytecode that merely starts with that prefix stays a contract.
export function classifyCode(code) {
  const hex = String(code || '0x').toLowerCase();
  if (hex === '0x' || hex === '0x0') return { kind: 'eoa' };
  const body = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (body.length === 46 && body.startsWith('ef0100')) {
    return { kind: 'delegated', delegate: '0x' + body.slice(6) };
  }
  return { kind: 'contract' };
}
