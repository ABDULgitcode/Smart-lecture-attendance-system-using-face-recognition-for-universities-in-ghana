import crypto from 'crypto';
import { config } from '../config.js';

export const WINDOW_SECONDS = 30;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function currentWindow(date = new Date()) {
  return Math.floor(date.getTime() / 1000 / WINDOW_SECONDS);
}

export function codeForWindow(sessionId, window) {
  const digest = crypto.createHmac('sha256', config.accessSecret).update(`${String(sessionId)}:${window}`).digest();
  let out = '';
  for (let i = 0; i < 6; i += 1) out += ALPHABET[digest[i] % ALPHABET.length];
  return out;
}

export function currentCode(sessionId, date = new Date()) {
  const window = currentWindow(date);
  const elapsed = Math.floor(date.getTime() / 1000) % WINDOW_SECONDS;
  return {
    code: codeForWindow(sessionId, window),
    expiresIn: WINDOW_SECONDS - elapsed,
    windowSeconds: WINDOW_SECONDS,
  };
}

export function matchesCode(sessionId, given, date = new Date()) {
  const normalized = String(given || '').trim().toUpperCase();
  if (!/^[A-Z2-9]{6}$/.test(normalized)) return false;
  const window = currentWindow(date);
  return normalized === codeForWindow(sessionId, window) || normalized === codeForWindow(sessionId, window - 1);
}
