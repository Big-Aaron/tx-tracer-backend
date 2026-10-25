import { randomUUID } from 'node:crypto';
import { createEvm } from './evm.js';
import { createSolana } from './solana.js';
import {
  addressKey,
  cmpXfer,
  formatUnits,
  isAfter,
  shouldPauseVolume,
  takeAttributed,
} from './logic.js';

// Adding a chain: implement inspectTx, classify, scan, hydrateTimes, tip
// and flip `implemented`. block/txIndex/logIndex only need a total order.
// Pause rules stay here.
export const CHAINS = [
  { id: 'evm', label: 'EVM', implemented: true, hint: 'ETH 与 ERC-20' },
  { id: 'solana', label: 'Solana', implemented: true, hint: 'SOL 与 SPL' },
  { id: 'ton', label: 'TON', implemented: false, hint: '后续' },
  { id: 'sui', label: 'Sui', implemented: false, hint: '后续' },
  { id: 'btc', label: 'Bitcoin', implemented: false, hint: '后续' },
  { id: 'aptos', label: 'Aptos', implemented: false, hint: '后续' },
  { id: 'tron', label: 'Tron', implemented: false, hint: '后续' },
  { id: 'stellar', label: 'Stellar', implemented: false, hint: '后续' },
];

const AUTO_FANOUT = 15;
const MANUAL_FANOUT = 40;
const sessions = new Map();

export function assertRpcUrl(rpc) {
  let url;
  try {
    url = new URL(String(rpc || '').trim());
  } catch {
    throw new Error('RPC 地址无法解析');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('RPC 只支持 http 或 https');
  }
  return url.toString();
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

export function assertTxHash(hash, chain = 'evm') {
  const value = String(hash || '').trim();
  if (chain === 'solana') {
    if (!BASE58.test(value) || value.length < 64 || value.length > 100) {
      throw new Error('Solana 交易签名应为 base58');
    }
    return value;
  }
  let hexHash = value;
  if (!hexHash.startsWith('0x') && /^[0-9a-fA-F]{64}$/.test(hexHash)) hexHash = '0x' + hexHash;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hexHash)) throw new Error('交易哈希应为 0x 加 64 位十六进制');
  return hexHash.toLowerCase();
}

export function assertToken(token, chain = 'evm') {
  if (!token) return null;
  const value = String(token).trim();
  if (!value) return null;
  if (chain === 'solana') {
    if (value === 'native') return 'native';
    if (!BASE58.test(value) || value.length < 32 || value.length > 48) {
      throw new Error('Solana 代币 mint 应为 base58');
    }
    return value;
  }
  let hexToken = value;
  if (!hexToken.startsWith('0x') && /^[0-9a-fA-F]{40}$/.test(hexToken)) hexToken = '0x' + hexToken;
  if (!/^0x[0-9a-fA-F]{40}$/.test(hexToken)) {
    throw new Error('代币合约应为 0x 加 40 位十六进制，留空表示这笔交易里的全部转账');
  }
  return hexToken.toLowerCase();
}

export function assertAddress(address, chain = 'evm') {
  const value = String(address || '').trim();
  if (chain === 'solana') {
    if (!BASE58.test(value) || value.length < 32 || value.length > 48) throw new Error('Solana 地址应为 base58');
    return value;
  }
  let hex = value;
  if (/^0x/i.test(hex)) hex = '0x' + hex.slice(2);
  else if (/^[0-9a-fA-F]{40}$/.test(hex)) hex = '0x' + hex;
  if (!/^0x[0-9a-fA-F]{40}$/.test(hex)) throw new Error('地址应为 0x 加 40 位十六进制');
  return hex.toLowerCase();
}

export function parseOptions(input = {}) {
  const num = (value, fallback, min, max) => {
    const parsed = Number(value ?? fallback);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(parsed)));
  };
  return {
    maxDepth: num(input.maxDepth, 4, 1, 12),
    volumeFactor: num(input.volumeFactor, 5, 2, 100),
  };
}

function createAdapter(chain, rpc) {
  const id = chain || 'evm';
  const url = assertRpcUrl(rpc);
  if (id === 'evm') return createEvm(url);
  if (id === 'solana') return createSolana(url);
  const found = CHAINS.find((item) => item.id === id);
  throw new Error(found ? `${found.label} 还没有接入` : '未知的链');
}

function short(address) {
  return address.slice(0, 6) + '…' + address.slice(-4);
}

