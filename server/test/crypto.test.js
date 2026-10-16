import test from 'node:test';
import assert from 'node:assert/strict';
import { decryptJson, encryptJson } from '../src/utils/crypto.js';

test('encrypts a face embedding so it can be stored', () => {
  const embedding = Array.from({ length: 8 }, (_, index) => Math.round((index - 3) * 0.125 * 1e6) / 1e6);
  const stored = encryptJson(embedding);
  assert.equal(stored.includes(String(embedding[0])), false);
  assert.deepEqual(decryptJson(stored), embedding);
});
