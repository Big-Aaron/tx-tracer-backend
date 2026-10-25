#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { graphToCsv, traceCsvName } from '../csv.js';
import { CHAINS, beginTrace, previewTx } from '../engine.js';
import { toMarkdown } from '../graph.js';
import { lookupLabels } from '../labels.js';
import { resolveAlchemyHost, supportedChains } from '../network.js';
import { startServer } from '../server.js';

const [command, ...rest] = process.argv.slice(2);

function flags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function alchemyRpc(arg) {
  let raw = String(arg['alchemy-key'] || '').trim();
  const embedded = raw.match(/\/v2\/([^/?#\s]+)/);
  if (embedded) raw = decodeURIComponent(embedded[1]);
  if (!/^[A-Za-z0-9_-]{8,}$/.test(raw)) throw new Error('这里只填 Alchemy 的 key，不要填整段网址');
  const host = resolveAlchemyHost({ chain: arg.chain || 'evm', network: arg.network, chainid: arg.chainid });
  return `https://${host}.g.alchemy.com/v2/${raw}`;
}

function blockscoutKey(arg) {
  let raw = String(arg['blockscout-key'] || '').trim();
  const embedded = raw.match(/[?&]apikey=([^&#\s]+)/i);
  if (embedded) raw = decodeURIComponent(embedded[1]);
  return raw;
}

async function attachLabels(graph, key) {
  const id = Number(graph.meta?.chainId);
  if (!key || !Number.isInteger(id) || id <= 0) return;
  const labels = {};
  const addresses = graph.nodes.map((node) => node.address);
  for (let i = 0; i < addresses.length; i += 40) {
    const part = await lookupLabels({ key, chainId: id, addresses: addresses.slice(i, i + 40) });
    Object.assign(labels, part.labels);
  }
  for (const node of graph.nodes) {
    const tag = labels[String(node.address).toLowerCase()];
    if (!tag) continue;
    if (tag.ens) node.ens = tag.ens;
    if (tag.org) node.org = tag.org;
    if (tag.protocol) node.protocol = tag.protocol;
    if (tag.exchange) node.exchange = tag.exchange;
  }
}

function printNetworkTable(rows) {
  const lines = [
    ['链', '链号'],
    ...rows.map((row) => [row.name, row.chainId === '' || row.chainId == null ? '' : String(row.chainId)]),
  ];
  const stop = Math.ceil((Math.max(...lines.map(([name]) => name.length)) + 1) / 8) * 8;
  for (const [name, id] of lines) {
    const tabs = Math.max(1, Math.ceil((stop - name.length) / 8));
    console.log(`${name}${'\t'.repeat(tabs)}${id}`);
  }
}

function help() {
  console.log(`持久化，给页面用。进程一直听 127.0.0.1，直到你停掉它。key 由页面填写。
tx-tracer serve [--port 8787]

一次性，跑完就退出。默认只写 CSV。加上 --graph 才打印有向图。
倍数阈值 --factor，默认 5，可填 2 到 100。最大跳数 --depth，默认 4，可填 1 到 12。
tx-tracer trace --alchemy-key <key> [--blockscout-key <key>] --tx <hash> --log-index <n> --asset <id> [--chain evm] [--network eth-mainnet] [--chainid 1] [--factor 5] [--depth 4] [--output 文件.csv] [--graph]
tx-tracer preview --alchemy-key <key> --tx <hash> [--chain evm] [--network eth-mainnet] [--chainid 1]
tx-tracer chains
tx-tracer networks
tx-tracer graph <trace.csv>`);
}

const cmd = command && !command.startsWith('--') ? command : '';
const arg = flags(command?.startsWith('--') ? [command, ...rest] : rest);

if (!cmd || cmd === 'help' || arg.help) {
  help();
  if (!cmd && !arg.help) process.exitCode = 1;
} else if (cmd === 'serve') {
  const port = Number(arg.port || process.env.PORT || 8787);
  await startServer(port);
} else if (cmd === 'chains') {
  console.log(JSON.stringify(CHAINS, null, 2));
} else if (cmd === 'networks') {
  printNetworkTable(supportedChains());
} else if (cmd === 'preview') {
  try {
    const result = await previewTx({ chain: arg.chain || 'evm', rpc: alchemyRpc(arg), txHash: arg.tx });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
} else if (cmd === 'trace') {
  let graph = null;
  try {
    await beginTrace({
      chain: arg.chain || 'evm',
      rpc: alchemyRpc(arg),
      txHash: arg.tx,
      logIndex: arg['log-index'],
      assetId: arg.asset || 'native',
      options: { maxDepth: arg.depth, volumeFactor: arg.factor },
      emit(event, data) {
        const line = String(data?.message || '').trim();
        if (event === 'progress' && line) process.stderr.write(`${line}\n`);
        if (data?.nodes) graph = data;
        if (event === 'error') process.stderr.write(`${data.message || '追查失败'}\n`);
      },
    });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    if (!graph?.edges?.length) process.exitCode = 1;
  }
  if (graph?.edges?.length) {
    try {
      await attachLabels(graph, blockscoutKey(arg));
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
    }
    const file = path.resolve(arg.output || arg.out || traceCsvName(graph));
    const csv = graphToCsv(graph);
    writeFileSync(file, csv);
    process.stderr.write(`${file}\n`);
    if (arg.graph) process.stdout.write(toMarkdown(csv));
  }
} else if (cmd === 'graph') {
  const file = rest.find((item) => !item.startsWith('--'));
  if (!file) {
    console.error('用法：tx-tracer graph <trace.csv>');
    process.exitCode = 1;
  } else {
    process.stdout.write(toMarkdown(readFileSync(file, 'utf8')));
  }
} else {
  help();
  process.exitCode = 1;
}
