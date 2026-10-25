import assert from 'node:assert/strict';
import test from 'node:test';
import { addAddress, continueOn, removeNode, serialize, traceWith } from './engine.js';
import { alchemyTransfer, isAlchemyUrl } from './evm.js';
import { classifyCode } from './logic.js';
import {
  formatUnits,
  isAfter,
  shouldPauseVolume,
  takeAttributed,
} from './logic.js';

const addr = (n) => '0x' + String(n).padStart(40, '0');
const hash = (n) => '0x' + String(n).padStart(64, 'a');

function xfer(fields) {
  return {
    from: fields.from,
    to: fields.to,
    amount: fields.amount,
    block: fields.block,
    txIndex: fields.txIndex ?? 0,
    logIndex: fields.logIndex ?? 0,
    txHash: fields.txHash || hash(fields.block * 100 + (fields.logIndex ?? 0)),
    timestamp: fields.timestamp ?? 1_700_000_000 + fields.block,
  };
}

function harness({ kinds = {}, flows = {} } = {}) {
  const scanned = [];
  const classified = [];
  const adapter = {
    async tip() {
      return 100000;
    },
    async classify(address, block) {
      classified.push({ address, block });
      const kind = kinds[address] || 'eoa';
      return {
        kind,
        delegate: kind === 'delegated' ? addr(99) : null,
      };
    },
    async scan({ address, onChunk }) {
      scanned.push(address);
      await onChunk(flows[address] || { ins: [], outs: [] });
    },
    async hydrateTimes(transfers) {
      for (const transfer of transfers) {
        if (transfer.timestamp == null) transfer.timestamp = 1_700_000_000 + transfer.block;
      }
    },
  };
  return { adapter, scanned, classified };
}

function seed(from, to, amount, extra = {}) {
  return {
    from,
    to,
    amount,
    txAmount: extra.txAmount ?? amount,
    block: extra.block ?? 100,
    txIndex: extra.txIndex ?? 1,
    logIndex: extra.logIndex ?? 2,
    txHash: extra.txHash || hash(1),
    timestamp: extra.timestamp ?? 1_700_000_100,
    asset: extra.asset || { type: 'erc20', id: addr(8), symbol: 'USDT', decimals: 0 },
  };
}

const options = { maxDepth: 5, volumeFactor: 5 };

test('classifies empty code, exact 7702 delegation, and other bytecode', () => {
  assert.equal(classifyCode('0x').kind, 'eoa');
  assert.equal(classifyCode('0x0').kind, 'eoa');
  const delegate = 'ab'.repeat(20);
  const delegated = classifyCode('0xef0100' + delegate);
  assert.equal(delegated.kind, 'delegated');
  assert.equal(delegated.delegate, '0x' + delegate);
  assert.equal(classifyCode('0xEF0100' + delegate).kind, 'delegated');
  assert.equal(classifyCode('0xef0100' + delegate + '00').kind, 'contract');
  assert.equal(classifyCode('0x60806040').kind, 'contract');
});

test('formats token amounts without hiding dust', () => {
  assert.equal(formatUnits(0n, 6), '0');
  assert.equal(formatUnits(1_000_000n, 6), '1');
  assert.equal(formatUnits(1_500_000n, 6), '1.5');
  assert.equal(formatUnits(1_234_567n, 6, 4), '1.2345');
  assert.equal(formatUnits(1n, 6), '0.000001');
  assert.equal(formatUnits(1_000n, 0), '1,000');
});

test('alchemy log index orders a block without a tx index', () => {
  const cursor = { block: 100, txIndex: 5, logIndex: 2 };
  assert.equal(isAfter({ block: 100, txIndex: 0, logIndex: 3 }, cursor), true);
  assert.equal(isAfter({ block: 100, txIndex: 0, logIndex: 1 }, cursor), false);
  const row = alchemyTransfer({
    from: '0x' + 'ab'.repeat(20),
    to: '0x' + 'cd'.repeat(20),
    hash: '0x' + '11'.repeat(32),
    uniqueId: '0x' + '11'.repeat(32) + ':log:350',
    blockNum: '0x190a369',
    rawContract: { value: '0x41d390', address: '0x' + 'd'.repeat(40), decimal: '0x6' },
    metadata: { blockTimestamp: '2026-10-23T15:30:23.000Z' },
  });
  assert.equal(row.amount, 4314000n);
  assert.equal(row.logIndex, 350);
  assert.equal(row.block, 26256233);
  assert.equal(row.timestamp, 1792769423);
  assert.equal(isAlchemyUrl('https://eth-mainnet.g.alchemy.com/v2/key'), true);
  assert.equal(isAlchemyUrl('https://ethereum-rpc.publicnode.com'), false);
});

