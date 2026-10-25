---
name: tx-tracer
description: Runs the local tx-tracer CLI to follow a stolen or selected transfer forward on EVM or Solana. Use when the user wants to trace funds, preview a transaction, continue a paused address, look up labels, or start the trace API.
---

# tx-tracer

本仓库是追查接口，不是页面。页面在另一个 git 仓库 `tx-tracer-frontend`。不要把 Alchemy key、Blockscout key 写进文件或提交。

## 安装后当命令用

在本仓库：

```bash
npm install -g .
tx-tracer --help
```

只监听本机。默认 `127.0.0.1:8787`。

```bash
tx-tracer serve
tx-tracer serve --port 8787
```

`engine.js`、`evm.js`、`solana.js`、`labels.js` 在进程启动时加载。改这几个文件后要重启 `serve`。

## 命令

```bash
tx-tracer chains
tx-tracer preview --rpc <url> --tx <hash> [--chain evm]
tx-tracer trace --rpc <url> --tx <hash> --log-index <n> --asset <id> [--chain evm] [--depth 4] [--factor 5]
```

`--chain` 现成的是 `evm` 和 `solana`。EVM 的 `--rpc` 用 `https://{主机}.g.alchemy.com/v2/{key}`。Solana 用 `https://solana-mainnet.g.alchemy.com/v2/{key}`。`--asset` 填 `native` 或代币合约地址。`trace` 每行一条 JSON：`progress`、`session`、`graph`、`done`、`error`。

先 `preview`，让用户选定那一笔（`logIndex` 和 `asset.id`），再 `trace`。不要拿客户端传来的金额当真，服务会按交易重新对上这一笔。

## HTTP

前端默认请求 `http://127.0.0.1:8787`。只对 `127.0.0.1` 和 `localhost` 回 CORS。

- `GET /api/chains`
- `POST /api/preview` `{ chain, rpc, txHash }`
- `POST /api/trace` 同上再加 `logIndex`、`assetId`、`options.maxDepth`、`options.volumeFactor`。响应是 SSE。
- `POST /api/continue` `{ sessionId, address }`
- `POST /api/cancel` `{ sessionId }`
- `POST /api/add-node` `{ sessionId, address }` 或导入图所需字段。新地址只补边，不继续追查。
- `POST /api/remove-node` `{ sessionId, address }`
- `POST /api/labels` `{ key, chainId, addresses }`
- `POST /api/safe-owners` `{ rpc, address }`

会话在内存里，最多 8 个，不落盘。

## 追查规则

地址是点，有向边是金额、时间和交易。资金进入合约只暂停那一条链路。EIP-7702 在资金到达当时的代码如果是委托，按普通地址继续。只看被盗转账之后。某地址之后的转出达到转入的倍数（默认 5）就暂停该地址。分叉超过 15 笔先暂停，页面可以继续。

Alchemy 主机走 `alchemy_getAssetTransfers`。没有该接口时，ERC-20 退回整段窗口一次 `eth_getLogs`；原生币在没有转账接口的 Alchemy 主机上直接报错，不要改成逐块扫描。合约判断仍用当时区块的 `eth_getCode`。

标签失败、同向历史失败，都不中断追查。Bitget 跨链只在前端节点明细里给浏览器链接，不要在这里调用 Bitget 的下单接口。
