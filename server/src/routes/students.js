import crypto from 'crypto';
import { Router } from 'express';
import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { config } from '../config.js';
import { requireAuth, requireRoles } from '../middleware/auth.js';
import { upload, uploadSheet } from '../middleware/error.js';
import { Department, FaceTemplate, User } from '../models.js';
import { assertCanViewStudent } from '../services/access.js';
import { analyzeImage, analyzePair } from '../services/faceClient.js';
import { studentAttendance } from '../services/stats.js';
import { createUser, readProfile } from '../services/users.js';
import { audit } from '../utils/audit.js';
import { encryptJson } from '../utils/crypto.js';
import { HttpError, escapeRegex, isEmail, publicUser, requireId, requiredText, wrap } from '../utils/http.js';
import { assertPassword, hashPassword } from '../utils/password.js';

export const studentRouter = Router();

function ownsStudent(path) {
  return path === '/students'
    || path.startsWith('/students/')
    || path === '/users'
    || path.startsWith('/users/');
}

studentRouter.use((req, res, next) => {
  if (!ownsStudent(req.path)) return next('router');
  return requireAuth(req, res, next);
});

studentRouter.get('/students', requireRoles('admin', 'hod', 'lecturer'), wrap(async (req, res) => {
  const filter = { role: 'student' };
  if (req.user.role === 'hod') {
    const me = await User.findById(req.user.sub).select('profile.departmentId');
    if (!me?.profile?.departmentId) return res.json({ students: [] });
    filter['profile.departmentId'] = me.profile.departmentId;
  } else if (req.query.departmentId) {
    filter['profile.departmentId'] = requireId(String(req.query.departmentId), 'department id');
  }
  if (req.query.q) {
    const pattern = new RegExp(escapeRegex(String(req.query.q).trim()), 'i');
    filter.$or = [
      { email: pattern },
      { 'profile.firstName': pattern },
      { 'profile.lastName': pattern },
      { 'profile.indexNumber': pattern },
    ];
  }
  const students = await User.find(filter)
    .select('-passwordHash -refreshTokens -resetOtpHash')
    .sort({ 'profile.lastName': 1, 'profile.firstName': 1 })
    .limit(50);
  res.json({ students: students.map(publicUser) });
}));

studentRouter.post('/students', requireRoles('admin'), wrap(async (req, res) => {
  const profile = readProfile(req.body);
  if (!profile.firstName || !profile.lastName) throw new HttpError(400, 'Enter the student name');
  if (!profile.indexNumber) throw new HttpError(400, 'Index number is required');
  const user = await createUser({
    role: 'student',
    email: req.body.email,
    password: req.body.password,
    profile,
  });
  await audit(req, { action: 'user.create', entity: 'User', entityId: user._id, after: publicUser(user) });
  res.status(201).json({ student: publicUser(user) });
}));

studentRouter.post('/students/import', requireRoles('admin'), uploadSheet.single('file'), wrap(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Upload a CSV or Excel file');
  let rows;
  try {
    rows = await rowsFromUpload(req.file);
  } catch {
    throw new HttpError(400, 'Could not read that spreadsheet');
  }
  const departments = await Department.find();
  const byCode = new Map(departments.map((item) => [item.code.toUpperCase(), item._id]));
  const created = [];
  const rejected = [];
  for (let index = 0; index < rows.length; index += 1) {
    try {
      const row = rows[index];
      const email = pick(row, ['email']);
      const indexNumber = pick(row, ['index number', 'indexnumber', 'index_number']);
      const firstName = pick(row, ['first name', 'firstname', 'first_name']);
      const lastName = pick(row, ['last name', 'lastname', 'last_name']);
      if (!isEmail(email)) throw new HttpError(400, 'Invalid email');
      if (!indexNumber) throw new HttpError(400, 'Index number is required');
      if (!firstName || !lastName) throw new HttpError(400, 'First and last name are required');
      let password = pick(row, ['password']);
      let temporaryPassword;
      if (!password) {
        if (!config.exposeOtp) throw new HttpError(400, 'Password is required');
        temporaryPassword = `Temp${crypto.randomBytes(4).toString('hex')}1`;
        password = temporaryPassword;
      }
      const departmentCode = pick(row, ['department code', 'departmentcode', 'department']);
      let departmentId;
      if (departmentCode) {
        departmentId = byCode.get(departmentCode.toUpperCase());
        if (!departmentId) throw new HttpError(400, `Unknown department ${departmentCode}`);
      }
      const levelText = pick(row, ['level']);
      const user = await createUser({
        role: 'student',
        email,
        password,
        profile: readProfile({
          firstName,
          lastName,
          indexNumber,
          phone: pick(row, ['phone']),
          programme: pick(row, ['programme', 'program']),
          level: levelText,
          departmentId,
        }),
      });
      created.push({
        id: user._id,
        email: user.email,
        indexNumber,
        ...(temporaryPassword ? { temporaryPassword } : {}),
      });
    } catch (error) {
      rejected.push({
        row: index + 2,
        error: error?.code === 11000 ? 'That student already exists' : error.message,
      });
    }
  }
  await audit(req, {
    action: 'user.import',
    entity: 'User',
    after: { created: created.length, rejected: rejected.length },
  });
  res.json({ created, rejected });
}));

