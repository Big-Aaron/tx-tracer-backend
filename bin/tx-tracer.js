#!/usr/bin/env node
import { CHAINS, beginTrace, previewTx } from '../engine.js';
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

function help() {
  console.log(`tx-tracer serve [--port 8787]
tx-tracer chains
tx-tracer preview --rpc <url> --tx <hash> [--chain evm]
tx-tracer trace --rpc <url> --tx <hash> --log-index <n> --asset <id> [--chain evm] [--depth 4] [--factor 5]

serve 只监听 127.0.0.1。页面在另一个仓库。`);
}

const cmd = command && !command.startsWith('--') ? command : 'serve';
const arg = flags(command?.startsWith('--') ? [command, ...rest] : rest);

if (cmd === 'help' || arg.help) {
  help();
} else if (cmd === 'serve') {
  const port = Number(arg.port || process.env.PORT || 8787);
  await startServer(port);
} else if (cmd === 'chains') {
  console.log(JSON.stringify(CHAINS, null, 2));
} else if (cmd === 'preview') {
  const result = await previewTx({ chain: arg.chain || 'evm', rpc: arg.rpc, txHash: arg.tx });
  console.log(JSON.stringify(result, null, 2));
} else if (cmd === 'trace') {
  await beginTrace({
    chain: arg.chain || 'evm',
    rpc: arg.rpc,
    txHash: arg.tx,
    logIndex: arg['log-index'],
    assetId: arg.asset || 'native',
    options: { maxDepth: arg.depth, volumeFactor: arg.factor },
    emit(event, data) {
      process.stdout.write(`${JSON.stringify({ event, data })}\n`);
    },
  });
} else {
  help();
  process.exitCode = 1;
}
