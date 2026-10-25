# tx-tracer-backend

从一笔转账往后查资金的命令。页面在同级目录的 `tx-tracer-frontend`。

有两种用法。一种给页面用，进程一直开着。另一种在命令行里查完就退出。

## 安装

需要 Node.js 18 或更高版本。

```bash
npm install -g tx-tracer-backend
```

在本仓库里安装，用 `npm install -g .`。命令名是 `tx-tracer`。

不写子命令，或写了不认识的子命令，命令只打印用法，退出码是 1。`tx-tracer --help` 打印用法后正常退出。

## 持久化

给页面用。进程一直听着，直到你停掉进程。

```bash
tx-tracer serve
tx-tracer serve --port 8787
```

`npm start` 也是这条命令。进程只监听 `127.0.0.1`。端口默认 `8787`。`--port` 优先于环境变量 `PORT`。

启动时打印 `tx-tracer http://127.0.0.1:<端口>`。页面调用接口时，终端不打出图。

## 一次性

在命令行里查完就退出。这条命令不启动页面用的服务。

```bash
tx-tracer chains
tx-tracer networks
tx-tracer preview --alchemy-key <key> --tx <hash> [--chain evm] [--network eth-mainnet] [--chainid 1]
tx-tracer trace --alchemy-key <key> [--blockscout-key <key>] --tx <hash> --log-index <n> --asset <id> [--chain evm] [--network eth-mainnet] [--chainid 1] [--factor 5] [--depth 4] [--output 文件.csv] [--graph]
tx-tracer graph trace.csv
```

`chains` 打印链家族，格式是 JSON（JavaScript Object Notation，一种文本数据格式）。已接入的是 `evm` 和 `solana`。其余项的 `implemented` 是 `false`。

`networks` 打印当前可以查询的链。第一行表头是 `链` 和 `链号`，两列用制表符对齐。EVM（以太坊虚拟机）只登记有 Alchemy 转账接口的主网，再加 Solana。Solana 没有链号，这一列留空。没登记的 `--network` 会失败退出。能查哪些链，以这次命令的输出为准。

`preview` 读取一笔交易里的原生币和代币转账，把 JSON 打到标准输出。先用这次结果选定 `logIndex` 和 `asset.id`，再跑 `trace`。

`--alchemy-key` 只填 Alchemy 的 key。粘贴的网址里如果有 `/v2/`，程序取出其中的 key。`--network` 是 Alchemy 主机名。EVM 默认 `eth-mainnet`。`--chain solana` 时默认 `solana-mainnet`。

`--chainid` 是链号。这个参数可以单独用，也可以和 `--network` 一起用。两个都写时，链号必须和主机名是同一条链，否则命令失败退出。只写 `--chainid 137` 时，命令使用 `polygon-mainnet`。Solana 用 `--chain solana`。Solana 不使用 `--chainid`。程序拼成 `https://<网络>.g.alchemy.com/v2/<key>`。

`--blockscout-key` 可选。有这把 key 时，CSV（Comma-Separated Values，逗号分隔值）和图上的 EVM 地址会带上 ENS（Ethereum Name Service，以太坊域名）和标签。网址里带 `apikey=` 时，程序取出这个参数。查标签失败时，追查继续。Solana 没有链号，不加这套标签。

`--asset` 填 `native` 或代币地址。不写时按 `native`。`--log-index` 要对上 `preview` 里的那一笔。对不上就失败退出。

倍数阈值用 `--factor`，默认 `5`，范围是 2～100。最大跳数用 `--depth`，默认 `4`，范围是 1～12。程序先去掉小数。小于下限时改成下限，大于上限时改成上限。无法解析成数字时，用默认值。

`trace` 默认只写 CSV。文件名和进度打在标准错误。标准输出留空。加上 `--graph` 后，标准输出才是 Markdown 有向图。中途失败时，只要已经查出流向，命令仍写出已有的 CSV。

文件名形如 `trace-0x1234...5678-USDT-0xabcdef01...-1700000100.csv`。

