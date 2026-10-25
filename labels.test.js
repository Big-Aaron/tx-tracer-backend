import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeOwners } from './evm.js';
import { lookupLabels, parseLabels } from './labels.js';

test('getOwners return data decodes to addresses', () => {
  const word = (value) => value.replace(/^0x/, '').padStart(64, '0');
  const data = `0x${word('20')}${word('2')}${word('1111111111111111111111111111111111111111')}${word('AbCDEFabcdefABCDEFabcdefABCDEFabcdefABCD')}`;
  assert.deepEqual(decodeOwners(data), [
    '0x1111111111111111111111111111111111111111',
    '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
  ]);
  assert.deepEqual(decodeOwners('0x'), []);
});

test('tags split into protocol, institution, exchange, and ens', () => {
  const labels = parseLabels({
    addresses: {
      '0xAbC': {
        tags: [
          { tagType: 'name', name: 'Coinbase 10' },
          { tagType: 'protocol', name: 'Coinbase' },
          { tagType: 'cex', name: 'Coinbase' },
          { tagType: 'name', name: 'someone.eth' },
        ],
      },
    },
  }, {
    '0xabc': {
      ens_domain_name: 'someone.eth',
      public_tags: [{ display_name: 'Extra' }],
      creator_address_hash: '0xDEF0000000000000000000000000000000000001',
    },
  });
  assert.equal(labels['0xabc'].org, 'Coinbase 10、Extra');
  assert.equal(labels['0xabc'].protocol, 'Coinbase');
  assert.equal(labels['0xabc'].exchange, 'Coinbase');
  assert.equal(labels['0xabc'].ens, 'someone.eth');
  assert.equal(labels['0xabc'].creator, '0xdef0000000000000000000000000000000000001');
});

test('a 429 on the address lookup is retried and still keeps the deployer', async () => {
  const real = global.fetch;
  const wallet = '0xee7ae85f2fe2239e27d9c1e23fffe168d63b4055';
  let addressCalls = 0;
  const json = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  });
  global.fetch = async (url) => {
    if (String(url).includes('/metadata')) {
      return json({ addresses: { [wallet]: { tags: [{ tagType: 'name', name: 'Binance: Hot Wallet 34' }] } } });
    }
    addressCalls += 1;
    if (addressCalls === 1) return json({ message: 'slow down' }, 429);
    return json({
      name: 'ERC1967Proxy',
      creator_address_hash: '0xf61023061ed45fa9eAC4D2670649cE1FD37ce536',
    });
  };
  try {
    const { labels, incomplete } = await lookupLabels({ key: 'test-key', chainId: 1, addresses: [wallet] });
    assert.equal(incomplete, false);
    assert.equal(addressCalls, 2);
    assert.equal(labels[wallet].org, 'Binance: Hot Wallet 34');
    assert.equal(labels[wallet].name, 'ERC1967Proxy');
    assert.equal(labels[wallet].creator, '0xf61023061ed45fa9eac4d2670649ce1fd37ce536');
  } finally {
    global.fetch = real;
  }
});
