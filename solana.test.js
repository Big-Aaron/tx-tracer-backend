import assert from 'node:assert/strict';
import test from 'node:test';
import { assertToken, assertTxHash } from './engine.js';
import { cmpXfer } from './logic.js';
import { csvToGraph, graphToCsv } from './csv.js';
import { classifyAccount, transfersFromTx } from './solana.js';

const SYSTEM = '11111111111111111111111111111111';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function tx({ keys, instructions, inner, preToken, postToken, preBalances, postBalances, fee = 5000, err = null, transactionIndex = 3 }) {
  return {
    slot: 50,
    blockTime: 1700000100,
    transactionIndex,
    transaction: {
      signatures: ['SigMint111'],
      message: {
        accountKeys: keys.map((pubkey) => ({ pubkey })),
        instructions,
      },
    },
    meta: {
      err,
      fee,
      preBalances,
      postBalances,
      preTokenBalances: preToken || [],
      postTokenBalances: postToken || [],
      innerInstructions: inner || [],
      loadedAddresses: { writable: [], readonly: [] },
    },
  };
}

test('reads an SPL transfer and ignores the fee', () => {
  const rows = transfersFromTx(tx({
    keys: ['Alice', 'Bob', 'AliceAta', 'BobAta'],
    preBalances: [2_000_000, 1_000_000, 2_039_280, 2_039_280],
    postBalances: [1_995_000, 1_000_000, 2_039_280, 2_039_280],
    preToken: [
      { accountIndex: 2, mint: MINT, owner: 'Alice', uiTokenAmount: { amount: '5000000', decimals: 6 } },
      { accountIndex: 3, mint: MINT, owner: 'Bob', uiTokenAmount: { amount: '0', decimals: 6 } },
    ],
    postToken: [
      { accountIndex: 2, mint: MINT, owner: 'Alice', uiTokenAmount: { amount: '4000000', decimals: 6 } },
      { accountIndex: 3, mint: MINT, owner: 'Bob', uiTokenAmount: { amount: '1000000', decimals: 6 } },
    ],
    instructions: [{
      program: 'spl-token',
      programId: TOKEN,
      parsed: {
        type: 'transferChecked',
        info: {
          source: 'AliceAta',
          destination: 'BobAta',
          mint: MINT,
          authority: 'Alice',
          tokenAmount: { amount: '1000000', decimals: 6 },
        },
      },
    }],
  }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].from, 'Alice');
  assert.equal(rows[0].to, 'Bob');
  assert.equal(rows[0].amount, 1000000n);
  assert.equal(rows[0].mint, MINT);
  assert.equal(rows[0].logIndex, 3_000_000);
});

test('reads a transfer that only appears as an inner instruction', () => {
  const rows = transfersFromTx(tx({
    keys: ['Alice', 'Bob', 'AliceAta', 'BobAta'],
    preBalances: [1, 1, 1, 1],
    postBalances: [1, 1, 1, 1],
    preToken: [
      { accountIndex: 2, mint: MINT, owner: 'Alice', uiTokenAmount: { amount: '10', decimals: 6 } },
    ],
    postToken: [
      { accountIndex: 3, mint: MINT, owner: 'Bob', uiTokenAmount: { amount: '10', decimals: 6 } },
    ],
    instructions: [{ programId: 'Jupiter', data: 'route' }],
    inner: [{
      index: 0,
      instructions: [{
        programId: TOKEN,
        parsed: {
          type: 'transfer',
          info: { source: 'AliceAta', destination: 'BobAta', amount: '10', authority: 'Alice' },
        },
      }],
    }],
  }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].from, 'Alice');
  assert.equal(rows[0].to, 'Bob');
  assert.equal(rows[0].amount, 10n);
  assert.equal(rows[0].logIndex, 3_000_001);
});

