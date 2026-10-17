import crypto from 'crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { ensureDb } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { User } from '../models.js';
import { createUser, readProfile } from '../services/users.js';
import { issueSession, revokeSession, rotateSession } from '../services/tokens.js';
import { audit } from '../utils/audit.js';
import { hashOtp, safeEqual } from '../utils/crypto.js';
import { HttpError, isEmail, publicUser, requiredText, wrap } from '../utils/http.js';
import { assertPassword, hashPassword, verifyPassword } from '../utils/password.js';

export const authRouter = Router();

authRouter.use(wrap(async (req, res, next) => {
  if (req.path === '/login' || req.path === '/refresh' || req.path === '/register' || req.path === '/forgot' || req.path === '/reset') {
    try {
      await ensureDb();
    } catch {
      throw new HttpError(503, 'Database is unavailable');
    }
  }
  next();
}));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Wait a few minutes and try again.' },
});

authRouter.post('/login', authLimiter, wrap(async (req, res) => {
  const identifier = requiredText(req.body.identifier || req.body.email, 'Email or ID');
  const password = String(req.body.password || '');
  if (!password) throw new HttpError(400, 'Enter your email or ID and password');
  const query = isEmail(identifier)
    ? { email: identifier.toLowerCase() }
    : {
        $or: [
          { email: identifier.toLowerCase() },
          { 'profile.indexNumber': identifier },
          { 'profile.staffId': identifier },
        ],
      };
  const user = await User.findOne(query);
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    throw new HttpError(401, 'Email or password is incorrect');
  }
  if (!user.isActive) throw new HttpError(403, 'Account is not active');
  res.json(await issueSession(user));
}));

authRouter.post('/refresh', wrap(async (req, res) => {
  res.json(await rotateSession(requiredText(req.body.refreshToken, 'Refresh token')));
}));

authRouter.post('/logout', requireAuth, wrap(async (req, res) => {
  const user = await User.findById(req.user.sub);
  if (user) await revokeSession(user, req.body.refreshToken);
  res.status(204).end();
}));

authRouter.get('/me', requireAuth, wrap(async (req, res) => {
  const user = await User.findById(req.user.sub);
  if (!user || !user.isActive) throw new HttpError(401, 'Account is not active');
  res.json({ user: publicUser(user) });
}));

authRouter.post('/register', authLimiter, wrap(async (req, res) => {
  if (!safeEqual(String(req.body.signupKey || ''), config.signupKey)) {
    throw new HttpError(403, 'The signup key is not valid');
  }
  const profile = readProfile(req.body);
  if (!profile.firstName || !profile.lastName) throw new HttpError(400, 'Enter your first and last name');
  if (!profile.indexNumber) throw new HttpError(400, 'Index number is required');
  const user = await createUser({
    role: 'student',
    email: req.body.email,
    password: req.body.password,
    profile,
  });
  await audit(req, { action: 'user.register', entity: 'User', entityId: user._id, after: publicUser(user) });
  res.status(201).json(await issueSession(user));
}));

authRouter.post('/forgot', authLimiter, wrap(async (req, res) => {
  const email = requiredText(req.body.email, 'Email').toLowerCase();
  const user = isEmail(email) ? await User.findOne({ email }) : null;
  const body = {
    message: config.exposeOtp
      ? 'If that account exists, a reset code is ready.'
      : 'Email delivery is not connected on this server. Ask an administrator to reset the password.',
  };
  if (user && config.exposeOtp) {
    const otp = String(crypto.randomInt(100000, 1000000));
    user.resetOtpHash = hashOtp(user.email, otp);
    user.resetOtpExpires = new Date(Date.now() + 10 * 60 * 1000);
    await user.save();
    body.otp = otp;
  }
  res.json(body);
}));

authRouter.post('/reset', authLimiter, wrap(async (req, res) => {
  const email = requiredText(req.body.email, 'Email').toLowerCase();
  const otp = requiredText(req.body.otp, 'Reset code');
  assertPassword(req.body.password);
  const user = await User.findOne({ email });
  const valid = Boolean(
    user?.resetOtpHash
    && user.resetOtpExpires
    && user.resetOtpExpires > new Date()
    && safeEqual(hashOtp(email, otp), user.resetOtpHash),
  );
  if (!valid) throw new HttpError(400, 'That reset code is not valid');
  user.passwordHash = await hashPassword(req.body.password);
  user.resetOtpHash = null;
  user.resetOtpExpires = null;
  user.refreshTokens = [];
  await user.save();
  await audit(req, { action: 'auth.reset', entity: 'User', entityId: user._id });
  res.json({ message: 'Password updated. Sign in with the new password.' });
}));

authRouter.post('/password', requireAuth, wrap(async (req, res) => {
  const user = await User.findById(req.user.sub);
  if (!user || !(await verifyPassword(String(req.body.currentPassword || ''), user.passwordHash))) {
    throw new HttpError(401, 'Current password is incorrect');
  }
  assertPassword(req.body.newPassword);
  user.passwordHash = await hashPassword(req.body.newPassword);
  user.refreshTokens = [];
  await user.save();
  await audit(req, { action: 'auth.password', entity: 'User', entityId: user._id });
  res.json(await issueSession(user));
}));