test('volume pause is a closed threshold and fifo is a prefix', () => {
  assert.equal(shouldPauseVolume(1000n, 4999n, 5), false);
  assert.equal(shouldPauseVolume(1000n, 5000n, 5), true);
  assert.equal(shouldPauseVolume(0n, 5000n, 5), false);
  assert.equal(shouldPauseVolume(1000n, 0n, 5), false);
  const outs = [
    xfer({ from: addr(2), to: addr(3), amount: 300n, block: 1, logIndex: 1 }),
    xfer({ from: addr(2), to: addr(4), amount: 800n, block: 1, logIndex: 2 }),
    xfer({ from: addr(2), to: addr(5), amount: 100n, block: 1, logIndex: 3 }),
  ];
  const first = takeAttributed(outs, 1000n, 0n);
  assert.equal(first.length, 2);
  assert.equal(first[1].amount, 700n);
  assert.equal(first[1].txAmount, 800n);
  const next = takeAttributed(outs, 100n, 1000n);
  assert.equal(next.length, 1);
  assert.equal(next[0].to, addr(4));
  assert.equal(next[0].amount, 100n);
  assert.equal(isAfter(outs[0], { block: 1, txIndex: 0, logIndex: 1 }), false);
  assert.equal(isAfter(outs[1], { block: 1, txIndex: 0, logIndex: 1 }), true);
});

test('a contract pauses only its path; other branches stay breadth-first', async () => {
  const from = addr(1);
  const contract = addr(2);
  const left = addr(3);
  const right = addr(4);
  const leftChild = addr(5);
  const rightChild = addr(6);
  const { adapter, scanned } = harness({
    kinds: { [contract]: 'contract' },
    flows: {
      [from]: {
        ins: [],
        outs: [
          xfer({ from, to: left, amount: 4n, block: 110, logIndex: 1 }),
          xfer({ from, to: right, amount: 5n, block: 111, logIndex: 1 }),
        ],
      },
      [left]: { ins: [], outs: [xfer({ from: left, to: leftChild, amount: 4n, block: 120, logIndex: 1 })] },
      [right]: { ins: [], outs: [xfer({ from: right, to: rightChild, amount: 5n, block: 121, logIndex: 1 })] },
      [leftChild]: { ins: [], outs: [] },
      [rightChild]: { ins: [], outs: [] },
    },
  });
  const session = await traceWith({
    adapter,
    seed: seed(from, contract, 1000n),
    options,
  });
  assert.equal(session.nodes[contract].status, 'paused_contract');
  assert.equal(session.nodes[contract].reason, '资金进入合约，这条链路已暂停。');
  assert.equal(session.nodes[left].status, 'forwarded');
  assert.equal(session.nodes[right].status, 'forwarded');
  assert.equal(session.nodes[leftChild].status, 'holding');
  assert.equal(session.nodes[rightChild].status, 'holding');
  assert.ok(!scanned.includes(contract));
  assert.deepEqual(scanned, [from, left, right, leftChild, rightChild]);
});

test('scans each address from its transfer through the chain tip', async () => {
  const from = addr(1);
  const to = addr(2);
  const ranges = [];
  const { adapter } = harness({
    flows: { [to]: { ins: [], outs: [] } },
  });
  const scan = adapter.scan;
  adapter.scan = async (args) => {
    ranges.push({ address: args.address, fromBlock: args.fromBlock, toBlock: args.toBlock });
    return scan(args);
  };
  await traceWith({ adapter, seed: seed(from, to, 1000n), options });
  assert.deepEqual(ranges.map((item) => [item.address, item.fromBlock, item.toBlock]), [
    [from, 100, 100000],
    [to, 100, 100000],
  ]);
});

test('shows earlier same-direction transfers on the pair, not later ones', async () => {
  const from = addr(1);
  const to = addr(2);
  const seedHash = hash(1);
  const laterHash = hash(2);
  const priorHash = hash(9);
  const adapter = harness({
    flows: {
      [from]: {
        ins: [],
        outs: [xfer({ from, to, amount: 7n, block: 110, logIndex: 1, txHash: laterHash })],
      },
      [to]: { ins: [], outs: [] },
    },
  }).adapter;
  adapter.priorBetween = async () => ({
    rows: [
      xfer({ from, to, amount: 50n, block: 40, logIndex: 1, txHash: priorHash }),
      xfer({ from, to, amount: 1000n, block: 100, txIndex: 1, logIndex: 2, txHash: seedHash }),
      xfer({ from, to, amount: 7n, block: 110, logIndex: 1, txHash: laterHash }),
      xfer({ from, to, amount: 9n, block: 180, logIndex: 1, txHash: hash(8) }),
    ],
    truncated: false,
  });
  const session = await traceWith({
    adapter,
    seed: seed(from, to, 1000n, { txHash: seedHash }),
    options,
  });
  assert.equal(session.edges[0].earlier.length, 1);
  assert.equal(session.edges[0].earlier[0].txHash, priorHash);
  const later = session.edges.find((edge) => edge.txHash === laterHash);
  assert.equal(later.earlier.length, 2);
  const pub = serialize(session);
  assert.equal(pub.edges[0].relationCount, 3);
  assert.equal(pub.edges[0].relationAmountDisplay, '1,057');
  assert.equal(pub.edges[0].relationLatest, 1_700_000_000 + 110);
  assert.equal(pub.edges[0].history.filter((item) => !item.traced).map((item) => item.txHash).join(','), priorHash);
});

