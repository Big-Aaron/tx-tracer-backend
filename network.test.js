import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveAlchemyHost, supportedChains } from './network.js';

test('network and chain id must name the same chain', () => {
  assert.equal(resolveAlchemyHost({ network: 'eth-mainnet', chainid: '1' }), 'eth-mainnet');
  assert.equal(resolveAlchemyHost({ chainid: '137' }), 'polygon-mainnet');
  assert.equal(resolveAlchemyHost({}), 'eth-mainnet');
  assert.equal(resolveAlchemyHost({ chain: 'solana' }), 'solana-mainnet');
  assert.equal(resolveAlchemyHost({ network: 'arc-mainnet', chainid: '5042' }), 'arc-mainnet');
  assert.throws(
    () => resolveAlchemyHost({ network: 'eth-mainnet', chainid: '137' }),
    /--network eth-mainnet 对应 chain id 1，和 --chainid 137 不一致/,
  );
  assert.throws(() => resolveAlchemyHost({ network: 'bnb-mainnet' }), /bnb-mainnet 没有 Alchemy 转账接口/);
});

test('supported chains list name and chain id', () => {
  const rows = supportedChains();
  assert.deepEqual(rows[0], { name: 'Ethereum', chainId: 1 });
  assert.equal(rows.at(-1).name, 'Solana');
  assert.deepEqual(rows.find((row) => row.name === 'Arc'), { name: 'Arc', chainId: 5042 });
  assert.equal(rows.length, 7);
  assert.ok(rows.every((row) => row.name));
});
