function addressKey(value) {
  const text = String(value ?? '').trim();
  return /^0x/i.test(text) ? text.toLowerCase() : text;
}

function parseCsv(text) {
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

function caption(node) {
  const names = [node.org, node.protocol, node.exchange].filter((item, index, all) => item && all.indexOf(item) === index);
  const label = node.label || names.join(' · ');
  return [node.address, node.ens, label].filter(Boolean).join(' · ');
}

function escapeLabel(text) {
  return text.replace(/\\/g, '\\\\').replace(/"/g, "'");
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

function parseTime(value) {
  if (value == null || value === '') return 0;
  if (/^\d+$/.test(String(value))) return Number(value);
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
}

function fmtUtc8(unix) {
  if (!unix) return '';
  const text = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(unix * 1000));
  return `${text} UTC+8`;
}

function edgeText(rows, cell) {
  const symbol = rows.map((row) => cell(row, 'symbol')).find(Boolean) || '';
  const stated = rows.find((row) => cell(row, 'relation_amount') || cell(row, 'relation_count') || cell(row, 'relation_time'));
  let amount = '';
  let count = String(rows.length);
  let when = '';
  if (stated) {
    amount = cell(stated, 'relation_amount') || cell(stated, 'tx_amount') || cell(stated, 'amount');
    if (cell(stated, 'relation_count')) count = cell(stated, 'relation_count');
    when = fmtUtc8(parseTime(cell(stated, 'relation_time') || cell(stated, 'time')));
  } else {
    amount = formatAmount(rows.reduce((sum, row) => sum + parseAmount(cell(row, 'tx_amount') || cell(row, 'amount')), 0));
    const latest = rows.reduce((max, row) => Math.max(max, parseTime(cell(row, 'time'))), 0);
    when = fmtUtc8(latest);
  }
  const money = amount ? (symbol ? `${amount} ${symbol}` : amount) : '';
  return [money, `${count} 笔`, when].filter(Boolean).join(' · ');
}

function remember(nodes, address, fields) {
  if (!nodes.has(address)) nodes.set(address, { address, ens: '', label: '', org: '', protocol: '', exchange: '' });
  const node = nodes.get(address);
  for (const key of ['ens', 'label', 'org', 'protocol', 'exchange']) {
    if (!node[key] && fields[key]) node[key] = fields[key];
  }
}

export function toMarkdown(text) {
  const table = parseCsv(text);
  if (table.length < 2) throw new Error('CSV 至少要有表头和一行转账');
  const header = table[0].map((item) => item.trim());
  const index = new Map(header.map((item, i) => [item, i]));
  if (!index.has('from') || !index.has('to')) throw new Error('CSV 需要 from 和 to 两列');
  const cell = (row, key) => {
    const at = index.get(key);
    return at == null ? '' : (row[at] ?? '').trim();
  };
  const nodes = new Map();
  const edges = new Map();
  for (const row of table.slice(1)) {
    const from = addressKey(cell(row, 'from'));
    const to = addressKey(cell(row, 'to'));
    if (!from || !to) continue;
    remember(nodes, from, {
      ens: cell(row, 'from_ens'),
      label: cell(row, 'from_label'),
      org: cell(row, 'from_org'),
      protocol: cell(row, 'from_protocol'),
      exchange: cell(row, 'from_exchange'),
    });
    remember(nodes, to, {
      ens: cell(row, 'to_ens'),
      label: cell(row, 'to_label'),
      org: cell(row, 'to_org'),
      protocol: cell(row, 'to_protocol'),
      exchange: cell(row, 'to_exchange'),
    });
    const key = `${from}>${to}`;
    if (!edges.has(key)) edges.set(key, { from, to, rows: [] });
    edges.get(key).rows.push(row);
  }
  if (!edges.size) throw new Error('还没有可以画出的流向');
  const id = new Map([...nodes.keys()].map((address, i) => [address, i]));
  const lines = ['# 资金有向图', '', '```mermaid', 'flowchart LR'];
  for (const [address, i] of id) {
    lines.push(`  n${i}["${escapeLabel(caption(nodes.get(address)))}"]`);
  }
  for (const { from, to, rows } of edges.values()) {
    lines.push(`  n${id.get(from)} -->|"${escapeLabel(edgeText(rows, cell))}"| n${id.get(to)}`);
  }
  lines.push('```', '');
  return lines.join('\n');
}