- EVM 地址是 `0x`、前 4 位、`...` 和后 4 位。Solana 地址取前 4 个字符、`...` 和后 4 个字符。
- 中间是币种名称。
- EVM 哈希是 `0x`、前 4 字节（8 位十六进制）和 `...`。Solana 签名取前 8 个字符和 `...`。
- 最后是当前 Unix 时间戳，单位秒。

要换路径，加上 `--output 文件.csv`。`--out` 是同一个参数。不写时，文件建在当前目录，名字按上面的格式自动生成。

`tx-tracer graph trace.csv` 用已有 CSV 再画一次。图打在标准输出。CSV 至少要有表头和一行数据，并且有 `from`、`to` 两列。

## 暂停

只查你选中的那一笔之后的同一种币。下面的情况停下这一条，其他地址继续。

- 转出不少于转入的 `--factor` 倍。达到倍数时，最多先画出 15 笔，不继续往下查。
- 同一地址要归因的转出超过 15 笔。这时先暂停，这些转出先不画上。
- 地址深度大于 `--depth`，而且追踪资金还没转出。起点深度是 0，被盗收款地址深度是 1。
- 资金进入合约。EIP-7702 委托按普通地址继续。代码必须正好 23 字节，并且以 `ef0100` 加地址开头。
- 读不到资金到达当时的代码。

起点在被盗之后的同币转出会全部画上。自动往下查的只有前 15 笔。页面里对暂停地址点继续，单次最多再展开 40 笔。

暂停原因写在 CSV 的 `from_reason` 和 `to_reason`。图上不画原因。

## 图上有什么

图是 Mermaid 的 `flowchart LR`，标题是“资金有向图”。

节点写地址、ENS 和标签。有自定义标签时用自定义标签。没有自定义标签时，用机构、协议和交易所。

箭头写总额、笔数和最新一笔时间。时间是 `YYYY-MM-DD HH:mm:ss UTC+8`。同一对地址只留一根箭头。

CSV 里有 `relation_amount`、`relation_count`、`relation_time` 时，箭头用这三列。没有这三列时，程序把同一对地址的金额加总。优先加 `tx_amount`，否则加 `amount`。行数当作笔数。时间取最晚的 `time`。

CSV 里的时间是 UTC 的 ISO 8601。画图时再换成 UTC+8。

## 接口

`serve` 给页面用。来源是 `127.0.0.1` 或 `localhost` 时，响应带上 CORS（Cross-Origin Resource Sharing，跨域资源共享）。请求体最大 1,000,000 字节。响应还没开始写就出错时，返回 HTTP 400，正文是 `{ "error": "原因" }`。

- `GET /api/chains`：链家族的 JSON。
- `POST /api/preview`：`{ chain, rpc, txHash }`。可以再带 `token`，只留一种代币。
- `POST /api/trace`：上面的字段再加 `logIndex`、`assetId`、`options.maxDepth`、`options.volumeFactor`。响应是 SSE（Server-Sent Events，服务器推送事件）。
- `POST /api/continue`：`{ sessionId, address }`。响应也是 SSE。
- `POST /api/cancel`：`{ sessionId }`。
- `POST /api/add-node`：内存会话用 `{ sessionId, address }`。没有会话时用 `{ address, chain, rpc, asset, peers, chainId }`，只返回新点和相关边。新地址只补同币转账。追查不从新地址再往下走。
- `POST /api/remove-node`：`{ sessionId, address }`。删掉这个点，以及连着这个点的边。
- `POST /api/labels`：`{ key, chainId, addresses }`。一次最多 40 个 EVM 地址。
- `POST /api/safe-owners`：`{ rpc, address }`。对 `address` 调用 `getOwners()`，返回 `{ owners }`。

`trace` 和 `continue` 的事件有 `session`、`progress`、`graph`、`done`、`error` 和 `cancelled`。浏览器断开后，这次追查停止。会话在内存里，最多 8 个。超过 8 个时，停掉最早的一个。
