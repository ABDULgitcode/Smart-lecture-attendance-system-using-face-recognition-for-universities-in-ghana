import test from 'node:test';
import assert from 'node:assert/strict';
import { codeForWindow, currentWindow, matchesCode } from '../src/services/codes.js';

test('accepts the current rotating code and the previous one', () => {
  const date = new Date('2026-10-16T00:00:30.000Z');
  const sessionId = '507f1f77bcf86cd799439011';
  const current = codeForWindow(sessionId, currentWindow(date));
  const previous = codeForWindow(sessionId, currentWindow(date) - 1);
  const older = codeForWindow(sessionId, currentWindow(date) - 2);
  assert.equal(matchesCode(sessionId, current.toLowerCase(), date), true);
  assert.equal(matchesCode(sessionId, previous, date), true);
  assert.equal(matchesCode(sessionId, older, date), false);
  assert.equal(current, codeForWindow(sessionId, currentWindow(date)));
});