studentRouter.get('/students/:id', wrap(async (req, res) => {
  const student = await User.findById(requireId(req.params.id, 'student id')).select('-passwordHash -refreshTokens -resetOtpHash');
  if (!student || student.role !== 'student') throw new HttpError(404, 'Student not found');
  await assertCanViewStudent(req, student);
  res.json({ student: publicUser(student) });
}));

studentRouter.get('/students/:id/attendance', wrap(async (req, res) => {
  const student = await User.findById(requireId(req.params.id, 'student id'));
  if (!student || student.role !== 'student') throw new HttpError(404, 'Student not found');
  await assertCanViewStudent(req, student);
  res.json(await studentAttendance(student._id));
}));

studentRouter.get('/students/:id/face', wrap(async (req, res) => {
  const studentId = requireId(req.params.id, 'student id');
  const student = await User.findById(studentId);
  if (!student || student.role !== 'student') throw new HttpError(404, 'Student not found');
  if (req.user.role === 'student' && req.user.sub !== studentId) {
    throw new HttpError(403, 'You do not have access to this student');
  }
  if (!['student', 'admin', 'lecturer', 'hod'].includes(req.user.role)) {
    throw new HttpError(403, 'You do not have access to this student');
  }
  if (req.user.role !== 'student') await assertCanViewStudent(req, student);
  const template = await FaceTemplate.findOne({ studentId }).select('modelVersion consent embeddings.quality embeddings.capturedAt');
  res.json({
    enrolled: Boolean(template?.embeddings?.length),
    count: template?.embeddings?.length || 0,
    modelVersion: template?.modelVersion || null,
    consent: template?.consent || null,
  });
}));

studentRouter.post('/students/:id/face', upload.array('images', 10), wrap(async (req, res) => {
  const studentId = requireId(req.params.id, 'student id');
  const student = await User.findById(studentId);
  if (!student || student.role !== 'student') throw new HttpError(404, 'Student not found');
  if (req.user.role !== 'admin' && req.user.sub !== studentId) {
    throw new HttpError(403, 'You can only enroll your own face');
  }
  const consent = req.body.consent === true || req.body.consent === 'true';
  if (!consent) throw new HttpError(400, 'Consent is required before face images can be stored');
  const files = req.files || [];
  if (!files.length) throw new HttpError(400, 'Upload at least one face photo');
  if (req.body.challenge === 'head-turn') {
    if (files.length < 2) throw new HttpError(400, 'Head-turn check needs two photos');
    const pair = await analyzePair(files[0].buffer, files[1].buffer);
    if (!pair.passed) throw new HttpError(400, pair.reason || 'Head-turn check failed');
  }
  const fresh = [];
  const rejected = [];
  let modelVersion = '';
  for (const file of files) {
    let analysis;
    try {
      analysis = await analyzeImage(file.buffer, 'enroll');
    } catch (error) {
      rejected.push({ file: file.originalname, reason: error.message || 'Could not read that photo' });
      continue;
    }
    modelVersion = analysis.modelVersion || modelVersion;
    if (analysis.faces?.length !== 1) {
      rejected.push({
        file: file.originalname,
        reason: analysis.faces?.length ? 'Use a photo with only one face' : 'No face found',
      });
      continue;
    }
    const face = analysis.faces[0];
    if (!face.quality?.ok) {
      rejected.push({ file: file.originalname, reason: face.quality?.issues?.join(' ') || 'Photo quality is too low' });
      continue;
    }
    if (!face.liveness?.passed) {
      rejected.push({ file: file.originalname, reason: 'This looks like a printed photo or a screen' });
      continue;
    }
    if (!Array.isArray(face.embedding) || face.embedding.length !== 512) {
      rejected.push({ file: file.originalname, reason: 'Could not build a face template' });
      continue;
    }
    fresh.push({
      vectorEnc: encryptJson(face.embedding),
      quality: face.liveness?.score ?? 1,
      capturedAt: new Date(),
    });
  }
  if (!fresh.length) throw new HttpError(400, 'None of those photos could be used', { rejected });
  const replace = req.body.replace === true || req.body.replace === 'true';
  let template = await FaceTemplate.findOne({ studentId });
  if (!template) {
    template = new FaceTemplate({ studentId, embeddings: [] });
  }
  const kept = replace ? [] : template.embeddings;
  template.embeddings = [...kept, ...fresh].slice(-10);
  template.modelVersion = modelVersion;
  template.consent = {
    given: true,
    givenAt: new Date(),
    policyVersion: String(req.body.policyVersion || config.policyVersion),
  };
  await template.save();
  await audit(req, {
    action: 'face.enroll',
    entity: 'FaceTemplate',
    entityId: template._id,
    after: { studentId, stored: template.embeddings.length, added: fresh.length },
  });
  res.json({
    stored: template.embeddings.length,
    added: fresh.length,
    rejected,
    recommended: 5,
    modelVersion: template.modelVersion,
  });
}));

