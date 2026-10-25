const SYSTEM = '11111111111111111111111111111111';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ORDER = 1_000_000;
const MAX_TX_VERSION = 1;

const KNOWN = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
  So11111111111111111111111111111111111111112: 'wSOL',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cancelError() {
  const error = new Error('已取消');
  error.cancel = true;
  return error;
}

function raw(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  return null;
}

function pubkeyOf(key) {
  return typeof key === 'string' ? key : key?.pubkey;
}

function accountKeys(record) {
  const message = record.transaction?.message;
  const keys = (message?.accountKeys || []).map(pubkeyOf).filter(Boolean);
  const loaded = record.meta?.loadedAddresses;
  if (loaded) keys.push(...(loaded.writable || []), ...(loaded.readonly || []));
  return keys;
}

function tokenOwners(record) {
  const keys = accountKeys(record);
  const map = new Map();
  const rows = [...(record.meta?.preTokenBalances || []), ...(record.meta?.postTokenBalances || [])];
  for (const row of rows) {
    const address = keys[row.accountIndex];
    if (!address || !row.owner || !row.mint) continue;
    map.set(address, {
      owner: row.owner,
      mint: row.mint,
      decimals: row.uiTokenAmount?.decimals ?? 0,
    });
  }
  return map;
}

function instructions(record) {
  const outer = record.transaction?.message?.instructions || [];
  const inner = new Map((record.meta?.innerInstructions || []).map((item) => [item.index, item.instructions || []]));
  const list = [];
  outer.forEach((ix, index) => {
    list.push(ix);
    for (const child of inner.get(index) || []) list.push(child);
  });
  return list;
}

function isTokenProgram(ix) {
  return ix.program === 'spl-token' || ix.program === 'spl-token-2022' || ix.programId === TOKEN || ix.programId === TOKEN_2022;
}

function isSystemProgram(ix) {
  return ix.program === 'system' || ix.programId === SYSTEM;
}

function readTransfer(ix, owners) {
  const parsed = ix.parsed;
  if (!parsed || typeof parsed !== 'object') return null;
  const info = parsed.info || {};
  if (parsed.type !== 'transfer' && parsed.type !== 'transferChecked') return null;
  if (isSystemProgram(ix)) {
    const amount = raw(info.lamports);
    if (amount == null || amount <= 0n || !info.source || !info.destination) return null;
    return { mint: 'native', from: info.source, to: info.destination, amount, decimals: 9 };
  }
  if (!isTokenProgram(ix)) return null;
  const source = owners.get(info.source);
  const dest = owners.get(info.destination);
  const mint = info.mint || source?.mint || dest?.mint;
  const from = source?.owner || info.authority;
  const to = dest?.owner;
  const amount = raw(info.tokenAmount?.amount ?? info.amount);
  if (!mint || !from || !to || amount == null || amount <= 0n) return null;
  return {
    mint,
    from,
    to,
    amount,
    decimals: info.tokenAmount?.decimals ?? source?.decimals ?? dest?.decimals ?? 0,
  };
}

function ownerDeltas(rows) {
  const totals = new Map();
  const decimals = new Map();
  for (const row of rows) {
    if (!row.owner || !row.mint) continue;
    const key = `${row.owner}|${row.mint}`;
    const amount = raw(row.uiTokenAmount?.amount) || 0n;
    totals.set(key, (totals.get(key) || 0n) + amount);
    if (row.uiTokenAmount?.decimals != null) decimals.set(row.mint, row.uiTokenAmount.decimals);
  }
  return { totals, decimals };
}

function pair(senders, receivers) {
  const out = [];
  let si = 0;
  let ri = 0;
  let sLeft = senders[0]?.amount || 0n;
  let rLeft = receivers[0]?.amount || 0n;
  while (si < senders.length && ri < receivers.length) {
    const take = sLeft < rLeft ? sLeft : rLeft;
    if (take > 0n && senders[si].owner !== receivers[ri].owner) {
      out.push({ from: senders[si].owner, to: receivers[ri].owner, amount: take });
    }
    sLeft -= take;
    rLeft -= take;
    if (sLeft === 0n) {
      si += 1;
      sLeft = senders[si]?.amount || 0n;
    }
    if (rLeft === 0n) {
      ri += 1;
      rLeft = receivers[ri]?.amount || 0n;
    }
  }
  return out;
}

