import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { open, seal } from '../src/crypto.js';

test('seal/open round trip with aad', () => {
  const key = randomBytes(32);
  const sealed = seal(key, 'sk-test-123', 'user1:openai');
  assert.match(sealed, /^v1\./);
  assert.equal(open(key, sealed, 'user1:openai'), 'sk-test-123');
  assert.throws(() => open(key, sealed, 'user2:openai'));
  assert.throws(() => open(randomBytes(32), sealed, 'user1:openai'));
});
