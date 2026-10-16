import mongoose from 'mongoose';

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function publicUser(user) {
  return {
    id: user._id,
    role: user.role,
    email: user.email,
    isActive: user.isActive,
    profile: user.profile,
    createdAt: user.createdAt,
  };
}

export function fullName(profile = {}) {
  return `${profile.firstName || ''} ${profile.lastName || ''}`.trim();
}

export function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

export function isId(value) {
  if (typeof value !== 'string' || !mongoose.Types.ObjectId.isValid(value)) return false;
  return String(new mongoose.Types.ObjectId(value)) === value;
}

export function requireId(value, label = 'id') {
  if (!isId(value)) throw new HttpError(400, `Invalid ${label}`);
  return value;
}

export function requiredText(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new HttpError(400, `${label} is required`);
  return text;
}

export function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
