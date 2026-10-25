import { chainName } from './evm.js';

// Hosts where Alchemy documents alchemy_getAssetTransfers. Ids match evm.js CHAIN_META.
const NETWORK_CHAIN = {
  'eth-mainnet': 1,
  'opt-mainnet': 10,
  'polygon-mainnet': 137,
  'base-mainnet': 8453,
  'arb-mainnet': 42161,
  'arc-mainnet': 5042,
};

export function resolveAlchemyHost({ chain = 'evm', network, chainid } = {}) {
  if (network === true || chainid === true) throw new Error('参数后面要写值');
  const hasNetwork = network != null && network !== '';
  const hasId = chainid != null && chainid !== '';
  let host = hasNetwork ? String(network).trim() : '';
  let id = null;
  if (hasId) {
    if (!/^\d+$/.test(String(chainid).trim())) throw new Error('--chainid 必须是正整数');
    id = Number(chainid);
    if (!Number.isInteger(id) || id <= 0) throw new Error('--chainid 必须是正整数');
  }
  if (host && !/^[a-z0-9-]+$/.test(host)) throw new Error('网络主机名无效');
  if (chain === 'solana' && id != null) throw new Error('Solana 不用 --chainid，用 --chain solana');

  if (host && id != null) {
    const known = NETWORK_CHAIN[host];
    if (known == null) throw new Error(`没有登记 ${host} 的 chain id，无法和 --chainid ${id} 对照`);
    if (known !== id) throw new Error(`--network ${host} 对应 chain id ${known}，和 --chainid ${id} 不一致`);
  } else if (id != null) {
    const found = Object.entries(NETWORK_CHAIN).filter(([, value]) => value === id).map(([name]) => name);
    if (found.length !== 1) throw new Error(`chain id ${id} 没有对应的 Alchemy 网络`);
    host = found[0];
  } else if (!host) {
    host = chain === 'solana' ? 'solana-mainnet' : 'eth-mainnet';
  }
  if (chain === 'solana') {
    if (host !== 'solana-mainnet') throw new Error('Solana 只用 solana-mainnet');
    return host;
  }
  if (NETWORK_CHAIN[host] == null) throw new Error(`${host} 没有 Alchemy 转账接口`);
  return host;
}

export function supportedChains() {
  const rows = Object.entries(NETWORK_CHAIN).map(([, id]) => ({ name: chainName(id), chainId: id }));
  rows.sort((a, b) => a.chainId - b.chainId);
  rows.push({ name: 'Solana', chainId: '' });
  return rows;
}