studentRouter.delete('/students/:id/face', wrap(async (req, res) => {
  const studentId = requireId(req.params.id, 'student id');
  if (req.user.role !== 'admin' && req.user.sub !== studentId) {
    throw new HttpError(403, 'You can only delete your own face template');
  }
  const existing = await FaceTemplate.findOne({ studentId });
  await FaceTemplate.deleteOne({ studentId });
  await audit(req, { action: 'face.delete', entity: 'FaceTemplate', entityId: existing?._id, before: { studentId } });
  res.json({ deleted: true });
}));

studentRouter.get('/users', requireRoles('admin'), wrap(async (req, res) => {
  const allowed = ['student', 'lecturer', 'hod', 'admin'];
  const filter = {};
  if (req.query.role) {
    const role = String(req.query.role);
    if (!allowed.includes(role)) throw new HttpError(400, 'Unknown role');
    filter.role = role;
  } else {
    filter.role = { $in: ['lecturer', 'hod', 'admin'] };
  }
  const users = await User.find(filter)
    .select('-passwordHash -refreshTokens -resetOtpHash')
    .sort({ role: 1, email: 1 })
    .limit(200);
  res.json({ users: users.map(publicUser) });
}));

studentRouter.post('/users', requireRoles('admin'), wrap(async (req, res) => {
  const role = requiredText(req.body.role, 'Role');
  if (!['lecturer', 'hod', 'admin'].includes(role)) throw new HttpError(400, 'Choose a staff role');
  const profile = readProfile(req.body);
  if (!profile.firstName || !profile.lastName) throw new HttpError(400, 'Enter the staff name');
  const user = await createUser({ role, email: req.body.email, password: req.body.password, profile });
  await audit(req, { action: 'user.create', entity: 'User', entityId: user._id, after: publicUser(user) });
  res.status(201).json({ user: publicUser(user) });
}));

studentRouter.patch('/users/:id', requireRoles('admin'), wrap(async (req, res) => {
  const user = await User.findById(requireId(req.params.id, 'user id'));
  if (!user) throw new HttpError(404, 'User not found');
  const before = publicUser(user);
  if (req.body.isActive != null) user.isActive = Boolean(req.body.isActive);
  if (req.body.role) {
    if (!['student', 'lecturer', 'hod', 'admin'].includes(req.body.role)) throw new HttpError(400, 'Unknown role');
    user.role = req.body.role;
  }
  if (req.body.profile && typeof req.body.profile === 'object') {
    const current = typeof user.profile?.toObject === 'function' ? user.profile.toObject() : { ...(user.profile || {}) };
    user.profile = readProfile({ ...current, ...req.body.profile });
  }
  await user.save();
  await audit(req, { action: 'user.update', entity: 'User', entityId: user._id, before, after: publicUser(user) });
  res.json({ user: publicUser(user) });
}));

studentRouter.post('/users/:id/password', requireRoles('admin'), wrap(async (req, res) => {
  const user = await User.findById(requireId(req.params.id, 'user id'));
  if (!user) throw new HttpError(404, 'User not found');
  assertPassword(req.body.password);
  user.passwordHash = await hashPassword(req.body.password);
  user.refreshTokens = [];
  await user.save();
  await audit(req, { action: 'auth.reset', entity: 'User', entityId: user._id });
  res.json({ message: 'Password updated' });
}));

function cellText(value) {
  if (value == null) return '';
  if (typeof value === 'object' && value.text) return String(value.text).trim();
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
}

function pick(row, names) {
  const entries = Object.entries(row || {});
  for (const name of names) {
    const found = entries.find(([key]) => key.trim().toLowerCase() === name);
    if (found) {
      const text = cellText(found[1]);
      if (text) return text;
    }
  }
  return '';
}

async function rowsFromUpload(file) {
  const name = String(file.originalname || '').toLowerCase();
  if (name.endsWith('.xlsx')) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.buffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) return [];
    const headerRow = sheet.getRow(1).values.slice(1).map((header) => cellText(header));
    const rows = [];
    sheet.eachRow((row, index) => {
      if (index === 1) return;
      const values = row.values.slice(1);
      const record = {};
      headerRow.forEach((header, column) => {
        if (header) record[header] = values[column];
      });
      rows.push(record);
    });
    return rows;
  }
  return parse(file.buffer, { columns: true, skip_empty_lines: true, trim: true, bom: true });
}
