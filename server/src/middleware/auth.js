import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { ensureDb } from '../db.js';
import { Device, User } from '../models.js';
import { sha256 } from '../utils/crypto.js';

const INACTIVITY_MS = () => config.inactivityMinutes * 60 * 1000;

export function signAccess(user) {
  return jwt.sign({ sub: String(user._id), role: user.role }, config.accessSecret, { expiresIn: '15m' });
}

export function signRefresh(user) {
  return jwt.sign({ sub: String(user._id), type: 'refresh' }, config.refreshSecret, { expiresIn: '7d' });
}

export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'Sign in required' });
    const payload = jwt.verify(token, config.accessSecret);
    try {
      await ensureDb();
    } catch {
      return res.status(503).json({ error: 'Database is unavailable' });
    }
    const user = await User.findById(payload.sub).select('isActive lastActiveAt role');
    if (!user || !user.isActive) return res.status(401).json({ error: 'Account is not active' });
    if (user.lastActiveAt && Date.now() - new Date(user.lastActiveAt).getTime() > INACTIVITY_MS()) {
      return res.status(401).json({ error: 'Signed out after inactivity' });
    }
    if (!user.lastActiveAt || Date.now() - new Date(user.lastActiveAt).getTime() > 60_000) {
      await User.updateOne({ _id: user._id }, { $set: { lastActiveAt: new Date() } });
    }
    req.user = { sub: String(user._id), role: user.role };
    return next();
  } catch {
    return res.status(401).json({ error: 'Session expired' });
  }
}

export function requireRoles(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({ error: 'You do not have access to this' });
    }
    return next();
  };
}

async function attachDevice(req, res, next) {
  try {
    const deviceKey = req.headers['x-device-key'];
    if (!deviceKey) return res.status(401).json({ error: 'Sign in required' });
    try {
      await ensureDb();
    } catch {
      return res.status(503).json({ error: 'Database is unavailable' });
    }
    const device = await Device.findOne({ apiKeyHash: sha256(String(deviceKey)) });
    if (!device) return res.status(401).json({ error: 'Unknown device' });
    device.lastSeenAt = new Date();
    await device.save();
    req.device = device;
    return next();
  } catch (error) {
    return next(error);
  }
}

function requireStaffBearer(req, res, next, roles, denied) {
  return requireAuth(req, res, () => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: denied });
    return next();
  });
}

export async function requireRosterAccess(req, res, next) {
  if ((req.headers.authorization || '').startsWith('Bearer ')) {
    return requireStaffBearer(req, res, next, ['lecturer', 'admin'], 'You do not have access to face templates');
  }
  return attachDevice(req, res, next);
}

export async function requireSessionWriter(req, res, next) {
  if ((req.headers.authorization || '').startsWith('Bearer ')) {
    return requireStaffBearer(req, res, next, ['lecturer', 'admin'], 'You do not have access to this');
  }
  return attachDevice(req, res, next);
}