function ratioText(inSum, outSum) {
  const hundredths = (outSum * 100n) / inSum;
  const whole = hundredths / 100n;
  const frac = hundredths % 100n;
  return `${whole}.${frac.toString().padStart(2, '0')}`;
}

function cancelError() {
  const error = new Error('已取消');
  error.cancel = true;
  return error;
}

function blank(address) {
  return {
    address,
    kind: null,
    status: 'pending',
    reason: '',
    depth: 0,
    taintedIn: 0n,
    taintedOut: 0n,
    inBlock: null,
    inTime: null,
    cursor: null,
    inEdges: [],
    outs: null,
    outsCover: 0n,
    scanComplete: false,
    flowIn: 0n,
    flowOut: 0n,
    delegate: null,
    returned: false,
    usedLatestCode: false,
    contractOverridden: false,
    volumeOverridden: false,
    classifyError: '',
    scanFrom: null,
    scanTo: null,
    expanded: false,
  };
}

function enqueue(session, address) {
  const node = session.nodes[address];
  if (!node || node.status === 'source' || node.expanded) return;
  if (session.queued.has(address)) return;
  session.queued.add(address);
  session.queue.push(address);
}

function seed(session, match) {
  const from = addressKey(match.from);
  const to = addressKey(match.to);
  if (from === to) throw new Error('转出和接收是同一个地址');
  const root = blank(from);
  root.kind = 'source';
  root.status = 'source';
  root.depth = 0;
  root.expanded = true;
  root.taintedIn = match.amount;
  root.taintedOut = match.amount;
  root.inBlock = match.block;
  root.inTime = match.timestamp;
  const edge = {
    id: 'e1',
    from,
    to,
    amount: match.amount,
    txAmount: match.txAmount ?? match.amount,
    block: match.block,
    txIndex: match.txIndex,
    logIndex: match.logIndex,
    txHash: match.txHash,
    time: match.timestamp ?? null,
  };
  session.edgeSeq = 1;
  session.edges.push(edge);
  session.nodes[from] = root;
  session.root = from;
  const child = blank(to);
  child.depth = 1;
  child.taintedIn = match.amount;
  child.inBlock = match.block;
  child.inTime = match.timestamp ?? null;
  child.cursor = { block: match.block, txIndex: match.txIndex, logIndex: match.logIndex };
  child.inEdges = [edge];
  session.nodes[to] = child;
  enqueue(session, to);
}

function addFlowEdge(session, fromNode, part, follow = true) {
  const to = addressKey(part.to);
  const edge = {
    id: 'e' + (++session.edgeSeq),
    from: fromNode.address,
    to,
    amount: part.amount,
    txAmount: part.txAmount,
    block: part.block,
    txIndex: part.txIndex,
    logIndex: part.logIndex,
    txHash: part.txHash,
    time: part.timestamp ?? null,
  };
  session.edges.push(edge);
  const root = session.nodes[session.root];
  if (to === session.root) {
    root.returned = true;
    return;
  }
  let child = session.nodes[to];
  if (!child) {
    child = blank(to);
    child.depth = fromNode.depth + 1;
    child.cursor = { block: part.block, txIndex: part.txIndex, logIndex: part.logIndex };
    child.inBlock = part.block;
    child.inTime = part.timestamp ?? null;
    session.nodes[to] = child;
  } else if (fromNode.depth + 1 < child.depth) {
    child.depth = fromNode.depth + 1;
  }
  child.inEdges.push(edge);
  child.taintedIn += part.amount;
  const incoming = { block: part.block, txIndex: part.txIndex, logIndex: part.logIndex };
  if (child.cursor && cmpXfer(incoming, child.cursor) < 0) {
    if (child.expanded) {
      child.status = 'paused_more';
      child.reason = '发现更早的一笔汇入，已暂停，避免把同一段转出算两次。';
    } else {
      child.cursor = incoming;
      child.inBlock = part.block;
      child.inTime = part.timestamp ?? child.inTime;
      child.kind = null;
      child.scanComplete = false;
      child.outs = null;
      child.outsCover = 0n;
      if (child.status.startsWith('paused') && child.status !== 'paused_contract') {
        child.status = 'pending';
        child.volumeOverridden = false;
      }
    }
  }
  if (child.scanComplete && child.taintedIn > child.outsCover && child.flowOut > child.outsCover) {
    child.scanComplete = false;
    child.outs = null;
  }
  if (child.expanded && child.taintedIn > child.taintedOut && child.status !== 'paused_more') {
    child.status = 'paused_more';
    child.reason = '又有被追踪资金汇入，已暂停。';
  } else if (follow && !child.expanded && !child.status.startsWith('paused')) {
    enqueue(session, to);
  }
}

