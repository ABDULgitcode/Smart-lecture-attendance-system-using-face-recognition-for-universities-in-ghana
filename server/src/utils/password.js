import bcrypt from 'bcryptjs';
import { HttpError } from './http.js';

export function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

export function verifyPassword(password, passwordHash) {
  return bcrypt.compare(password, passwordHash);
}

export function assertPassword(password) {
  if (!password || String(password).length < 8) {
    throw new HttpError(400, 'Password must be at least 8 characters');
  }
}