function fallbackTransfers(record, covered) {
  const meta = record.meta;
  const found = [];
  const pre = ownerDeltas(meta.preTokenBalances || []);
  const post = ownerDeltas(meta.postTokenBalances || []);
  const mints = new Set();
  for (const key of [...pre.totals.keys(), ...post.totals.keys()]) mints.add(key.split('|')[1]);
  for (const mint of mints) {
    if (covered.has(mint)) continue;
    const owners = new Set();
    for (const key of [...pre.totals.keys(), ...post.totals.keys()]) {
      if (key.endsWith('|' + mint)) owners.add(key.slice(0, -(mint.length + 1)));
    }
    const senders = [];
    const receivers = [];
    for (const owner of owners) {
      const key = `${owner}|${mint}`;
      const delta = (post.totals.get(key) || 0n) - (pre.totals.get(key) || 0n);
      if (delta < 0n) senders.push({ owner, amount: -delta });
      else if (delta > 0n) receivers.push({ owner, amount: delta });
    }
    for (const row of pair(senders, receivers)) {
      found.push({ ...row, mint, decimals: post.decimals.get(mint) ?? pre.decimals.get(mint) ?? 0 });
    }
  }
  if (covered.has('native')) return found;
  const keys = accountKeys(record);
  const tokenIndexes = new Set([
    ...(meta.preTokenBalances || []).map((row) => row.accountIndex),
    ...(meta.postTokenBalances || []).map((row) => row.accountIndex),
  ]);
  const senders = [];
  const receivers = [];
  for (let i = 0; i < keys.length; i += 1) {
    if (tokenIndexes.has(i)) continue;
    let delta = (raw(meta.postBalances?.[i]) || 0n) - (raw(meta.preBalances?.[i]) || 0n);
    if (i === 0) delta += raw(meta.fee) || 0n;
    if (delta < 0n) senders.push({ owner: keys[i], amount: -delta });
    else if (delta > 0n) receivers.push({ owner: keys[i], amount: delta });
  }
  for (const row of pair(senders, receivers)) found.push({ ...row, mint: 'native', decimals: 9 });
  return found;
}

// logIndex packs block position because the shared order compares log index
// before tx index. txIndex * 1e6 + instruction index stays unique inside a slot.
export function transfersFromTx(record, txIndex = 0) {
  if (!record?.meta || record.meta.err || !record.transaction?.message) return [];
  const signature = record.transaction.signatures?.[0] || record.signature || '';
  const index = record.transactionIndex ?? txIndex ?? 0;
  const owners = tokenOwners(record);
  const rows = [];
  const covered = new Set();
  let step = 0;
  for (const ix of instructions(record)) {
    const at = step;
    step += 1;
    const row = readTransfer(ix, owners);
    if (!row || row.from === row.to) continue;
    covered.add(row.mint);
    rows.push({ ...row, step: at });
  }
  for (const row of fallbackTransfers(record, covered)) {
    if (row.from === row.to) continue;
    rows.push({ ...row, step });
    step += 1;
  }
  return rows.map((row) => ({
    from: row.from,
    to: row.to,
    amount: row.amount,
    mint: row.mint,
    decimals: row.decimals,
    block: record.slot,
    txIndex: index,
    logIndex: index * ORDER + row.step,
    txHash: signature,
    timestamp: record.blockTime ?? null,
  }));
}

export function classifyAccount(value) {
  if (!value) return { kind: 'eoa', delegate: null };
  if (value.executable || (value.owner && value.owner !== SYSTEM)) return { kind: 'contract', delegate: null };
  return { kind: 'eoa', delegate: null };
}

function createLimiter(gapMs) {
  let lastStart = -gapMs;
  let scheduled = false;
  let active = 0;
  const queue = [];
  const kick = () => {
    if (scheduled || active > 0 || queue.length === 0) return;
    const wait = Math.max(0, lastStart + gapMs - Date.now());
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      if (active > 0 || queue.length === 0) return;
      const job = queue.shift();
      active += 1;
      lastStart = Date.now();
      job.fn().then(job.resolve, job.reject).finally(() => {
        active -= 1;
        kick();
      });
    }, wait);
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    kick();
  });
}

function retryable(error) {
  const message = `${error.message || ''}`.toLowerCase();
  return error.http === 429 || /rate|too many|temporar|timeout|timed out|econn|socket|network|429|overloaded|try again/.test(message);
}

function methodMissing(error) {
  const message = `${error.message || ''}`.toLowerCase();
  return error.code === -32601 || /unsupported method|method not found|unknown method|does not exist/.test(message);
}