function releaseChildren(session, address) {
  for (const edge of session.edges) {
    if (edge.from === address) enqueue(session, edge.to);
  }
}

async function scanInto(session, node) {
  let latest = session.latest;
  try {
    latest = await session.adapter.tip(session.signal);
    session.latest = latest;
  } catch (error) {
    if (error.cancel) throw error;
  }
  const fromBlock = node.inBlock;
  const toBlock = latest;
  node.scanFrom = fromBlock;
  node.scanTo = toBlock;
  const seen = new Set(node.inEdges.map((edge) => `${edge.txHash}:${edge.logIndex}`));
  let flowIn = 0n;
  for (const edge of node.inEdges) flowIn += edge.txAmount;
  let flowOut = 0n;
  const kept = [];
  let keptSum = 0n;
  const keepBudget = node.taintedIn > 0n ? node.taintedIn : 1n;
  if (toBlock >= fromBlock) {
    await session.adapter.scan({
      address: node.address,
      asset: session.asset,
      fromBlock,
      toBlock,
      chainId: session.chainId,
      signal: session.signal,
      onProgress: (progress) => {
        session.emit('progress', { ...progress, address: short(node.address) });
      },
      onChunk: ({ ins, outs }) => {
        const items = [
          ...ins.map((item) => ({ ...item, dir: 'in' })),
          ...outs.map((item) => ({ ...item, dir: 'out' })),
        ].sort(cmpXfer);
        for (const item of items) {
          if (item.amount <= 0n) continue;
          if (addressKey(item.from) === addressKey(item.to)) continue;
          if (item.dir === 'in') {
            const id = `${item.txHash}:${item.logIndex}`;
            if (seen.has(id) || !isAfter(item, node.cursor)) continue;
            flowIn += item.amount;
          } else if (isAfter(item, node.cursor)) {
            flowOut += item.amount;
            // ponytail: keep only the FIFO prefix that can still carry the tainted amount.
            if (keptSum < keepBudget) {
              kept.push(item);
              keptSum += item.amount;
            }
          }
        }
      },
    });
  }
  await session.adapter.hydrateTimes(kept, session.signal);
  node.flowIn = flowIn;
  node.flowOut = flowOut;
  node.outs = kept;
  node.outsCover = keptSum;
  node.scanComplete = true;
}

function volumeReason(node, asset, factor) {
  const incoming = formatUnits(node.flowIn, asset.decimals);
  const outgoing = formatUnits(node.flowOut, asset.decimals);
  const ratio = node.flowIn === 0n ? '∞' : ratioText(node.flowIn, node.flowOut);
  return `被盗后转入 ${incoming} ${asset.symbol}，转出 ${outgoing} ${asset.symbol}，约为 ${ratio} 倍（阈值 ${factor}），已暂停。`;
}

