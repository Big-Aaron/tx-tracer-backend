import assert from 'node:assert/strict';
import test from 'node:test';
import { toMarkdown } from './graph.js';

const csv = [
  'from,to,amount,tx_amount,symbol,time,relation_amount,relation_count,relation_time,tx_hash,from_ens,from_label,to_org,to_ens',
  '0xAAA,0xBBB,"400","1,000",USDT,1700000000,"4,700",3,1700000100,0xhash,alice.eth,被盗钱包,Binance,',
  '0xBBB,0xCCC,2,2,USDC,1700000200,,,,0xhash2,,,carol.eth',
  '0xBBB,0xCCC,9,9,USDC,1700000300,,,,0xagain,,,',
].join('\n');

test('markdown graph keeps address, ens, and label, and the pair total on each arrow', () => {
  const markdown = toMarkdown(csv);
  assert.match(markdown, /```mermaid\nflowchart LR/);
  assert.match(markdown, /0xaaa · alice\.eth · 被盗钱包/);
  assert.match(markdown, /0xbbb · Binance/);
  assert.match(markdown, /0xccc · carol\.eth/);
  assert.match(markdown, /n0 -->|"4,700 USDT · 3 笔 · 2023-11-15 06:15:00 UTC\+8"| n1/);
  assert.match(markdown, /n1 -->|"11 USDC · 2 笔 · 2023-11-15 06:18:20 UTC\+8"| n2/);
  assert.equal(markdown.split('-->').length - 1, 2);
  assert.doesNotMatch(markdown, /0xhash|400/);
});
