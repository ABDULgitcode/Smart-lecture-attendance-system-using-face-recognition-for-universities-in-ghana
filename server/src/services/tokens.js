import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { signAccess, signRefresh } from '../middleware/auth.js';
import { User } from '../models.js';
import { sha256 } from '../utils/crypto.js';
import { HttpError, publicUser } from '../utils/http.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function inactivityMs() {
  return config.inactivityMinutes * 60 * 1000;
}

function liveTokens(user) {
  const now = new Date();
  return (user.refreshTokens || []).filter((item) => item.expiresAt && item.expiresAt > now);
}

export async function issueSession(user) {
  const accessToken = signAccess(user);
  const refreshToken = signRefresh(user);
  user.refreshTokens = [
    ...liveTokens(user),
    { tokenHash: sha256(refreshToken), expiresAt: new Date(Date.now() + WEEK_MS) },
  ].slice(-5);
  user.lastActiveAt = new Date();
  await user.save();
  return { accessToken, refreshToken, user: publicUser(user) };
}

export async function rotateSession(refreshToken) {
  let payload;
  try {
    payload = jwt.verify(refreshToken, config.refreshSecret);
  } catch {
    throw new HttpError(401, 'Session expired');
  }
  if (payload.type !== 'refresh') throw new HttpError(401, 'Session expired');
  const user = await User.findById(payload.sub);
  if (!user || !user.isActive) throw new HttpError(401, 'Session expired');
  if (user.lastActiveAt && Date.now() - new Date(user.lastActiveAt).getTime() > inactivityMs()) {
    throw new HttpError(401, 'Signed out after inactivity');
  }
  const hash = sha256(refreshToken);
  const known = liveTokens(user).some((item) => item.tokenHash === hash);
  if (!known) throw new HttpError(401, 'Session expired');
  user.refreshTokens = liveTokens(user).filter((item) => item.tokenHash !== hash);
  return issueSession(user);
}

export async function revokeSession(user, refreshToken) {
  if (!refreshToken) return;
  const hash = sha256(String(refreshToken));
  user.refreshTokens = liveTokens(user).filter((item) => item.tokenHash !== hash);
  await user.save();
}