async function expandNode(session, address, { force }) {
  const node = session.nodes[address];
  if (!node || node.status === 'source') return;
  if (session.signal?.aborted) throw cancelError();
  const left = () => node.taintedIn - node.taintedOut;
  if (!force && node.expanded && left() <= 0n) return;
  if (!force && node.status.startsWith('paused')) return;

  if (!force && node.taintedOut === 0n && node.depth > session.options.maxDepth) {
    node.status = 'paused_limit';
    node.reason = `超过最大跳数 ${session.options.maxDepth}，已暂停。`;
    return;
  }

  node.status = 'tracing';
  session.emit('graph', serialize(session));

  if (!node.kind) {
    session.emit('progress', {
      phase: 'classify',
      address: short(address),
      block: node.inBlock,
      message: session.adapter.id === 'solana' ? `正在确认 ${short(address)} 是普通地址还是程序` : '',
    });
    const result = await session.adapter.classify(address, node.inBlock, session.signal);
    node.kind = result.kind;
    node.delegate = result.delegate || null;
    node.classifyError = result.error || '';
  } else if (force && node.kind === 'unknown') {
    session.emit('progress', { phase: 'load', message: `历史状态不可读，改为读取 ${short(address)} 的当前代码` });
    const result = await session.adapter.classify(address, 'latest', session.signal);
    if (result.kind !== 'unknown') {
      node.kind = result.kind;
      node.delegate = result.delegate || null;
      node.usedLatestCode = true;
      node.classifyError = '';
    } else {
      node.classifyError = result.error || node.classifyError;
    }
  }

  if (node.kind === 'unknown') {
    node.status = 'paused_unknown';
    node.reason = '节点没有返回资金转入当时的代码。公共节点经常只保留近期状态。可以换一个保留历史状态的 RPC，或直接继续（将改用当前代码）。';
    return;
  }

  if (!force && !node.contractOverridden && node.kind === 'contract') {
    node.status = 'paused_contract';
    node.reason = session.adapter.id === 'solana'
      ? '资金进入程序或程序控制的地址，这条链路已暂停。'
      : '资金进入合约，这条链路已暂停。';
    if (session.queue.length) {
      session.emit('progress', {
        phase: 'load',
        message: session.adapter.id === 'solana'
          ? `${short(address)} 由程序控制，这条链路暂停，继续查其他地址`
          : `${short(address)} 是合约，这条链路暂停，继续查其他地址`,
      });
    }
    return;
  }
  if (force && node.kind === 'contract') node.contractOverridden = true;

  if (!node.scanComplete) await scanInto(session, node);

  if (!force && !node.volumeOverridden && node.taintedOut === 0n && shouldPauseVolume(node.flowIn, node.flowOut, session.options.volumeFactor)) {
    const shown = takeAttributed(node.outs || [], left(), node.taintedOut, AUTO_FANOUT);
    for (const part of shown) {
      addFlowEdge(session, node, part, false);
      const child = session.nodes[addressKey(part.to)];
      if (child?.status === 'pending' && !child.reason) {
        child.reason = '上一跳转出达到倍数，收款地址先画在图上，没有继续往下查。';
      }
    }
    node.taintedOut += shown.reduce((sum, part) => sum + part.amount, 0n);
    node.expanded = false;
    node.status = 'paused_volume';
    node.reason = volumeReason(node, session.asset, session.options.volumeFactor);
    return;
  }
  if (force) node.volumeOverridden = true;

  const cap = force ? MANUAL_FANOUT : AUTO_FANOUT;
  if (!force) {
    const preview = takeAttributed(node.outs || [], left(), node.taintedOut, 10000);
    if (preview.length > AUTO_FANOUT) {
      node.status = 'paused_volume';
      node.reason = `被追踪资金在窗口内被拆成 ${preview.length} 笔转出，已暂停。`;
      return;
    }
  }

  const attributed = takeAttributed(node.outs || [], left(), node.taintedOut, cap);
  for (const part of attributed) addFlowEdge(session, node, part);
  node.taintedOut += attributed.reduce((sum, part) => sum + part.amount, 0n);

  const remaining = left();
  const more = remaining > 0n && node.flowOut > node.taintedOut && attributed.length >= cap;
  if (more) {
    node.expanded = false;
    node.status = 'paused_volume';
    node.reason = `单次最多展开 ${cap} 笔，剩余资金可继续追查。`;
    if (force) releaseChildren(session, node.address);
    return;
  }

  node.expanded = true;
  if (remaining > 0n) {
    node.status = 'holding';
    const holding = session.adapter.id === 'solana'
      ? '直到当前最新 slot，剩余资金还停在这里。'
      : '直到当前最新区块，剩余资金还停在这里。';
    node.reason = node.contractOverridden && session.adapter.id === 'evm' && session.asset.type === 'native' && node.flowOut === 0n
      ? '窗口内没有这笔合约发出的外部原生币转账。标准 RPC 看不到合约内部转出的 ETH。'
      : holding;
  } else {
    node.status = 'forwarded';
    node.reason = node.usedLatestCode ? '这一跳用的是节点当前代码，不是资金转入当时的代码。' : '';
  }
  if (force) releaseChildren(session, node.address);
}

