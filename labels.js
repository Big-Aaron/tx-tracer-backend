const KINDS = {
  protocol: 'protocol',
  protocols: 'protocol',
  cex: 'exchange',
  exchange: 'exchange',
  exchanges: 'exchange',
  name: 'org',
  nametag: 'org',
};

function blank() {
  return { ens: '', protocol: '', org: '', exchange: '' };
}

function add(row, field, name) {
  const text = String(name || '').trim();
  if (!text) return;
  if (field === 'ens' || text.toLowerCase().endsWith('.eth')) {
    if (!row.ens) row.ens = text;
    return;
  }
  const have = row[field] ? row[field].split('、') : [];
  if (have.includes(text) || have.length >= 3) return;
  have.push(text);
  row[field] = have.join('、');
}

function classify(tag) {
  const type = String(tag?.tagType || '').toLowerCase();
  if (KINDS[type]) return KINDS[type];
  const slug = String(tag?.slug || '').toLowerCase();
  if (/cex|exchange/.test(type) || /cex|exchange/.test(slug)) return 'exchange';
  return 'org';
}

export function parseLabels(metadata, extras = {}) {
  const out = {};
  const ensure = (address) => {
    const key = String(address || '').toLowerCase();
    if (!key) return null;
    if (!out[key]) out[key] = blank();
    return out[key];
  };
  for (const [address, info] of Object.entries(metadata?.addresses || {})) {
    const row = ensure(address);
    if (!row) continue;
    for (const tag of info?.tags || []) add(row, classify(tag), tag?.name);
  }
  for (const [address, body] of Object.entries(extras)) {
    const row = ensure(address);
    if (!row || !body) continue;
    if (body.ens_domain_name) add(row, 'ens', body.ens_domain_name);
    for (const tag of body.public_tags || []) add(row, 'org', tag.display_name || tag.label);
    const contractName = String(body.name || '').trim();
    if (contractName) row.name = contractName;
    const creator = String(body.creator_address_hash || '').trim().toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(creator) && creator !== String(address).toLowerCase()) row.creator = creator;
  }
  return out;
}

async function readJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new Error('Blockscout key 无效'), { status: res.status });
  }
  if (!res.ok) {
    const error = new Error(body?.message || `Blockscout HTTP ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return body;
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      out[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function lookupLabels({ key, chainId, addresses }) {
  const token = String(key || '').trim();
  if (!token) throw new Error('先填写 Blockscout key');
  const id = Number(chainId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('这条链没有 Blockscout 标签');
  const list = [...new Set((addresses || []).map((item) => String(item || '').trim().toLowerCase()))]
    .filter((item) => /^0x[0-9a-f]{40}$/.test(item))
    .slice(0, 40);
  if (!list.length) return { labels: {} };
  const auth = `apikey=${encodeURIComponent(token)}`;
  let meta;
  try {
    meta = await readJson(
      `https://api.blockscout.com/services/metadata/api/v1/metadata?addresses=${list.join(',')}&chainId=${id}&tagsLimit=8&${auth}`,
    );
  } catch (error) {
    if (error.status === 404) throw new Error('这条链的 Blockscout 没有标签数据');
    throw error;
  }
  const extras = {};
  const missed = [];
  // ponytail: one 429 used to drop every later address, so the name tag showed and the deployer did not.
  await pool(list, 2, async (address) => {
    const url = `https://api.blockscout.com/${id}/api/v2/addresses/${address}?${auth}`;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        extras[address] = await readJson(url);
        return;
      } catch (error) {
        if (error.status !== 429 || attempt === 3) {
          missed.push(address);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
      }
    }
  });
  return { labels: parseLabels(meta, extras), incomplete: missed.length > 0 };
}
