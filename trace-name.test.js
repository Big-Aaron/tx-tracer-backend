import assert from 'node:assert/strict';
import test from 'node:test';
import { traceCsvName } from './csv.js';

test('export file name is address, symbol, hash bytes, and the current time', () => {
  const name = traceCsvName({
    meta: {
      root: '0x1234567890abcdef1234567890abcdef12345678',
      txHash: '0xabcdef0123456789aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      asset: { symbol: 'USDT' },
    },
  }, 1_700_000_100_000);
  assert.equal(name, 'trace-0x1234...5678-USDT-0xabcdef01...-1700000100.csv');
});