async function attachSourceOuts(session) {
  const node = session.nodes[session.root];
  const seedEdge = session.edges[0];
  node.cursor = { block: seedEdge.block, txIndex: seedEdge.txIndex, logIndex: seedEdge.logIndex };
  node.inBlock = seedEdge.block;
  let latest = session.latest;
  try {
    latest = await session.adapter.tip(session.signal);
    session.latest = latest;
  } catch (error) {
    if (error.cancel) throw error;
  }
  const fromBlock = node.inBlock;
  const toBlock = latest;
  if (toBlock < fromBlock) return;
  const outs = [];
  await session.adapter.scan({
    address: node.address,
    asset: session.asset,
    fromBlock,
    toBlock,
    chainId: session.chainId,
    signal: session.signal,
    onProgress: (progress) => {
      session.emit('progress', { ...progress, address: short(node.address) });
    },
    onChunk: ({ outs: chunk = [] }) => {
      for (const item of chunk) {
        if (item.amount <= 0n) continue;
        if (addressKey(item.from) !== node.address) continue;
        if (!isAfter(item, node.cursor)) continue;
        outs.push(item);
      }
    },
  });
  outs.sort(cmpXfer);
  await session.adapter.hydrateTimes(outs, session.signal);
  node.scanFrom = fromBlock;
  node.scanTo = toBlock;
  for (let index = 0; index < outs.length; index += 1) {
    const item = outs[index];
    const follow = index < AUTO_FANOUT;
    addFlowEdge(session, node, {
      to: item.to,
      amount: item.amount,
      txAmount: item.amount,
      block: item.block,
      txIndex: item.txIndex,
      logIndex: item.logIndex,
      txHash: item.txHash,
      timestamp: item.timestamp ?? null,
    }, follow);
    if (!follow) {
      const child = session.nodes[addressKey(item.to)];
      if (child?.status === 'pending' && !child.reason) {
        child.reason = '起点在被选中的那笔之后又转出的同一种代币，先画在图上。';
      }
    }
  }
  if (outs.length > AUTO_FANOUT) {
    node.reason = `这笔之后还有 ${outs.length} 笔同代币转出。图上已画出，自动只继续查前 ${AUTO_FANOUT} 笔。`;
  }
}

function dedupeRows(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const id = `${row.txHash}:${row.logIndex}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(row);
  }
  return out;
}

async function attachPriors(session) {
  if (typeof session.adapter.priorBetween !== 'function') return;
  const pending = [];
  const seen = new Set();
  for (const edge of session.edges) {
    if (edge.related) continue;
    const key = `${edge.from}>${edge.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cached = session.priors.get(key);
    if (cached && cached.toBlock >= session.latest) continue;
    pending.push(edge);
  }
  for (const edge of pending) {
    if (session.signal?.aborted) throw cancelError();
    const key = `${edge.from}>${edge.to}`;
    session.emit('progress', {
      phase: 'load',
      message: `查看 ${short(edge.from)} → ${short(edge.to)} 此前的同代币转账`,
    });
    let pack = { rows: [], truncated: false };
    try {
      const result = await session.adapter.priorBetween({
        from: edge.from,
        to: edge.to,
        asset: session.asset,
        toBlock: session.latest,
        chainId: session.chainId,
        signal: session.signal,
      });
      pack = {
        rows: dedupeRows(result?.rows),
        truncated: Boolean(result?.truncated),
      };
    } catch (error) {
      if (error.cancel) throw error;
    }
    session.priors.set(key, { ...pack, toBlock: session.latest });
  }
  for (const edge of session.edges) {
    const pack = session.priors.get(`${edge.from}>${edge.to}`);
    if (!pack) continue;
    edge.priorTruncated = pack.truncated;
    edge.earlier = pack.rows.filter((row) => cmpXfer(row, edge) < 0);
  }
}

// ponytail: FIFO shift is the breadth-first walk. One paused address just returns here.
async function expandLoop(session) {
  while (session.queue.length) {
    if (session.signal?.aborted) throw cancelError();
    const address = session.queue.shift();
    session.queued.delete(address);
    await expandNode(session, address, { force: false });
    await attachPriors(session);
    session.emit('graph', serialize(session));
  }
}

function attachRun(session, requestSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (requestSignal) {
    if (requestSignal.aborted) controller.abort();
    else requestSignal.addEventListener('abort', abort, { once: true });
  }
  session.signal = controller.signal;
  session.stop = abort;
  return () => {
    requestSignal?.removeEventListener('abort', abort);
    if (session.stop === abort) session.stop = () => {};
  };
}

function remember(session) {
  sessions.set(session.id, session);
  while (sessions.size > 8) {
    const id = sessions.keys().next().value;
    if (id === session.id) break;
    const old = sessions.get(id);
    old.stop?.();
    sessions.delete(id);
  }
}

function makeSession({ adapter, info, match, options, emit }) {
  const session = {
    id: randomUUID(),
    adapter,
    emit: emit || (() => {}),
    options,
    asset: match.asset,
    chainId: info.chainId ?? null,
    chainName: info.chainName ?? '',
    latest: info.latest ?? match.block,
    txHash: match.txHash,
    nodes: {},
    edges: [],
    queue: [],
    queued: new Set(),
    edgeSeq: 0,
    root: '',
    priors: new Map(),
    busy: false,
    signal: undefined,
    stop: () => {},
  };
  seed(session, match);
  return session;
}

