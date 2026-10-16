import { User } from '../models.js';
import { HttpError, isEmail, isId } from '../utils/http.js';
import { assertPassword, hashPassword } from '../utils/password.js';

export function readProfile(body = {}) {
  let level;
  if (body.level !== undefined && body.level !== '' && body.level !== null) {
    level = Number(body.level);
    if (!Number.isFinite(level)) throw new HttpError(400, 'Level must be a number');
  }
  const profile = {
    firstName: String(body.firstName || '').trim(),
    lastName: String(body.lastName || '').trim(),
    phone: String(body.phone || '').trim(),
    programme: String(body.programme || '').trim(),
    level,
  };
  const indexNumber = String(body.indexNumber || '').trim();
  const staffId = String(body.staffId || '').trim();
  if (indexNumber) profile.indexNumber = indexNumber;
  if (staffId) profile.staffId = staffId;
  if (body.departmentId) {
    if (!isId(String(body.departmentId))) throw new HttpError(400, 'Invalid department');
    profile.departmentId = body.departmentId;
  }
  return profile;
}

export async function createUser({ role, email, password, profile }) {
  assertPassword(password);
  if (!isEmail(email)) throw new HttpError(400, 'Enter a valid email');
  if (!['student', 'lecturer', 'hod', 'admin'].includes(role)) throw new HttpError(400, 'Unknown role');
  const passwordHash = await hashPassword(password);
  return User.create({
    role,
    email: email.toLowerCase().trim(),
    passwordHash,
    profile,
    isActive: true,
  });
}