export function createSolana(rpcUrl) {
  const limit = createLimiter(500);
  const symbols = new Map(Object.entries(KNOWN));

  async function rpcCall(method, params, signal) {
    let last;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (signal?.aborted) throw cancelError();
      try {
        return await limit(async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 25000);
          const onAbort = () => controller.abort();
          if (signal) {
            if (signal.aborted) controller.abort();
            else signal.addEventListener('abort', onAbort, { once: true });
          }
          try {
            const res = await fetch(rpcUrl, {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
              signal: controller.signal,
            });
            const text = await res.text();
            let parsed = null;
            try {
              parsed = text ? JSON.parse(text) : null;
            } catch {
              throw Object.assign(new Error(`RPC 返回的不是 JSON（HTTP ${res.status}）`), { http: res.status });
            }
            if (res.status === 429 || res.status === 408 || res.status >= 500) {
              throw Object.assign(new Error(parsed?.error?.message || `RPC HTTP ${res.status}`), { http: res.status });
            }
            if (parsed?.error) {
              const error = new Error(parsed.error.message || 'RPC 错误');
              error.code = parsed.error.code;
              throw error;
            }
            if (!res.ok) throw new Error(parsed?.error?.message || `RPC HTTP ${res.status}`);
            return parsed?.result;
          } catch (error) {
            if (signal?.aborted) throw cancelError();
            if (error.name === 'AbortError') throw Object.assign(new Error('RPC 超时'), { http: 408 });
            if (error instanceof TypeError) throw Object.assign(new Error('公共节点断开连接（network error），多半是请求太密'), { http: 429 });
            throw error;
          } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
          }
        });
      } catch (error) {
        last = error;
        if (error.cancel || signal?.aborted) throw error.cancel ? error : cancelError();
        if (!retryable(error) || attempt === 3) throw error;
        await sleep(500 * 2 ** attempt);
      }
    }
    throw last;
  }

  async function tip(signal) {
    return rpcCall('getSlot', [{ commitment: 'confirmed' }], signal);
  }

  async function symbolOf(mint, signal) {
    if (mint === 'native') return 'SOL';
    if (symbols.has(mint)) return symbols.get(mint);
    try {
      const asset = await rpcCall('getAsset', [{ id: mint }], signal);
      const symbol = asset?.content?.metadata?.symbol || asset?.token_info?.symbol || '';
      const name = symbol || `${mint.slice(0, 4)}…${mint.slice(-4)}`;
      symbols.set(mint, name);
      return name;
    } catch (error) {
      if (error.cancel) throw error;
      const name = `${mint.slice(0, 4)}…${mint.slice(-4)}`;
      symbols.set(mint, name);
      return name;
    }
  }

  async function txIndexOf(signature, slot, signal) {
    try {
      const block = await rpcCall('getBlock', [slot, {
        encoding: 'json',
        transactionDetails: 'signatures',
        rewards: false,
        maxSupportedTransactionVersion: MAX_TX_VERSION,
        commitment: 'confirmed',
      }], signal);
      const list = (block?.signatures || block?.transactions || []).map((item) => (
        typeof item === 'string' ? item : (item?.signature || item?.transaction?.signatures?.[0] || '')
      ));
      const index = list.indexOf(signature);
      return index >= 0 ? index : 0;
    } catch (error) {
      if (error.cancel) throw error;
      return 0;
    }
  }

  async function inspectTx(signature, tokenFilter, signal) {
    const [latest, tx] = await Promise.all([
      tip(signal),
      rpcCall('getTransaction', [signature, {
        encoding: 'jsonParsed',
        commitment: 'confirmed',
        maxSupportedTransactionVersion: MAX_TX_VERSION,
      }], signal),
    ]);
    if (!tx) throw new Error('节点上找不到这笔交易，确认签名和网络都是 Solana');
    if (tx.meta?.err) throw new Error('这笔交易失败了，没有资金转出');
    const txIndex = Number.isInteger(tx.transactionIndex)
      ? tx.transactionIndex
      : await txIndexOf(signature, tx.slot, signal);
    let rows = transfersFromTx({ ...tx, transactionIndex: txIndex }, txIndex);
    if (tokenFilter === 'native') rows = rows.filter((row) => row.mint === 'native');
    else if (tokenFilter) rows = rows.filter((row) => row.mint === tokenFilter);
    const assets = new Map();
    for (const row of rows) {
      if (assets.has(row.mint)) continue;
      const symbol = await symbolOf(row.mint, signal);
      assets.set(row.mint, row.mint === 'native'
        ? { type: 'native', id: 'native', symbol: 'SOL', decimals: 9 }
        : { type: 'spl', id: row.mint, symbol, decimals: row.decimals });
    }
    return {
      chainId: null,
      chainName: 'Solana',
      latest,
      txBlock: tx.slot,
      txHash: signature,
      transfers: rows.map((row) => ({
        from: row.from,
        to: row.to,
        amount: row.amount,
        block: row.block,
        txIndex: row.txIndex,
        logIndex: row.logIndex,
        txHash: row.txHash,
        timestamp: row.timestamp,
        asset: assets.get(row.mint),
      })),
    };
  }

  async function classify(address, _block, signal) {
    const result = await rpcCall('getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }], signal);
    return classifyAccount(result?.value);
  }

  function keep(row, asset) {
    return asset.id === 'native' || asset.type === 'native' ? row.mint === 'native' : row.mint === asset.id;
  }

  async function pages({ address, asset, fromBlock, toBlock, sortOrder, prior, signal, onProgress, onChunk }) {
    let paginationToken = '';
    const seen = new Set();
    let pagesSeen = 0;
    let truncated = false;
    // ponytail: prior history is the newest 4 pages. Forward scan stops when the token repeats.
    while (pagesSeen < (prior ? 4 : 100000)) {
      if (signal?.aborted) throw cancelError();
      if (onProgress) {
        await onProgress({
          phase: 'scan',
          mode: 'solana',
          from: fromBlock,
          to: toBlock,
          chunkFrom: fromBlock,
          chunkTo: toBlock,
          scanned: fromBlock,
          pending: true,
        });
      }
      const config = {
        transactionDetails: 'full',
        sortOrder,
        limit: 100,
        commitment: 'confirmed',
        encoding: 'jsonParsed',
        maxSupportedTransactionVersion: MAX_TX_VERSION,
        filters: {
          status: 'succeeded',
          tokenAccounts: 'balanceChanged',
          slot: prior ? { lte: toBlock } : { gte: fromBlock, lte: toBlock },
        },
      };
      if (paginationToken) config.paginationToken = paginationToken;
      let result;
      try {
        result = await rpcCall('getTransactionsForAddress', [address, config], signal);
      } catch (error) {
        if (methodMissing(error)) {
          throw new Error('这个节点没有 Solana 转账历史接口，请用 Alchemy 的 Solana 主网');
        }
        throw error;
      }
      const entries = result?.data || [];
      const ins = [];
      const outs = [];
      let scanned = fromBlock;
      for (const entry of entries) {
        scanned = entry.slot ?? scanned;
        for (const row of transfersFromTx(entry)) {
          if (!keep(row, asset)) continue;
          const item = {
            from: row.from,
            to: row.to,
            amount: row.amount,
            block: row.block,
            txIndex: row.txIndex,
            logIndex: row.logIndex,
            txHash: row.txHash,
            timestamp: row.timestamp,
          };
          if (row.to === address) ins.push(item);
          else if (row.from === address) outs.push(item);
        }
      }
      if (onChunk && (ins.length || outs.length)) await onChunk({ ins, outs });
      if (onProgress) {
        await onProgress({
          phase: 'scan',
          mode: 'solana',
          from: fromBlock,
          to: toBlock,
          scanned,
          pending: false,
        });
      }
      paginationToken = result?.paginationToken || '';
      pagesSeen += 1;
      if (!entries.length || !paginationToken || seen.has(paginationToken)) {
        truncated = Boolean(paginationToken);
        break;
      }
      seen.add(paginationToken);
    }
    if (prior && pagesSeen >= 4 && paginationToken) truncated = true;
    return { truncated };
  }

  async function scan(args) {
    await pages({ ...args, sortOrder: 'asc', prior: false });
  }

  async function links({ address, peers, asset, toBlock, signal }) {
    const want = new Set(peers);
    const rows = [];
    const result = await pages({
      address,
      asset,
      fromBlock: 0,
      toBlock,
      sortOrder: 'desc',
      prior: true,
      signal,
      onChunk: ({ ins = [], outs = [] }) => {
        for (const row of [...ins, ...outs]) {
          const other = row.from === address ? row.to : row.from;
          if (want.has(other)) rows.push(row);
        }
      },
    });
    return { rows, truncated: result.truncated };
  }

  async function priorBetween({ from, to, asset, toBlock, signal }) {
    const rows = [];
    let truncated = false;
    await pages({
      address: from,
      asset,
      fromBlock: 0,
      toBlock,
      sortOrder: 'desc',
      prior: true,
      signal,
      onChunk: ({ outs }) => {
        for (const row of outs) {
          if (row.to === to) rows.push(row);
        }
      },
    }).then((result) => {
      truncated = result.truncated;
    });
    return { rows, truncated };
  }

  async function hydrateTimes() {}

  return { id: 'solana', tip, classify, inspectTx, scan, hydrateTimes, priorBetween, links };
}
