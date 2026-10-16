import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { app } from '../src/app.js';

let server;
let base;

test.before(async () => {
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

test('serves the attendance page', async () => {
  const response = await fetch(`${base}/`);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /Lecture attendance/);
});

test('serves university metadata', async () => {
  const response = await fetch(`${base}/api/meta`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(typeof body.universityName, 'string');
  assert.ok(body.universityName.length > 0);
});

test('rejects a session list without a sign-in', async () => {
  const response = await fetch(`${base}/api/sessions`);
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error, 'Sign in required');
});

test('rejects a forged access token', async () => {
  const response = await fetch(`${base}/api/auth/me`, { headers: { Authorization: 'Bearer not-a-token' } });
  assert.equal(response.status, 401);
});