function publicAmount(amount, decimals, frac) {
  return formatUnits(amount, decimals, frac);
}

function relationsOf(edges, decimals) {
  const groups = new Map();
  for (const edge of edges) {
    const key = `${edge.from}>${edge.to}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(edge);
  }
  const relations = new Map();
  for (const [key, list] of groups) {
    const seen = new Set();
    const txs = [];
    let truncated = false;
    const push = (tx) => {
      const id = `${tx.txHash}:${tx.logIndex}`;
      if (!tx.txHash || seen.has(id)) return;
      seen.add(id);
      txs.push(tx);
    };
    for (const edge of list) {
      truncated = truncated || Boolean(edge.priorTruncated);
      push({
        txHash: edge.txHash,
        logIndex: edge.logIndex,
        block: edge.block,
        time: edge.time,
        amount: edge.txAmount,
        traced: !edge.related,
        related: Boolean(edge.related),
        partial: edge.amount !== edge.txAmount,
        tainted: edge.amount,
      });
      for (const old of edge.earlier || []) {
        push({
          txHash: old.txHash,
          logIndex: old.logIndex,
          block: old.block,
          time: old.timestamp ?? old.time ?? null,
          amount: old.amount,
          traced: false,
          partial: false,
          tainted: old.amount,
        });
      }
    }
    txs.sort((a, b) => (a.block - b.block) || ((a.logIndex ?? 0) - (b.logIndex ?? 0)));
    const total = txs.reduce((sum, tx) => sum + tx.amount, 0n);
    const latest = txs.reduce((max, tx) => (tx.time != null && tx.time > max ? tx.time : max), 0);
    relations.set(key, {
      amountDisplay: publicAmount(total, decimals, 4),
      count: txs.length,
      latest: latest || null,
      truncated,
      history: txs.map((tx) => ({
        txHash: tx.txHash,
        logIndex: tx.logIndex,
        block: tx.block,
        time: tx.time,
        amountDisplay: publicAmount(tx.amount, decimals, 4),
        traced: tx.traced,
        related: Boolean(tx.related),
        partial: tx.partial,
        taintedDisplay: tx.partial ? publicAmount(tx.tainted, decimals, 4) : '',
      })),
    });
  }
  return relations;
}

export function serialize(session) {
  const decimals = session.asset.decimals;
  const symbol = session.asset.symbol;
  const relations = relationsOf(session.edges, decimals);
  return {
    meta: {
      chainId: session.chainId,
      chainName: session.chainName,
      txHash: session.txHash,
      root: session.root,
      latest: session.latest,
      volumeFactor: session.options.volumeFactor,
      asset: session.asset,
    },
    nodes: Object.values(session.nodes).map((node) => ({
      address: node.address,
      kind: node.kind,
      status: node.status,
      reason: node.reason,
      depth: node.depth,
      delegate: node.delegate,
      returned: node.returned,
      usedLatestCode: node.usedLatestCode,
      inBlock: node.inBlock,
      inTime: node.inTime,
      scanFrom: node.scanFrom,
      scanTo: node.scanTo,
      taintedInDisplay: publicAmount(node.taintedIn, decimals, 4),
      taintedInFull: publicAmount(node.taintedIn, decimals, 8),
      remainingDisplay: publicAmount(node.taintedIn - node.taintedOut, decimals, 4),
      remainingFull: publicAmount(node.taintedIn - node.taintedOut, decimals, 8),
      flowInDisplay: node.scanComplete ? publicAmount(node.flowIn, decimals, 4) : '',
      flowOutDisplay: node.scanComplete ? publicAmount(node.flowOut, decimals, 4) : '',
      symbol,
    })),
    edges: session.edges.map((edge) => {
      const relation = relations.get(`${edge.from}>${edge.to}`);
      return {
        id: edge.id,
        from: edge.from,
        to: edge.to,
        block: edge.block,
        time: edge.time,
        txHash: edge.txHash,
        logIndex: edge.logIndex,
        partial: edge.amount !== edge.txAmount,
        amountDisplay: publicAmount(edge.amount, decimals, 4),
        amountFull: publicAmount(edge.amount, decimals, 8),
        txAmountDisplay: publicAmount(edge.txAmount, decimals, 4),
        relationAmountDisplay: relation.amountDisplay,
        relationCount: relation.count,
        relationLatest: relation.latest,
        relationTruncated: relation.truncated,
        history: relation.history,
        symbol,
      };
    }),
  };
}

function toPublicPreview(info) {
  return {
    chainId: info.chainId,
    chainName: info.chainName,
    latest: info.latest,
    txBlock: info.txBlock,
    txHash: info.txHash,
    transfers: info.transfers.map((transfer) => ({
      from: transfer.from,
      to: transfer.to,
      logIndex: transfer.logIndex,
      txIndex: transfer.txIndex,
      block: transfer.block,
      txHash: transfer.txHash,
      time: transfer.timestamp,
      amount: transfer.amount.toString(),
      amountDisplay: formatUnits(transfer.amount, transfer.asset.decimals, 6),
      asset: transfer.asset,
    })),
  };
}

export async function previewTx(input) {
  const chain = input.chain || 'evm';
  const adapter = createAdapter(chain, input.rpc);
  const info = await adapter.inspectTx(
    assertTxHash(input.txHash, chain),
    input.token ? assertToken(input.token, chain) : null,
    input.requestSignal,
  );
  if (!info.transfers.length) {
    throw new Error(chain === 'solana'
      ? '这笔交易里没有可识别的 SOL 或 SPL 转账。'
      : '这笔交易里没有原生币转账或标准 ERC-20 Transfer。合约内部转账这次不跟踪。');
  }
  return toPublicPreview(info);
}

export async function traceWith({ adapter, seed: match, options, emit, requestSignal, info }) {
  const session = makeSession({
    adapter,
    info: info || { chainId: null, chainName: '', latest: match.block },
    match,
    options: parseOptions(options),
    emit,
  });
  remember(session);
  const release = attachRun(session, requestSignal);
  session.busy = true;
  try {
    session.emit('session', { id: session.id });
    session.emit('graph', serialize(session));
    await attachSourceOuts(session);
    await attachPriors(session);
    session.emit('graph', serialize(session));
    await expandLoop(session);
    session.emit('done', serialize(session));
    return session;
  } catch (error) {
    try {
      session.emit('graph', serialize(session));
    } catch {
      // the client may already be gone
    }
    throw error;
  } finally {
    session.busy = false;
    release();
  }
}

export async function beginTrace(input) {
  const chain = input.chain || 'evm';
  const options = parseOptions(input.options);
  const adapter = createAdapter(chain, input.rpc);
  const txHash = assertTxHash(input.txHash, chain);
  const assetId = input.assetId || 'native';
  const filter = assetId === 'native' ? 'native' : assertToken(assetId, chain);
  input.emit?.('progress', { phase: 'load', message: '正在读取被盗交易' });
  const releaseProbe = input.requestSignal;
  const info = await adapter.inspectTx(txHash, filter, releaseProbe);
  const want = Number(input.logIndex);
  const match = info.transfers.find((transfer) => (
    transfer.logIndex === want
    && addressKey(transfer.asset.id) === (assetId === 'native' ? 'native' : addressKey(assetId))
  ));
  if (!match) throw new Error('在这笔交易里没找到选中的转账，请重新解析');
  if (match.block > info.latest) throw new Error('交易所在区块高于节点高度，请确认 RPC 是否为同一条链');
  match.txAmount = match.amount;
  return traceWith({
    adapter,
    seed: match,
    options,
    emit: input.emit,
    requestSignal: input.requestSignal,
    info,
  });
}

export async function continueOn(session, address) {
  const node = session.nodes[addressKey(address)];
  if (!node) throw new Error('没有这个地址');
  if (node.status === 'source') throw new Error('起点不用继续追查');
  if (!String(node.status).startsWith('paused')) throw new Error('这个地址没有暂停');
  if (session.busy) throw new Error('这个追查还在跑');
  session.busy = true;
  const release = attachRun(session, session.pendingSignal);
  try {
    node.status = 'tracing';
    session.emit('graph', serialize(session));
    await expandNode(session, node.address, { force: true });
    await attachPriors(session);
    session.emit('graph', serialize(session));
    await expandLoop(session);
    session.emit('done', serialize(session));
  } catch (error) {
    try {
      session.emit('graph', serialize(session));
    } catch {
      // ignore a disconnected client
    }
    throw error;
  } finally {
    session.busy = false;
    session.pendingSignal = undefined;
    release();
  }
}

export async function continueTrace(input) {
  const session = sessions.get(input.sessionId);
  if (!session) throw new Error('这次追查已经不在内存里，请重新开始');
  session.emit = input.emit || session.emit;
  session.pendingSignal = input.requestSignal;
  await continueOn(session, addressKey(input.address));
}

function addRelated(session, address, rows, truncated) {
  const depths = Object.values(session.nodes).map((node) => node.depth || 0);
  const node = blank(address);
  node.status = 'added';
  node.kind = 'added';
  node.expanded = true;
  node.depth = depths.length ? Math.max(...depths) + 1 : 0;
  const touched = new Set();
  const seen = new Set(session.edges.map((edge) => `${edge.txHash}:${edge.logIndex}`));
  for (const row of rows) {
    const id = `${row.txHash}:${row.logIndex}`;
    if (!row.txHash || seen.has(id)) continue;
    seen.add(id);
    const from = addressKey(row.from);
    const to = addressKey(row.to);
    touched.add(from === address ? to : from);
    session.edges.push({
      id: 'e' + (++session.edgeSeq),
      from,
      to,
      amount: row.amount,
      txAmount: row.amount,
      block: row.block,
      txIndex: row.txIndex ?? 0,
      logIndex: row.logIndex ?? 0,
      txHash: row.txHash,
      time: row.timestamp ?? row.time ?? null,
      related: true,
      priorTruncated: truncated,
      earlier: [],
    });
  }
  node.reason = touched.size
    ? `和图上 ${touched.size} 个地址有同币转账${truncated ? '，更早的可能没列全' : ''}。`
    : '和图上现有地址没有查到同币转账。';
  session.nodes[address] = node;
}

export async function addAddress(input) {
  const session = input.sessionId ? sessions.get(input.sessionId) : null;
  if (input.sessionId && !session) throw new Error('这次追查已经不在内存里，请重新开始');
  if (session?.busy) throw new Error('这个追查还在跑');
  const chain = session ? (session.adapter.id === 'solana' ? 'solana' : 'evm') : (input.chain || 'evm');
  const address = assertAddress(input.address, chain);
  const peers = session
    ? Object.keys(session.nodes)
    : [...new Set((input.peers || []).map((item) => addressKey(item)))];
  if (peers.includes(address)) throw new Error('图上已经有这个地址');
  const adapter = session?.adapter || createAdapter(chain, input.rpc);
  if (typeof adapter.links !== 'function') throw new Error('这条链还不能补地址');
  const asset = session?.asset || input.asset;
  if (!asset?.id) throw new Error('还不知道要查哪种代币');
  const toBlock = session?.latest ?? await adapter.tip();
  const found = await adapter.links({
    address,
    peers,
    asset,
    toBlock,
    chainId: session?.chainId ?? input.chainId ?? null,
  });
  const rows = dedupeRows(found?.rows).filter((row) => {
    const from = addressKey(row.from);
    const to = addressKey(row.to);
    const other = from === address ? to : from;
    return (from === address || to === address) && peers.includes(other);
  });
  if (session) {
    addRelated(session, address, rows, Boolean(found?.truncated));
    return serialize(session);
  }
  const holder = {
    asset,
    options: { volumeFactor: 5 },
    chainId: input.chainId ?? null,
    chainName: chain === 'solana' ? 'Solana' : '',
    txHash: '',
    root: address,
    latest: toBlock,
    nodes: {},
    edges: [],
    edgeSeq: 0,
  };
  for (const peer of peers) {
    const node = blank(peer);
    node.depth = 0;
    holder.nodes[peer] = node;
  }
  addRelated(holder, address, rows, Boolean(found?.truncated));
  const graph = serialize(holder);
  return {
    node: graph.nodes.find((item) => item.address === address),
    edges: graph.edges,
  };
}

export function removeNode(sessionId, address) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error('这次追查已经不在内存里，请重新开始');
  if (session.busy) throw new Error('这个追查还在跑');
  const key = addressKey(address);
  if (!session.nodes[key]) throw new Error('图上没有这个地址');
  delete session.nodes[key];
  session.edges = session.edges.filter((edge) => edge.from !== key && edge.to !== key);
  session.queue = session.queue.filter((item) => item !== key);
  session.queued.delete(key);
  if (session.root === key) session.root = '';
  return serialize(session);
}

export function cancelSession(id) {
  const session = sessions.get(id);
  if (!session) return false;
  session.stop?.();
  return true;
}
