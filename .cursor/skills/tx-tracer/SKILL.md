---
name: tx-tracer
description: Runs tx-tracer in two modes. serve stays up for the web page. trace, preview, chains, networks, and graph run once in the terminal and exit. Use when the user wants to trace funds, keep the local API running, list chains, or print a fund graph with --graph.
---

# tx-tracer

本仓库的包名是 `tx-tracer-backend`。有两种模式，按用户要做的事选一种。

页面要继续查时，用持久化：`tx-tracer serve`。进程一直听 `127.0.0.1:8787`。页面在 `tx-tracer-frontend`。这次请求只返回接口数据，终端不打出图。

只要一份结果时，用一次性：`tx-tracer trace`。进程写完 CSV（Comma-Separated Values，逗号分隔值）就退出，不启动服务。`--alchemy-key` 必填。`--blockscout-key` 可选，用来给 EVM（以太坊虚拟机）地址加 ENS（Ethereum Name Service，以太坊域名）和标签。`--network` 默认 `eth-mainnet`。`--chain solana` 时默认 `solana-mainnet`。

默认不打印图。用户明确要在终端看图时，才加 `--graph`，或改跑 `tx-tracer graph`。

不要把 Alchemy key、Blockscout key 写进文件或提交。不要另写一套图。

## 安装后当命令用

在本仓库：

```bash
npm install -g .
tx-tracer --help
```

发布到 npm 之后：`npm install -g tx-tracer-backend`。

持久化只监听本机。默认 `127.0.0.1:8787`。`--port` 优先于环境变量 `PORT`。

```bash
tx-tracer serve
tx-tracer serve --port 8787
```

不带子命令，或子命令无法识别时，`tx-tracer` 只打印用法，退出码是 1。`tx-tracer --help` 正常退出。命令不会自己变成服务。

`server.js`、`engine.js`、`logic.js`、`evm.js`、`solana.js` 和 `labels.js` 在 `serve` 启动时加载。改这几个文件后要重启 `serve`。`csv.js`、`graph.js` 和 `network.js` 只给命令行用。

## 命令

```bash
tx-tracer chains
tx-tracer networks
tx-tracer preview --alchemy-key <key> --tx <hash> [--chain evm] [--network eth-mainnet] [--chainid 1]
tx-tracer trace --alchemy-key <key> [--blockscout-key <key>] --tx <hash> --log-index <n> --asset <id> [--chain evm] [--network eth-mainnet] [--chainid 1] [--depth 4] [--factor 5] [--output 文件.csv] [--graph]
tx-tracer graph <trace.csv>
```

`chains` 打印链家族的 JSON（JavaScript Object Notation，一种文本数据格式）。已接入的是 `evm` 和 `solana`。`implemented` 是 `false` 的链还没接入。`networks` 才是 Alchemy 上当前能查的链。

用户问现在能查哪些链时，跑 `tx-tracer networks`。第一行表头是 `链` 和 `链号`，列之间用制表符对齐。EVM 只有有转账接口的主网，再加 Solana。没登记的主机名直接报错。不要改去查别的链。Solana 的链号留空。不要自己另写一份名单。

`--chain` 现成的是 `evm` 和 `solana`。`--alchemy-key` 只填 key。粘贴的网址里如果有 `/v2/`，取出其中的 key。命令会拼成 `https://<network>.g.alchemy.com/v2/<key>`。不要把 key 写进仓库。

`--network` 和 `--chainid` 可以只写一个，也可以两个一起写。两个都写时，先对照登记表。两边不一致时，向用户报错并退出，不要继续追查。只写 `--chainid` 时，用登记表里唯一的主机名。Solana 用 `--chain solana`。Solana 不使用 `--chainid`。

`--asset` 填 `native` 或代币地址。省略时按 `native`。`--log-index` 必须对上 `preview` 里用户选定的那一笔。`--blockscout-key` 可以从带 `apikey=` 的网址里取出。标签按 40 个地址一批去查。失败只写到标准错误，CSV 照样落盘。Solana 没有链号，跳过标签。

倍数阈值是 `--factor`，默认 `5`，范围是 2～100。最大跳数是 `--depth`，默认 `4`，范围是 1～12。程序先去掉小数。小于下限时改成下限，大于上限时改成上限。无法解析成数字时，用默认值。

`trace` 把结果写成 CSV。默认不打印图，标准输出留空。加上 `--graph` 才把 Markdown 有向图打到标准输出。文件名和进度写在标准错误。中途失败时，只要已经查出流向，命令仍写出已有的 CSV。

默认文件名写在当前目录，由 `trace-`、地址缩写、币种、交易缩写和当前 Unix 秒组成。EVM 地址是 `0x`、前 4 位、`...` 和后 4 位。EVM 哈希是 `0x`、前 8 位十六进制和 `...`。Solana 地址取前 4 个字符和后 4 个字符，签名取前 8 个字符。用 `--output` 或 `--out` 指定别的文件路径。

