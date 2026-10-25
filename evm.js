import { classifyCode } from './logic.js';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const OWNERS_SELECTOR = '0xa0e67e2b';

export function decodeOwners(data) {
  const hex = String(data || '').replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length < 128 || hex.length % 64 !== 0) return [];
  let offset = 0;
  let length = 0;
  try {
    offset = Number(BigInt(`0x${hex.slice(0, 64)}`));
    const at = offset * 2;
    if (!Number.isInteger(at) || at < 0 || at + 64 > hex.length) return [];
    length = Number(BigInt(`0x${hex.slice(at, at + 64)}`));
  } catch {
    return [];
  }
  if (!Number.isInteger(length) || length < 0 || length > 25) return [];
  const owners = [];
  for (let i = 0; i < length; i += 1) {
    const start = offset * 2 + 64 + i * 64;
    const word = hex.slice(start, start + 64);
    if (word.length < 64) return owners;
    owners.push(`0x${word.slice(24).toLowerCase()}`);
  }
  return owners;
}

export async function readSafeOwners(rpc, address) {
  let url;
  try {
    url = new URL(String(rpc || '').trim());
  } catch {
    throw new Error('RPC 地址无法解析');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('RPC 只支持 http 或 https');
  const to = String(address || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(to)) throw new Error('地址应为 0x 加 40 位十六进制');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to, data: OWNERS_SELECTOR }, 'latest'],
    }),
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok || body?.error) throw new Error(body?.error?.message || `RPC HTTP ${res.status}`);
  return decodeOwners(body?.result);
}

const CHAIN_META = {
  1: ['Ethereum', 'ETH'],
  10: ['Optimism', 'ETH'],
  137: ['Polygon', 'POL'],
  8453: ['Base', 'ETH'],
  42161: ['Arbitrum', 'ETH'],
  5042: ['Arc', 'USDC'],
};