test('pairs token balance changes when the instruction is not parsed', () => {
  const rows = transfersFromTx(tx({
    keys: ['Alice', 'Bob', 'AliceAta', 'BobAta'],
    preBalances: [1, 1, 1, 1],
    postBalances: [1, 1, 1, 1],
    preToken: [
      { accountIndex: 2, mint: MINT, owner: 'Alice', uiTokenAmount: { amount: '8', decimals: 6 } },
      { accountIndex: 3, mint: MINT, owner: 'Bob', uiTokenAmount: { amount: '1', decimals: 6 } },
    ],
    postToken: [
      { accountIndex: 2, mint: MINT, owner: 'Alice', uiTokenAmount: { amount: '3', decimals: 6 } },
      { accountIndex: 3, mint: MINT, owner: 'Bob', uiTokenAmount: { amount: '6', decimals: 6 } },
    ],
    instructions: [{ programId: 'Opaque' }],
  }));
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].from, rows[0].to, rows[0].amount], ['Alice', 'Bob', 5n]);
});

test('SOL transfer keeps the transferred lamports and drops the fee', () => {
  const rows = transfersFromTx(tx({
    keys: ['Alice', 'Bob'],
    fee: 5000,
    preBalances: [10_000_000, 1_000_000],
    postBalances: [8_995_000, 2_000_000],
    instructions: [{
      program: 'system',
      parsed: { type: 'transfer', info: { source: 'Alice', destination: 'Bob', lamports: 1_000_000 } },
    }],
  }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].mint, 'native');
  assert.equal(rows[0].amount, 1000000n);
  assert.equal(rows[0].from, 'Alice');
  assert.equal(rows[0].to, 'Bob');
});

test('a fee with no transfer is not a SOL movement', () => {
  const rows = transfersFromTx(tx({
    keys: ['Alice'],
    fee: 5000,
    preBalances: [100_000],
    postBalances: [95_000],
    instructions: [],
  }));
  assert.equal(rows.length, 0);
});

test('failed transactions contribute nothing', () => {
  const rows = transfersFromTx(tx({
    keys: ['Alice', 'Bob'],
    err: { InstructionError: [0, 'Custom'] },
    preBalances: [10, 10],
    postBalances: [5, 15],
    instructions: [{
      program: 'system',
      parsed: { type: 'transfer', info: { source: 'Alice', destination: 'Bob', lamports: 5 } },
    }],
  }));
  assert.equal(rows.length, 0);
});

test('slot order follows transaction index, then the instruction', () => {
  const earlier = { block: 50, txIndex: 1, logIndex: 1_000_003 };
  const later = { block: 50, txIndex: 2, logIndex: 2_000_000 };
  assert.equal(cmpXfer(earlier, later), -1);
});

test('a program-owned account pauses and a system wallet does not', () => {
  assert.equal(classifyAccount(null).kind, 'eoa');
  assert.equal(classifyAccount({ owner: SYSTEM, executable: false }).kind, 'eoa');
  assert.equal(classifyAccount({ owner: TOKEN, executable: false }).kind, 'contract');
  assert.equal(classifyAccount({ owner: SYSTEM, executable: true }).kind, 'contract');
});

test('solana signatures and mints keep their case', () => {
  const signature = '5'.repeat(20) + 'a'.repeat(20) + 'Z'.repeat(28);
  assert.equal(assertTxHash(signature, 'solana'), signature);
  assert.equal(assertToken(MINT, 'solana'), MINT);
  assert.throws(() => assertTxHash('0x' + 'ab'.repeat(32), 'solana'));
});

test('csv keeps solana address case', () => {
  const graph = {
    meta: {
      chainId: null,
      chainName: 'Solana',
      txHash: 'SigMint111',
      root: 'AliceWallet',
      asset: { type: 'spl', id: MINT, symbol: 'USDC', decimals: 6 },
    },
    nodes: [
      { address: 'AliceWallet', kind: 'source', status: 'source', depth: 0, taintedInFull: '1', remainingFull: '0', symbol: 'USDC' },
      { address: 'BobWallet', kind: 'eoa', status: 'holding', depth: 1, taintedInFull: '1', remainingFull: '1', symbol: 'USDC' },
    ],
    edges: [{
      from: 'AliceWallet',
      to: 'BobWallet',
      amountFull: '1',
      amountDisplay: '1',
      txAmountDisplay: '1',
      symbol: 'USDC',
      block: 50,
      txHash: 'SigMint111',
      logIndex: 3,
    }],
  };
  const back = csvToGraph(graphToCsv(graph));
  assert.equal(back.meta.root, 'AliceWallet');
  assert.equal(back.edges[0].to, 'BobWallet');
});
