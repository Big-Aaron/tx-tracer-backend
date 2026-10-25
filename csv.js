// One CSV is the shareable trace. `from` and `to` are required;
// the other columns restore the labels on the graph.

const COLUMNS = [
  'from', 'to', 'amount', 'tx_amount', 'symbol', 'time', 'block', 'tx_hash', 'log_index', 'partial',
  'from_kind', 'from_status', 'from_reason', 'from_depth', 'from_delegate', 'from_tainted', 'from_remaining', 'from_flow_in', 'from_flow_out', 'from_in_block', 'from_in_time', 'from_returned', 'from_scan_from', 'from_scan_to',   'from_ens', 'from_org', 'from_protocol', 'from_exchange', 'from_label',
  'to_kind', 'to_status', 'to_reason', 'to_depth', 'to_delegate', 'to_tainted', 'to_remaining', 'to_flow_in', 'to_flow_out', 'to_in_block', 'to_in_time', 'to_returned', 'to_scan_from', 'to_scan_to', 'to_ens', 'to_org', 'to_protocol', 'to_exchange', 'to_label',
  'chain_id', 'chain_name', 'seed_tx', 'root', 'asset_type', 'asset_id', 'decimals',
  'relation_amount', 'relation_count', 'relation_time', 'history',
];

function csvCell(value) {
  const text = value == null ? '' : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function timeOut(value) {
  if (value == null || value === '') return '';
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return new Date(n * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function timeIn(value) {
  if (value == null || value === '') return null;
  if (/^\d+$/.test(String(value))) return Number(value);
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

function num(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sideCells(node, prefix) {
  const blank = node || {};
  return {
    [`${prefix}_kind`]: blank.kind || '',
    [`${prefix}_status`]: blank.status || '',
    [`${prefix}_reason`]: blank.reason || '',
    [`${prefix}_depth`]: blank.depth ?? '',
    [`${prefix}_delegate`]: blank.delegate || '',
    [`${prefix}_tainted`]: blank.taintedInFull || blank.taintedInDisplay || '',
    [`${prefix}_remaining`]: blank.remainingFull || blank.remainingDisplay || '',
    [`${prefix}_flow_in`]: blank.flowInDisplay || '',
    [`${prefix}_flow_out`]: blank.flowOutDisplay || '',
    [`${prefix}_in_block`]: blank.inBlock ?? '',
    [`${prefix}_in_time`]: timeOut(blank.inTime),
    [`${prefix}_returned`]: blank.returned ? '1' : '',
    [`${prefix}_scan_from`]: blank.scanFrom ?? '',
    [`${prefix}_scan_to`]: blank.scanTo ?? '',
    [`${prefix}_ens`]: blank.ens || '',
    [`${prefix}_org`]: blank.org || '',
    [`${prefix}_protocol`]: blank.protocol || '',
    [`${prefix}_exchange`]: blank.exchange || '',
    [`${prefix}_label`]: blank.label || '',
  };
}

function addressKey(value) {
  const text = String(value ?? '').trim();
  return /^0x/i.test(text) ? text.toLowerCase() : text;
}

function parseAmount(text) {
  const n = Number(String(text ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function formatAmount(n) {
  const neg = n < 0;
  const rounded = Math.round(Math.abs(n) * 1e8) / 1e8;
  const [whole, frac = ''] = String(rounded).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const digits = frac.replace(/0+$/, '');
  return (neg ? '-' : '') + grouped + (digits ? `.${digits}` : '');
}

// Amount columns follow the edges still between current nodes, not the original scan.
function edgeTotals(address, edges) {
  const key = addressKey(address);
  let flowIn = 0;
  let flowOut = 0;
  let taintedIn = 0;
  let taintedOut = 0;
  for (const edge of edges) {
    const tx = parseAmount(edge.txAmountDisplay || edge.amountFull || edge.amountDisplay);
    const tainted = parseAmount(edge.amountFull || edge.amountDisplay);
    if (addressKey(edge.to) === key) {
      flowIn += tx;
      taintedIn += tainted;
    }
    if (addressKey(edge.from) === key) {
      flowOut += tx;
      taintedOut += tainted;
    }
  }
  return { flowIn, flowOut, taintedIn, taintedOut };
}

export function graphToCsv(graph) {
  const nodes = new Map((graph.nodes || []).map((node) => [addressKey(node.address), node]));
  const edges = (graph.edges || []).filter((edge) => nodes.has(addressKey(edge.from)) && nodes.has(addressKey(edge.to)));
  if (!edges.length) throw new Error('还没有可以导出的流向');
  const meta = graph.meta || {};
  const asset = meta.asset || {};
  const root = nodes.has(addressKey(meta.root)) ? meta.root : '';
  const lines = [COLUMNS.join(',')];
  for (const edge of edges) {
    const from = nodes.get(addressKey(edge.from));
    const to = nodes.get(addressKey(edge.to));
    const fromTotals = edgeTotals(edge.from, edges);
    const toTotals = edgeTotals(edge.to, edges);
    if (from && (from.kind === 'source' || from.status === 'source') && fromTotals.taintedIn === 0) {
      fromTotals.taintedIn = fromTotals.taintedOut;
    }
    if (to && (to.kind === 'source' || to.status === 'source') && toTotals.taintedIn === 0) {
      toTotals.taintedIn = toTotals.taintedOut;
    }
    const row = {
      from: edge.from,
      to: edge.to,
      amount: edge.amountFull || edge.amountDisplay || '',
      tx_amount: edge.txAmountDisplay || edge.amountFull || edge.amountDisplay || '',
      symbol: edge.symbol || asset.symbol || '',
      time: timeOut(edge.time),
      block: edge.block ?? '',
      tx_hash: edge.txHash || '',
      log_index: edge.logIndex ?? '',
      partial: edge.partial ? '1' : '',
      ...sideCells(from, 'from'),
      ...sideCells(to, 'to'),
      from_tainted: formatAmount(fromTotals.taintedIn),
      from_remaining: formatAmount(fromTotals.taintedIn - fromTotals.taintedOut),
      from_flow_in: formatAmount(fromTotals.flowIn),
      from_flow_out: formatAmount(fromTotals.flowOut),
      to_tainted: formatAmount(toTotals.taintedIn),
      to_remaining: formatAmount(toTotals.taintedIn - toTotals.taintedOut),
      to_flow_in: formatAmount(toTotals.flowIn),
      to_flow_out: formatAmount(toTotals.flowOut),
      chain_id: meta.chainId ?? '',
      chain_name: meta.chainName || '',
      seed_tx: meta.txHash || '',
      root,
      asset_type: asset.type || '',
      asset_id: asset.id || '',
      decimals: asset.decimals ?? '',
      relation_amount: edge.relationAmountDisplay || '',
      relation_count: edge.relationCount ?? '',
      relation_time: timeOut(edge.relationLatest),
      history: edge.history?.length ? JSON.stringify(edge.history.map((item) => ({
        tx: item.txHash,
        amount: item.amountDisplay,
        time: item.time,
        block: item.block,
        log: item.logIndex,
        traced: item.traced ? 1 : 0,
        partial: item.partial ? 1 : 0,
        tainted: item.taintedDisplay || '',
      }))) : '',
    };
    lines.push(COLUMNS.map((key) => csvCell(row[key])).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export function parseCsv(text) {
  const src = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((item) => item.some((cell) => cell !== ''));
}

function blankNode(address) {
  return {
    address,
    kind: null,
    status: '',
    reason: '',
    depth: null,
    delegate: null,
    returned: false,
    inBlock: null,
    inTime: null,
    scanFrom: null,
    scanTo: null,
    taintedInDisplay: '',
    taintedInFull: '',
    remainingDisplay: '',
    remainingFull: '',
    flowInDisplay: '',
    flowOutDisplay: '',
    symbol: '',
  };
}

function fillNode(node, fields) {
  const put = (key, value) => {
    if (value == null || value === '') return;
    if (node[key] == null || node[key] === '') node[key] = value;
  };
  put('kind', fields.kind);
  put('status', fields.status);
  put('reason', fields.reason);
  if (node.depth == null && fields.depth != null) node.depth = fields.depth;
  put('delegate', fields.delegate);
  put('taintedInFull', fields.tainted);
  put('taintedInDisplay', fields.tainted);
  put('remainingFull', fields.remaining);
  put('remainingDisplay', fields.remaining);
  put('flowInDisplay', fields.flowIn);
  put('flowOutDisplay', fields.flowOut);
  if (node.inBlock == null && fields.inBlock != null) node.inBlock = fields.inBlock;
  if (node.inTime == null && fields.inTime != null) node.inTime = fields.inTime;
  if (node.scanFrom == null && fields.scanFrom != null) node.scanFrom = fields.scanFrom;
  if (node.scanTo == null && fields.scanTo != null) node.scanTo = fields.scanTo;
  if (fields.returned) node.returned = true;
  put('symbol', fields.symbol);
  put('ens', fields.ens);
  put('org', fields.org);
  put('protocol', fields.protocol);
  put('exchange', fields.exchange);
  put('label', fields.label);
}

function sideFields(cell, row, prefix) {
  const flag = cell(row, `${prefix}_returned`).toLowerCase();
  return {
    kind: cell(row, `${prefix}_kind`),
    status: cell(row, `${prefix}_status`),
    reason: cell(row, `${prefix}_reason`),
    depth: num(cell(row, `${prefix}_depth`)),
    delegate: cell(row, `${prefix}_delegate`),
    tainted: cell(row, `${prefix}_tainted`),
    remaining: cell(row, `${prefix}_remaining`),
    flowIn: cell(row, `${prefix}_flow_in`),
    flowOut: cell(row, `${prefix}_flow_out`),
    inBlock: num(cell(row, `${prefix}_in_block`)),
    inTime: timeIn(cell(row, `${prefix}_in_time`)),
    scanFrom: num(cell(row, `${prefix}_scan_from`)),
    scanTo: num(cell(row, `${prefix}_scan_to`)),
    returned: flag === '1' || flag === 'true' || flag === 'yes',
    symbol: cell(row, 'symbol'),
    ens: cell(row, `${prefix}_ens`),
    org: cell(row, `${prefix}_org`),
    protocol: cell(row, `${prefix}_protocol`),
    exchange: cell(row, `${prefix}_exchange`),
    label: cell(row, `${prefix}_label`),
  };
}

function assignDepth(nodes, edges, rootHint) {
  const by = new Map(nodes.map((node) => [node.address, node]));
  for (const edge of edges) {
    for (const address of [edge.from, edge.to]) {
      if (!by.has(address)) by.set(address, blankNode(address));
    }
  }
  const destinations = new Set(edges.map((edge) => edge.to));
  const root = rootHint && by.has(rootHint)
    ? rootHint
    : (edges.find((edge) => !destinations.has(edge.from))?.from || edges[0].from);
  const rootNode = by.get(root);
  if (rootNode.depth == null) rootNode.depth = 0;
  if (!rootNode.status) {
    rootNode.status = 'source';
    rootNode.kind = rootNode.kind || 'source';
  }
  const nexts = new Map();
  for (const edge of edges) {
    if (!nexts.has(edge.from)) nexts.set(edge.from, []);
    nexts.get(edge.from).push(edge.to);
  }
  const queue = [root];
  const seen = new Set([root]);
  while (queue.length) {
    const current = queue.shift();
    const base = Number(by.get(current).depth ?? 0);
    for (const next of nexts.get(current) || []) {
      const node = by.get(next);
      if (node.depth == null) node.depth = base + 1;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  for (const node of by.values()) {
    if (node.depth == null) node.depth = 0;
    if (!node.status) node.status = 'imported';
  }
  return { nodes: [...by.values()], root };
}

function parseHistory(text) {
  if (!text) return [];
  try {
    const rows = JSON.parse(text);
    if (!Array.isArray(rows)) return [];
    return rows.filter((row) => row && row.tx).map((row) => ({
      txHash: row.tx,
      amountDisplay: row.amount || '',
      time: Number(row.time) || null,
      block: row.block ?? null,
      logIndex: row.log ?? null,
      traced: Boolean(row.traced),
      partial: Boolean(row.partial),
      taintedDisplay: row.tainted || '',
    }));
  } catch {
    return [];
  }
}

export function csvToGraph(text) {
  const table = parseCsv(text);
  if (table.length < 2) throw new Error('CSV 至少要有表头和一行转账');
  const header = table[0].map((item) => item.trim());
  const index = new Map(header.map((item, i) => [item, i]));
  if (!index.has('from') || !index.has('to')) throw new Error('CSV 需要 from 和 to 两列');
  const cell = (row, key) => {
    const at = index.get(key);
    if (at == null) return '';
    return (row[at] ?? '').trim();
  };
  const nodes = new Map();
  const edges = [];
  let meta = null;
  table.slice(1).forEach((row, rowIndex) => {
    const from = addressKey(cell(row, 'from'));
    const to = addressKey(cell(row, 'to'));
    if (!from || !to) return;
    if (!nodes.has(from)) nodes.set(from, blankNode(from));
    if (!nodes.has(to)) nodes.set(to, blankNode(to));
    fillNode(nodes.get(from), sideFields(cell, row, 'from'));
    fillNode(nodes.get(to), sideFields(cell, row, 'to'));
    const amount = cell(row, 'amount');
    const txAmount = cell(row, 'tx_amount') || amount;
    const partialFlag = cell(row, 'partial').toLowerCase();
    const relationCount = num(cell(row, 'relation_count'));
    const history = parseHistory(cell(row, 'history'));
    const relationAmount = cell(row, 'relation_amount');
    edges.push({
      id: `e${rowIndex + 1}`,
      from,
      to,
      amountDisplay: amount,
      amountFull: amount,
      txAmountDisplay: txAmount,
      symbol: cell(row, 'symbol'),
      time: timeIn(cell(row, 'time')),
      block: num(cell(row, 'block')),
      txHash: cell(row, 'tx_hash'),
      logIndex: num(cell(row, 'log_index')),
      partial: partialFlag === '1' || partialFlag === 'true' || (Boolean(txAmount) && Boolean(amount) && txAmount !== amount),
      relationAmountDisplay: relationAmount || undefined,
      relationCount: relationCount == null ? undefined : relationCount,
      relationLatest: timeIn(cell(row, 'relation_time')),
      relationTruncated: false,
      history,
    });
    if (!meta) {
      const symbol = cell(row, 'symbol');
      meta = {
        chainId: num(cell(row, 'chain_id')),
        chainName: cell(row, 'chain_name'),
        txHash: cell(row, 'seed_tx'),
        root: addressKey(cell(row, 'root')),
        imported: true,
        asset: {
          type: cell(row, 'asset_type') || 'imported',
          id: cell(row, 'asset_id') || 'imported',
          symbol,
          decimals: num(cell(row, 'decimals')),
        },
      };
    }
  });
  if (!edges.length) throw new Error('CSV 里没有转账');
  const laid = assignDepth([...nodes.values()], edges, meta.root);
  meta.root = laid.root;
  const symbol = meta.asset.symbol || '';
  for (const node of laid.nodes) if (!node.symbol) node.symbol = symbol;
  for (const edge of edges) if (!edge.symbol) edge.symbol = symbol;
  return { meta, nodes: laid.nodes, edges };
}