export function chainName(chainId) {
  return (CHAIN_META[Number(chainId)] || [])[0] || '';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function hex(n) {
  return '0x' + n.toString(16);
}

function int(value, fallback = 0) {
  if (value == null || value === '0x') return fallback;
  try {
    return Number(BigInt(value));
  } catch {
    return fallback;
  }
}

function cancelError() {
  const error = new Error('已取消');
  error.cancel = true;
  return error;
}

function errorKind(error) {
  if (error.kind) return error.kind;
  const message = `${error.message || ''}`.toLowerCase();
  if (error.http === 429 || error.code === -32005 || error.code === 429) return 'retry';
  if (/rate|too many request|temporar|busy|econn|socket|network|429|overloaded|try again/.test(message)) return 'retry';
  if (/timeout|timed out/.test(message)) return 'timeout';
  if (/range|exceed|too many|too large|response size|log size|query returned more|block range|more than|results|header not found/.test(message)) return 'split';
  return 'fatal';
}

function isStateUnavailable(error) {
  const message = `${error.message || ''}`.toLowerCase();
  return /missing trie|historical|state not available|archive|pruned|ancient|not found/.test(message);
}

function createLimiter(concurrency, gapMs) {
  let active = 0;
  let lastStart = 0;
  let scheduled = false;
  const queue = [];
  const kick = () => {
    if (scheduled || active >= concurrency || queue.length === 0) return;
    const wait = Math.max(0, lastStart + gapMs - Date.now());
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      if (active >= concurrency || queue.length === 0) return;
      const job = queue.shift();
      active += 1;
      lastStart = Date.now();
      kick();
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

const INTERNAL_CHAINS = new Set([1, 137, 8453, 5042]);
const METADATA_CHAINS = new Set([1, 10, 137, 8453, 42161]);

function stampMetadata(chainId, params) {
  if (METADATA_CHAINS.has(Number(chainId))) params.withMetadata = true;
  return params;
}

export function isAlchemyUrl(rpcUrl) {
  try {
    return new URL(rpcUrl).hostname.endsWith('alchemy.com');
  } catch {
    return false;
  }
}

// ponytail: uniqueId is "hash:log:N" for tokens. External/internal have no log index,
// so those same-block transfers cannot be ordered against the theft cursor.
export function alchemyTransfer(row) {
  if (!row) return null;
  const from = (row.from || '').toLowerCase();
  const to = (row.to || '').toLowerCase();
  if (!from || !to || from === to) return null;
  let amount = 0n;
  try {
    amount = BigInt(row.rawContract?.value || '0x0');
  } catch {
    return null;
  }
  if (amount <= 0n) return null;
  const log = String(row.uniqueId || '').match(/:log:(\d+)$/);
  const stamp = row.metadata?.blockTimestamp ? Date.parse(row.metadata.blockTimestamp) : NaN;
  return {
    from,
    to,
    amount,
    block: int(row.blockNum),
    txIndex: 0,
    logIndex: log ? Number(log[1]) : -1,
    txHash: (row.hash || '').toLowerCase(),
    timestamp: Number.isFinite(stamp) ? Math.floor(stamp / 1000) : null,
  };
}

function padTopic(address) {
  return '0x' + address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

function topicAddress(topic) {
  if (!topic || topic.length < 42) return null;
  return ('0x' + topic.slice(-40)).toLowerCase();
}

function decodeAbiString(hexData) {
  if (!hexData || hexData === '0x') return '';
  const body = hexData.slice(2);
  if (body.length === 64) {
    return Buffer.from(body, 'hex').toString('utf8').replace(/\0+$/g, '').trim();
  }
  if (body.length < 128) return '';
  const len = Number(BigInt('0x' + body.slice(64, 128)));
  if (!Number.isInteger(len) || len < 0 || len > 64) return '';
  return Buffer.from(body.slice(128, 128 + len * 2), 'hex').toString('utf8').replace(/\0/g, '').trim();
}

function okStatus(status) {
  if (status == null) return true;
  try {
    return BigInt(status) === 1n;
  } catch {
    return false;
  }
}

// ponytail: standard Transfer(address indexed, address indexed, uint256) only.
// ERC-721 and tokens that don't index from/to are invisible to this filter.
function decodeTransfer(log) {
  if (!log || log.removed) return null;
  if (!log.topics || log.topics.length !== 3) return null;
  if ((log.topics[0] || '').toLowerCase() !== TRANSFER_TOPIC) return null;
  if (!log.data || log.data === '0x') return null;
  const from = topicAddress(log.topics[1]);
  const to = topicAddress(log.topics[2]);
  if (!from || !to || from === to) return null;
  let amount;
  try {
    amount = BigInt(log.data);
  } catch {
    return null;
  }
  if (amount <= 0n) return null;
  return {
    from,
    to,
    amount,
    block: int(log.blockNumber),
    txIndex: int(log.transactionIndex),
    logIndex: int(log.logIndex),
    txHash: (log.transactionHash || '').toLowerCase(),
    timestamp: null,
  };
}

export function createEvm(rpcUrl) {
  // ponytail: Alchemy free tier is 300 CU/s and alchemy_getAssetTransfers costs 120 CU.
  // One call at a time with a 500ms gap stays near 240 CU/s. A 429 still retries.
  const limit = createLimiter(1, 500);
  let transfersApi = isAlchemyUrl(rpcUrl) ? null : false;
  const codeCache = new Map();
  const timeCache = new Map();
  const tokenCache = new Map();

  async function rpcFetch(payload, signal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const body = Array.isArray(payload)
        ? payload.map((item, index) => ({ jsonrpc: '2.0', id: index, method: item.method, params: item.params }))
        : { jsonrpc: '2.0', id: 1, method: payload.method, params: payload.params };
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': 'tx-tracer/0.1',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        throw Object.assign(new Error(`RPC 返回的不是 JSON（HTTP ${res.status}）`), {
          kind: res.status === 429 ? 'retry' : 'fatal',
        });
      }
      if (res.status === 429 || res.status === 408 || res.status >= 500) {
        throw Object.assign(new Error(parsed?.error?.message || `RPC HTTP ${res.status}`), {
          kind: 'retry',
          http: res.status,
        });
      }
      if (!res.ok) throw new Error(parsed?.error?.message || `RPC HTTP ${res.status}`);
      return parsed;
    } catch (error) {
      if (signal?.aborted) throw cancelError();
      if (error.cancel) throw error;
      if (error.name === 'AbortError') throw Object.assign(new Error('RPC 超时'), { kind: 'timeout' });
      if (error instanceof TypeError) {
        throw Object.assign(new Error('公共节点断开连接（network error），多半是请求太密'), { kind: 'retry' });
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async function request(payload, signal) {
    let last;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const body = await limit(() => rpcFetch(payload, signal));
        if (!Array.isArray(body) && body?.error) {
          const error = new Error(body.error.message || 'RPC 错误');
          error.code = body.error.code;
          const kind = errorKind(error);
          if (kind === 'retry' || kind === 'timeout') error.kind = kind;
          throw error;
        }
        return body;
      } catch (error) {
        last = error;
        if (error.cancel || signal?.aborted) throw error.cancel ? error : cancelError();
        const kind = error.kind || errorKind(error);
        if (kind !== 'retry' || attempt === 3) throw error;
        await sleep(500 * 2 ** attempt);
      }
    }
    throw last;
  }

  async function rpcCall(method, params, signal) {
    const body = await request({ method, params }, signal);
    return body?.result;
  }

  async function rpcBatch(calls, signal) {
    if (calls.length === 1) return [await rpcCall(calls[0].method, calls[0].params, signal)];
    try {
      const body = await request(calls, signal);
      if (!Array.isArray(body)) throw new Error('batch');
      const byId = new Map(body.map((item) => [Number(item.id), item]));
      return calls.map((_, index) => {
        const item = byId.get(index);
        if (!item || item.error) return null;
        return item.result;
      });
    } catch (error) {
      if (error.cancel || signal?.aborted) throw error.cancel ? error : cancelError();
      if ((error.kind || errorKind(error)) === 'retry') throw error;
      const out = [];
      for (const call of calls) {
        try {
          out.push(await rpcCall(call.method, call.params, signal));
        } catch (itemError) {
          if (itemError.cancel) throw itemError;
          out.push(null);
        }
      }
      return out;
    }
  }

  async function getLogs(filter, from, to, signal, onRange) {
    if (onRange) await onRange(from, to);
    try {
      const body = await request({
        method: 'eth_getLogs',
        params: [{ ...filter, fromBlock: hex(from), toBlock: hex(to) }],
      }, signal);
      if (body?.error) {
        const error = new Error(body.error.message || 'eth_getLogs 失败');
        error.code = body.error.code;
        throw error;
      }
      return body?.result || [];
    } catch (error) {
      if (error.cancel || signal?.aborted) throw error.cancel ? error : cancelError();
      const kind = error.kind || errorKind(error);
      // Only a rejected range is split. A dropped connection must not fan out into more calls.
      if (kind === 'split' && to > from) {
        const mid = (from + to) >> 1;
        const left = await getLogs(filter, from, mid, signal, onRange);
        const right = await getLogs(filter, mid + 1, to, signal, onRange);
        return left.concat(right);
      }
      throw error;
    }
  }

  async function tokenMeta(address, signal) {
    const key = address.toLowerCase();
    if (tokenCache.has(key)) return tokenCache.get(key);
    let decimals = 18;
    let symbol = 'ERC20';
    try {
      const raw = await rpcCall('eth_call', [{ to: address, data: '0x313ce567' }, 'latest'], signal);
      if (raw && raw !== '0x') decimals = Number(BigInt(raw));
    } catch {
      // keep the default and still trace; the panel shows raw-scale amounts if this is wrong
    }
    try {
      const raw = await rpcCall('eth_call', [{ to: address, data: '0x95d89b41' }, 'latest'], signal);
      const text = decodeAbiString(raw);
      if (text) symbol = text;
    } catch {
      // symbol is display-only
    }
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) decimals = 18;
    const meta = { decimals, symbol };
    tokenCache.set(key, meta);
    return meta;
  }

  async function tip(signal) {
    return int(await rpcCall('eth_blockNumber', [], signal));
  }

  async function classify(address, block, signal) {
    const tag = block === 'latest' ? 'latest' : hex(block);
    const key = address.toLowerCase() + ':' + tag;
    if (codeCache.has(key)) return codeCache.get(key);
    try {
      const code = await rpcCall('eth_getCode', [address, tag], signal);
      const result = classifyCode(code);
      codeCache.set(key, result);
      return result;
    } catch (error) {
      if (error.cancel) throw error;
      if (isStateUnavailable(error)) return { kind: 'unknown', error: error.message };
      throw error;
    }
  }

  async function hydrateTimes(transfers, signal) {
    const missing = [...new Set(transfers.filter((item) => item.timestamp == null).map((item) => item.block))];
    for (let index = 0; index < missing.length; index += 20) {
      const slice = missing.slice(index, index + 20);
      const blocks = await rpcBatch(
        slice.map((block) => ({ method: 'eth_getBlockByNumber', params: [hex(block), false] })),
        signal,
      );
      slice.forEach((block, blockIndex) => {
        const timestamp = blocks[blockIndex]?.timestamp;
        timeCache.set(block, timestamp ? int(timestamp) : null);
      });
    }
    for (const transfer of transfers) {
      if (transfer.timestamp == null) transfer.timestamp = timeCache.get(transfer.block) ?? null;
    }
  }

  async function inspectTx(txHash, tokenFilter, signal) {
    const [chainHex, latestHex, tx, receipt] = await Promise.all([
      rpcCall('eth_chainId', [], signal),
      rpcCall('eth_blockNumber', [], signal),
      rpcCall('eth_getTransactionByHash', [txHash], signal),
      rpcCall('eth_getTransactionReceipt', [txHash], signal),
    ]);
    if (!tx || !receipt) throw new Error('节点上找不到这笔交易，确认哈希和 RPC 是同一条链');
    if (receipt.status != null && !okStatus(receipt.status)) throw new Error('这笔交易失败了，没有资金转出');
    const chainId = int(chainHex);
    const meta = CHAIN_META[chainId];
    if (!meta) throw new Error('这条链没有 Alchemy 转账接口');
    const [chainName, nativeSymbol] = meta;
    const header = await rpcCall('eth_getBlockByNumber', [receipt.blockNumber, false], signal);
    const timestamp = header?.timestamp ? int(header.timestamp) : null;
    const block = int(receipt.blockNumber);
    const txIndex = int(receipt.transactionIndex);
    const nativeAsset = { type: 'native', id: 'native', symbol: nativeSymbol, decimals: 18 };
    const transfers = [];
    const wantNative = !tokenFilter || tokenFilter === 'native';
    const onlyToken = tokenFilter && tokenFilter !== 'native' ? tokenFilter.toLowerCase() : null;

    if (wantNative && BigInt(tx.value || '0x0') > 0n) {
      const to = (tx.to || receipt.contractAddress || '').toLowerCase();
      if (to) {
        transfers.push({
          from: tx.from.toLowerCase(),
          to,
          amount: BigInt(tx.value),
          block,
          txIndex,
          logIndex: -1,
          txHash,
          timestamp,
          asset: nativeAsset,
        });
      }
    }

    if (tokenFilter !== 'native') {
      const logs = (receipt.logs || []).filter((log) => {
        if ((log.topics?.[0] || '').toLowerCase() !== TRANSFER_TOPIC) return false;
        if (onlyToken && (log.address || '').toLowerCase() !== onlyToken) return false;
        return true;
      });
      const tokens = [...new Set(logs.map((log) => log.address.toLowerCase()))];
      const metas = new Map();
      await Promise.all(tokens.map(async (token) => {
        metas.set(token, await tokenMeta(token, signal));
      }));
      for (const log of logs) {
        const decoded = decodeTransfer(log);
        if (!decoded) continue;
        const token = log.address.toLowerCase();
        const meta = metas.get(token);
        transfers.push({
          ...decoded,
          timestamp,
          asset: { type: 'erc20', id: token, symbol: meta.symbol, decimals: meta.decimals },
        });
      }
    }

    transfers.sort((a, b) => a.logIndex - b.logIndex);
    return {
      chainId,
      chainName,
      latest: int(latestHex),
      txBlock: block,
      txHash,
      transfers,
    };
  }

  async function scanAlchemy({ address, asset, fromBlock, toBlock, chainId, signal, onChunk, onProgress }) {
    const me = address.toLowerCase();
    const token = asset.type === 'erc20' ? asset.id.toLowerCase() : '';
    const categories = asset.type === 'native'
      ? ['external', ...(INTERNAL_CHAINS.has(Number(chainId)) ? ['internal'] : [])]
      : ['erc20'];
    const pull = async (direction) => {
      const found = [];
      let pageKey = '';
      const seenPages = new Set();
      do {
        if (signal?.aborted) throw cancelError();
        if (onProgress) {
          await onProgress({
            phase: 'scan',
            mode: asset.type === 'native' ? 'blocks' : 'logs',
            from: fromBlock,
            to: toBlock,
            chunkFrom: fromBlock,
            chunkTo: toBlock,
            scanned: found.length ? found[found.length - 1].block : fromBlock - 1,
            pending: true,
          });
        }
        const params = {
          fromBlock: hex(fromBlock),
          toBlock: hex(toBlock),
          category: categories,
          excludeZeroValue: true,
          order: 'asc',
          maxCount: '0x3e8',
          [direction]: address,
        };
        if (token) params.contractAddresses = [token];
        if (pageKey) params.pageKey = pageKey;
        stampMetadata(chainId, params);
        const result = await rpcCall('alchemy_getAssetTransfers', [params], signal);
        const rows = result?.transfers || [];
        for (const row of rows) {
          if (token && (row.rawContract?.address || '').toLowerCase() !== token) continue;
          const transfer = alchemyTransfer(row);
          if (!transfer) continue;
          if (direction === 'fromAddress' ? transfer.from === me : transfer.to === me) found.push(transfer);
        }
        pageKey = result?.pageKey || '';
        if (!pageKey || seenPages.has(pageKey)) break;
        seenPages.add(pageKey);
      } while (pageKey);
      return found;
    };
    const outs = await pull('fromAddress');
    const ins = await pull('toAddress');
    if (onProgress) {
      await onProgress({
        phase: 'scan',
        mode: asset.type === 'native' ? 'blocks' : 'logs',
        from: fromBlock,
        to: toBlock,
        chunkFrom: fromBlock,
        chunkTo: toBlock,
        scanned: toBlock,
        pending: false,
      });
    }
    if (ins.length || outs.length) await onChunk({ ins, outs });
  }

  function transfersMissing(error) {
    const message = `${error.message || ''}`.toLowerCase();
    return error.code === -32601 || /unsupported method|method not found|unknown method|does not exist/.test(message);
  }

  async function scan({ address, asset, fromBlock, toBlock, chainId, signal, onChunk, onProgress }) {
    const id = Number(chainId);
    if (Number.isInteger(id) && id > 0 && !CHAIN_META[id]) throw new Error('这条链没有 Alchemy 转账接口');
    if (isAlchemyUrl(rpcUrl) && transfersApi !== false) {
      try {
        await scanAlchemy({ address, asset, fromBlock, toBlock, chainId, signal, onChunk, onProgress });
        transfersApi = true;
        return;
      } catch (error) {
        if (error.cancel || signal?.aborted) throw error;
        if (!transfersMissing(error)) throw error;
        transfersApi = false;
      }
    }
    if (asset.type === 'native') {
      if (isAlchemyUrl(rpcUrl)) {
        throw new Error('这条链的 Alchemy 没有转账接口，查不了原生币。ERC-20 仍可以查。');
      }
      await scanNative({ address, fromBlock, toBlock, signal, onChunk, onProgress });
      return;
    }
    const token = asset.id.toLowerCase();
    const padded = padTopic(address);
    const base = { address: token };
    const keep = (log) => (log.address || '').toLowerCase() === token;
    // ponytail: one eth_getLogs per direction for the whole window. Topic slots are AND,
    // so from and to cannot share a call. The node splits the range only if it rejects it.
    const pull = async (topics) => {
      const logs = await getLogs(
        { ...base, topics },
        fromBlock,
        toBlock,
        signal,
        (start, end) => onProgress?.({
          phase: 'scan',
          mode: 'logs',
          from: fromBlock,
          to: toBlock,
          chunkFrom: start,
          chunkTo: end,
          scanned: start - 1,
          pending: true,
        }),
      );
      if (onProgress) {
        await onProgress({
          phase: 'scan',
          mode: 'logs',
          from: fromBlock,
          to: toBlock,
          chunkFrom: fromBlock,
          chunkTo: toBlock,
          scanned: toBlock,
          pending: false,
        });
      }
      return logs.filter(keep).map(decodeTransfer).filter(Boolean);
    };
    const outs = await pull([TRANSFER_TOPIC, padded, null]);
    const ins = await pull([TRANSFER_TOPIC, null, padded]);
    if (ins.length || outs.length) await onChunk({ ins, outs });
  }

  async function scanNative({ address, fromBlock, toBlock, signal, onChunk, onProgress }) {
    // ponytail: native value has no log, so a non-Alchemy RPC walks every block to the tip.
    // A contract forwarding ETH via CALL is invisible here.
    const me = address.toLowerCase();
    const page = 8;
    for (let start = fromBlock; start <= toBlock; start += page) {
      if (signal?.aborted) throw cancelError();
      const end = Math.min(toBlock, start + page - 1);
      if (onProgress) {
        await onProgress({ phase: 'scan', mode: 'blocks', from: fromBlock, to: toBlock, chunkFrom: start, chunkTo: end, scanned: start - 1, pending: true });
      }
      const numbers = [];
      for (let block = start; block <= end; block += 1) numbers.push(block);
      const blocks = await rpcBatch(
        numbers.map((block) => ({ method: 'eth_getBlockByNumber', params: [hex(block), true] })),
        signal,
      );
      const candidates = [];
      for (const block of blocks) {
        if (!block?.transactions?.length) continue;
        if (typeof block.transactions[0] === 'string') {
          throw new Error('这个 RPC 没有返回完整交易，无法扫描原生币');
        }
        const blockNumber = int(block.number);
        const timestamp = int(block.timestamp);
        for (const tx of block.transactions) {
          const value = BigInt(tx.value || '0x0');
          if (value <= 0n) continue;
          const from = (tx.from || '').toLowerCase();
          const to = tx.to ? tx.to.toLowerCase() : null;
          if (from !== me && to !== me) continue;
          candidates.push({ tx, blockNumber, timestamp, value, from, to });
        }
      }
      const receipts = candidates.length
        ? await rpcBatch(
          candidates.map((item) => ({ method: 'eth_getTransactionReceipt', params: [item.tx.hash] })),
          signal,
        )
        : [];
      const ins = [];
      const outs = [];
      candidates.forEach((item, index) => {
        const receipt = receipts[index];
        if (!receipt || !okStatus(receipt.status)) return;
        const to = item.to || (receipt.contractAddress ? receipt.contractAddress.toLowerCase() : null);
        if (!to || to === item.from) return;
        const transfer = {
          from: item.from,
          to,
          amount: item.value,
          block: item.blockNumber,
          txIndex: int(item.tx.transactionIndex),
          logIndex: -1,
          txHash: item.tx.hash.toLowerCase(),
          timestamp: item.timestamp,
        };
        if (item.from === me) outs.push(transfer);
        else ins.push(transfer);
      });
      if (ins.length || outs.length) await onChunk({ ins, outs });
      if (onProgress) {
        await onProgress({ phase: 'scan', mode: 'blocks', from: fromBlock, to: toBlock, chunkFrom: start, chunkTo: end, scanned: end, pending: false });
      }
    }
  }

  // ponytail: one pair query, newest first, stop after 4 pages (4000). Older rows are dropped.
  async function priorBetween({ from, to, asset, toBlock, chainId, signal }) {
    if (!isAlchemyUrl(rpcUrl)) return { rows: [], truncated: false };
    const sender = from.toLowerCase();
    const recipient = to.toLowerCase();
    const token = asset.type === 'erc20' ? asset.id.toLowerCase() : '';
    const categories = asset.type === 'native'
      ? ['external', ...(INTERNAL_CHAINS.has(Number(chainId)) ? ['internal'] : [])]
      : ['erc20'];
    const rows = [];
    let pageKey = '';
    const seenPages = new Set();
    let truncated = false;
    for (let page = 0; page < 4; page += 1) {
      if (signal?.aborted) throw cancelError();
      const params = {
        fromBlock: '0x0',
        toBlock: hex(toBlock),
        fromAddress: sender,
        toAddress: recipient,
        category: categories,
        excludeZeroValue: true,
        order: 'desc',
        maxCount: '0x3e8',
      };
      if (token) params.contractAddresses = [token];
      if (pageKey) params.pageKey = pageKey;
      stampMetadata(chainId, params);
      const result = await rpcCall('alchemy_getAssetTransfers', [params], signal);
      for (const row of result?.transfers || []) {
        if (token && (row.rawContract?.address || '').toLowerCase() !== token) continue;
        const transfer = alchemyTransfer(row);
        if (!transfer || transfer.from !== sender || transfer.to !== recipient) continue;
        rows.push(transfer);
      }
      pageKey = result?.pageKey || '';
      if (!pageKey || seenPages.has(pageKey)) break;
      seenPages.add(pageKey);
      if (page === 3) truncated = true;
    }
    return { rows, truncated };
  }

  // ponytail: newest 4 pages each way. A busy wallet can hide an older link.
  async function links({ address, peers, asset, toBlock, chainId, signal }) {
    if (!isAlchemyUrl(rpcUrl)) throw new Error('添加地址需要 Alchemy 的转账接口');
    const me = address.toLowerCase();
    const want = new Set(peers.map((item) => String(item).toLowerCase()));
    const token = asset.type === 'native' ? '' : asset.id.toLowerCase();
    const categories = asset.type === 'native'
      ? ['external', ...(INTERNAL_CHAINS.has(Number(chainId)) ? ['internal'] : [])]
      : ['erc20'];
    const rows = [];
    let truncated = false;
    for (const field of ['fromAddress', 'toAddress']) {
      let pageKey = '';
      const seenPages = new Set();
      for (let page = 0; page < 4; page += 1) {
        if (signal?.aborted) throw cancelError();
        const params = {
          fromBlock: '0x0',
          toBlock: hex(toBlock || 0),
          [field]: me,
          category: categories,
          excludeZeroValue: true,
          order: 'desc',
          maxCount: '0x3e8',
        };
        if (token) params.contractAddresses = [token];
        if (pageKey) params.pageKey = pageKey;
        stampMetadata(chainId, params);
        const result = await rpcCall('alchemy_getAssetTransfers', [params], signal);
        for (const row of result?.transfers || []) {
          if (token && (row.rawContract?.address || '').toLowerCase() !== token) continue;
          const transfer = alchemyTransfer(row);
          if (!transfer) continue;
          const other = field === 'fromAddress' ? transfer.to : transfer.from;
          if (want.has(other)) rows.push(transfer);
        }
        pageKey = result?.pageKey || '';
        if (!pageKey || seenPages.has(pageKey)) break;
        seenPages.add(pageKey);
        if (page === 3) truncated = true;
      }
    }
    return { rows, truncated };
  }

  return { id: 'evm', tip, classify, inspectTx, scan, hydrateTimes, priorBetween, links };
}