test('a prior lookup failure still finishes the trace', async () => {
  const from = addr(1);
  const to = addr(2);
  const adapter = harness().adapter;
  adapter.priorBetween = async () => {
    throw new Error('nope');
  };
  const session = await traceWith({ adapter, seed: seed(from, to, 1000n), options });
  assert.equal(session.edges[0].earlier.length, 0);
  assert.equal(serialize(session).edges[0].relationCount, 1);
});

test('stops at a contract and does not scan it', async () => {
  const from = addr(1);
  const to = addr(2);
  const { adapter, scanned } = harness({ kinds: { [to]: 'contract' } });
  const session = await traceWith({ adapter, seed: seed(from, to, 1000n), options });
  assert.equal(session.nodes[to].status, 'paused_contract');
  assert.equal(session.nodes[to].kind, 'contract');
  assert.deepEqual(scanned, [from]);
  assert.equal(session.edges.length, 1);
  JSON.stringify(serialize(session));
});

test('treats a 7702 delegation as an EOA and keeps following', async () => {
  const from = addr(1);
  const to = addr(2);
  const next = addr(3);
  const { adapter, classified } = harness({
    kinds: { [to]: 'delegated' },
    flows: {
      [to]: { ins: [], outs: [xfer({ from: to, to: next, amount: 1000n, block: 110, logIndex: 1 })] },
    },
  });
  const session = await traceWith({ adapter, seed: seed(from, to, 1000n), options });
  assert.equal(session.nodes[to].kind, 'delegated');
  assert.equal(session.nodes[to].status, 'forwarded');
  assert.equal(session.nodes[to].delegate, addr(99));
  assert.equal(session.nodes[next].status, 'holding');
  assert.equal(classified[0].block, 100);
  assert.ok(!classified.some((item) => item.address === from));
});

test('pauses when post-theft outflow reaches 5x inflow', async () => {
  const from = addr(1);
  const to = addr(2);
  const { adapter, scanned } = harness({
    flows: {
      [to]: { ins: [], outs: [xfer({ from: to, to: addr(3), amount: 5000n, block: 110, logIndex: 1 })] },
    },
  });
  const sink = addr(3);
  const session = await traceWith({ adapter, seed: seed(from, to, 1000n), options });
  assert.equal(session.nodes[to].status, 'paused_volume');
  assert.equal(session.edges.length, 2);
  assert.equal(session.edges[1].to, sink);
  assert.equal(session.edges[1].amount, 1000n);
  assert.equal(session.edges[1].txAmount, 5000n);
  assert.equal(session.nodes[sink].status, 'pending');
  assert.equal(session.nodes[sink].expanded, false);
  assert.deepEqual(scanned, [from, to]);
});

test('attributes only the tainted prefix when outflow stays under 5x', async () => {
  const from = addr(1);
  const to = addr(2);
  const next = addr(3);
  const session = await traceWith({
    adapter: harness({
      flows: {
        [to]: { ins: [], outs: [xfer({ from: to, to: next, amount: 4999n, block: 110, logIndex: 1 })] },
      },
    }).adapter,
    seed: seed(from, to, 1000n),
    options,
  });
  assert.equal(session.nodes[to].status, 'forwarded');
  assert.equal(session.edges[1].amount, 1000n);
  assert.equal(session.edges[1].txAmount, 4999n);
  assert.equal(session.nodes[next].taintedIn, 1000n);
  assert.equal(session.nodes[next].status, 'holding');
});

test('ignores transfers at or before the theft cursor', async () => {
  const from = addr(1);
  const to = addr(2);
  const earlier = addr(9);
  const later = addr(3);
  const session = await traceWith({
    adapter: harness({
      flows: {
        [to]: {
          ins: [],
          outs: [
            xfer({ from: to, to: earlier, amount: 1000n, block: 100, txIndex: 1, logIndex: 1 }),
            xfer({ from: to, to: later, amount: 1000n, block: 100, txIndex: 1, logIndex: 3 }),
          ],
        },
      },
    }).adapter,
    seed: seed(from, to, 1000n, { block: 100, txIndex: 1, logIndex: 2 }),
    options,
  });
  assert.equal(session.nodes[later].status, 'holding');
  assert.equal(session.nodes[earlier], undefined);
});