先 `preview`，让用户选定那一笔（`logIndex` 和 `asset.id`），再 `trace`。不要拿客户端传来的金额当真。服务会按交易重新对上这一笔。

已有 CSV 用 `tx-tracer graph <trace.csv>` 再画。页面用“导入 CSV”打开这个文件。CSV 至少要有表头和一行数据，并且有 `from`、`to`。

图是 Mermaid `flowchart LR`，标题是“资金有向图”。同一对地址只留一根箭头。节点只写地址、ENS 和标签。有自定义标签时用自定义标签。没有自定义标签时，用机构、协议和交易所。

箭头写总额、笔数和最新一笔时间，时间是 `YYYY-MM-DD HH:mm:ss UTC+8`。优先用 `relation_amount`、`relation_count`、`relation_time`。没有这三列时，金额优先加 `tx_amount`，否则加 `amount`。CSV 里的时间是 UTC 的 ISO 8601。画图时再换成 UTC+8。

不要在图上补交易哈希或单笔明细。暂停原因在 `from_reason` 和 `to_reason`，不要画进图里。

## HTTP

前端默认请求 `http://127.0.0.1:8787`。来源是 `127.0.0.1` 或 `localhost` 时，响应带上 CORS（Cross-Origin Resource Sharing，跨域资源共享）。请求体最大 1,000,000 字节。响应还没开始写就出错时，返回 HTTP 400 和 `{ "error": "原因" }`。

- `GET /api/chains`
- `POST /api/preview` `{ chain, rpc, txHash }`，可选 `token`
- `POST /api/trace` 同上再加 `logIndex`、`assetId`、`options.maxDepth`、`options.volumeFactor`。响应是 SSE（Server-Sent Events，服务器推送事件）。
- `POST /api/continue` `{ sessionId, address }`。响应也是 SSE。
- `POST /api/cancel` `{ sessionId }`
- `POST /api/add-node` 内存会话用 `{ sessionId, address }`。导入的图没有会话时用 `{ address, chain, rpc, asset, peers, chainId }`，响应是 `{ node, edges }`。新地址只补同币转账。追查不从新地址再往下走。
- `POST /api/remove-node` `{ sessionId, address }`。删掉这个点，以及连着这个点的边。
- `POST /api/labels` `{ key, chainId, addresses }`。一次最多 40 个地址。
- `POST /api/safe-owners` `{ rpc, address }`。对 `address` 调用 `getOwners()`，返回 `{ owners }`。

`trace` 和 `continue` 的事件有 `session`、`progress`、`graph`、`done`、`error` 和 `cancelled`。浏览器断开后，这次追查停止。会话在内存里，最多 8 个，不落盘。超过 8 个时，停掉最早的一个。

## 追查规则

只看你选中的转账之后的同一种币。起点深度是 0，收款地址深度是 1。地址深度大于 `--depth`，而且追踪资金还没转出时，暂停这个地址。

转出不少于转入的倍数就暂停。默认 5 倍，两边金额都要大于 0。达到倍数时，最多先画出 15 笔，不继续往下查。同一地址要归因的转出超过 15 笔时，先暂停，这些转出先不画上。

起点在被盗之后的同币转出会全部画上。自动往下查的只有前 15 笔。页面上继续时，单次最多再展开 40 笔。转回起点的边会留下。起点不会因此再展开。

资金进入合约时，只暂停那一条路径。EIP-7702 委托按普通地址继续。代码必须正好 23 字节，并且以 `ef0100` 加地址开头。只是开头相同、但更长的代码，仍算合约。

历史代码读不到时暂停。用户继续后，改读当前代码。如果又发现更早的一笔汇入，收到这笔汇入的地址会暂停，避免同一段转出算两次。

EVM 只查有 `alchemy_getAssetTransfers` 的主网。链号不在登记表里时直接报错。不要改成 `eth_getLogs`，也不要改成逐块扫描。Solana 用 `getTransactionsForAddress`。Solana 使用自己的交易接口。

原生币的 internal 转账只查链号 1、137、8453 和 5042，也就是以太坊、Polygon、Base 和 Arc。`withMetadata` 不传给 Arc。时间用区块头补。

登记表里的链，如果 RPC（Remote Procedure Call，远程过程调用）来自其他服务，原生币仍会逐块扫到最新区块。标准 RPC 看不到合约内部转出的 ETH。合约判断用资金到达当时区块的 `eth_getCode`。

标签失败或同向历史失败时，追查继续。Bitget 跨链只在前端节点明细里给浏览器链接。不要在这里调用 Bitget 的下单接口。