test('adds later same-token transfers from the source', async () => {
  const from = addr(1);
  const to = addr(2);
  const later = addr(3);
  const earlier = addr(4);
  const session = await traceWith({
    adapter: harness({
      flows: {
        [from]: {
          ins: [],
          outs: [
            xfer({ from, to: earlier, amount: 50n, block: 90, logIndex: 1 }),
            xfer({ from, to, amount: 1000n, block: 100, txIndex: 1, logIndex: 2 }),
            xfer({ from, to: later, amount: 7n, block: 110, logIndex: 1 }),
          ],
        },
        [to]: { ins: [], outs: [] },
        [later]: { ins: [], outs: [] },
      },
    }).adapter,
    seed: seed(from, to, 1000n),
    options,
  });
  assert.equal(session.nodes[later].status, 'holding');
  assert.equal(session.nodes[later].taintedIn, 7n);
  assert.equal(session.edges.some((edge) => edge.from === from && edge.to === later && edge.amount === 7n), true);
  assert.equal(session.nodes[earlier], undefined);
});

test('pauses a wide split before creating every child', async () => {
  const from = addr(1);
  const to = addr(2);
  const outs = Array.from({ length: 16 }, (_, index) => xfer({
    from: to,
    to: addr(100 + index),
    amount: 1n,
    block: 120,
    txIndex: index,
    logIndex: index,
  }));
  const session = await traceWith({
    adapter: harness({ flows: { [to]: { ins: [], outs } } }).adapter,
    seed: seed(from, to, 16n),
    options,
  });
  assert.equal(session.nodes[to].status, 'paused_volume');
  assert.equal(session.edges.length, 1);
  assert.equal(Object.keys(session.nodes).length, 2);
});

test('manual continue walks out of a paused contract', async () => {
  const from = addr(1);
  const to = addr(2);
  const next = addr(3);
  const { adapter, scanned } = harness({
    kinds: { [to]: 'contract' },
    flows: {
      [to]: { ins: [], outs: [xfer({ from: to, to: next, amount: 1000n, block: 130, logIndex: 1 })] },
    },
  });
  const session = await traceWith({ adapter, seed: seed(from, to, 1000n), options });
  assert.equal(session.nodes[to].status, 'paused_contract');
  assert.deepEqual(scanned, [from]);
  await continueOn(session, to);
  assert.equal(session.nodes[to].status, 'forwarded');
  assert.equal(session.nodes[next].status, 'holding');
  assert.deepEqual(scanned, [from, to, next]);
});

test('stops auto expansion past the hop limit without another code lookup', async () => {
  const from = addr(1);
  const to = addr(2);
  const next = addr(3);
  const { adapter, classified } = harness({
    flows: {
      [to]: { ins: [], outs: [xfer({ from: to, to: next, amount: 1000n, block: 110, logIndex: 1 })] },
    },
  });
  const session = await traceWith({
    adapter,
    seed: seed(from, to, 1000n),
    options: { ...options, maxDepth: 1 },
  });
  assert.equal(session.nodes[to].status, 'forwarded');
  assert.equal(session.nodes[next].status, 'paused_limit');
  assert.deepEqual(classified.map((item) => item.address), [to]);
});

test('an added address only links to nodes already on the graph, and can be deleted', async () => {
  const from = addr(1);
  const to = addr(2);
  const extra = addr(9);
  const outsider = addr(8);
  const { adapter } = harness();
  adapter.links = async ({ address, peers }) => {
    assert.equal(address, extra);
    assert.ok(peers.includes(from));
    assert.equal(peers.includes(extra), false);
    return {
      rows: [
        xfer({ from: extra, to, amount: 4n, block: 90, logIndex: 1, txHash: hash(9) }),
        xfer({ from: extra, to: outsider, amount: 1n, block: 91, logIndex: 1, txHash: hash(8) }),
      ],
      truncated: false,
    };
  };
  const session = await traceWith({ adapter, seed: seed(from, to, 1000n), options });
  const added = await addAddress({ sessionId: session.id, address: extra.toUpperCase(), chain: 'evm' });
  const node = added.nodes.find((item) => item.address === extra);
  assert.equal(node.status, 'added');
  assert.match(node.reason, /1 个地址/);
  const link = added.edges.find((edge) => edge.from === extra);
  assert.equal(link.to, to);
  assert.equal(link.history[0].related, true);
  assert.equal(link.history[0].traced, false);
  assert.equal(added.edges.some((edge) => edge.to === outsider), false);
  assert.equal(session.queue.length, 0);
  const removed = removeNode(session.id, extra);
  assert.equal(removed.nodes.some((item) => item.address === extra), false);
  assert.equal(removed.edges.some((edge) => edge.from === extra || edge.to === extra), false);
  assert.equal(removed.nodes.length, 2);
});
