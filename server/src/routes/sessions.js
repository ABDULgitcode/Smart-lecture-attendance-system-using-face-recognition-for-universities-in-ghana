import { Router } from 'express';
import { requireAuth, requireRoles, requireSessionWriter } from '../middleware/auth.js';
import { upload } from '../middleware/error.js';
import { limitKey } from '../middleware/limit.js';
import { AttendanceRecord, Device, LectureSession, User, Venue } from '../models.js';
import { assertCanTeach, assertCanViewOffering, assertDeviceVenue, offeringOrThrow, sessionOrThrow } from '../services/access.js';
import { currentCode } from '../services/codes.js';
import {
  checkInWithCode,
  closeSession,
  manualMark,
  recognizeFrame,
  syncRecords,
  uniqueSessionCode,
} from '../services/marking.js';
import { notify } from '../services/notify.js';
import { warnBelowThreshold } from '../services/stats.js';
import { audit } from '../utils/audit.js';
import { HttpError, requireId, requiredText, wrap } from '../utils/http.js';
import { publicRecord, publicSession } from '../utils/present.js';

export const sessionRouter = Router();

async function staffSession(req) {
  const session = await sessionOrThrow(requireId(req.params.id, 'session id'));
  const offering = await offeringOrThrow(String(session.offeringId));
  if (req.user.role === 'hod') await assertCanViewOffering(req, offering);
  else assertCanTeach(req.user, offering);
  return { session, offering };
}

async function writerSession(req) {
  const session = await sessionOrThrow(requireId(req.params.id, 'session id'));
  const offering = await offeringOrThrow(String(session.offeringId));
  if (req.device) assertDeviceVenue(req.device, session);
  else assertCanTeach(req.user, offering);
  return { session, offering };
}

sessionRouter.get('/sessions', requireAuth, requireRoles('lecturer', 'admin', 'hod'), wrap(async (req, res) => {
  const offering = await offeringOrThrow(requireId(String(req.query.offeringId || ''), 'offering id'));
  await assertCanViewOffering(req, offering);
  const filter = { offeringId: offering._id };
  if (req.query.status) filter.status = String(req.query.status);
  const sessions = await LectureSession.find(filter).sort({ startedAt: -1 }).limit(30);
  const includeCode = req.user.role !== 'hod';
  res.json({ sessions: sessions.map((session) => publicSession(session, { includeCode })) });
}));

sessionRouter.post('/sessions', requireAuth, requireRoles('lecturer', 'admin'), wrap(async (req, res) => {
  const offering = await offeringOrThrow(requireId(req.body.offeringId, 'offering id'));
  assertCanTeach(req.user, offering);
  const existing = await LectureSession.findOne({ offeringId: offering._id, status: 'open' });
  if (existing) return res.json({ session: publicSession(existing), alreadyOpen: true });
  let venueId;
  if (req.body.venueId) {
    const venue = await Venue.findById(requireId(req.body.venueId, 'venue id'));
    if (!venue) throw new HttpError(404, 'Venue not found');
    venueId = venue._id;
  }
  let deviceId;
  if (req.body.deviceId) {
    const device = await Device.findById(requireId(req.body.deviceId, 'device id'));
    if (!device) throw new HttpError(404, 'Device not found');
    deviceId = device._id;
  }
  const session = await LectureSession.create({
    offeringId: offering._id,
    venueId,
    lecturerId: req.user.sub,
    startedAt: new Date(),
    status: 'open',
    sessionCode: await uniqueSessionCode(),
    allowCodeCheckIn: req.body.allowCodeCheckIn !== false,
    lateAfterMinutes: offering.courseId?.rules?.lateAfterMinutes ?? 10,
    deviceId,
  });
  await audit(req, { action: 'session.start', entity: 'LectureSession', entityId: session._id, after: publicSession(session) });
  res.status(201).json({ session: publicSession(session) });
}));

sessionRouter.get('/sessions/:id', requireAuth, requireRoles('lecturer', 'admin', 'hod'), wrap(async (req, res) => {
  const { session } = await staffSession(req);
  const records = await AttendanceRecord.find({ sessionId: session._id })
    .populate('studentId', 'profile email')
    .sort({ markedAt: 1 });
  res.set('Cache-Control', 'no-store');
  res.json({
    session: publicSession(session, { includeCode: req.user.role !== 'hod' }),
    records: records.map(publicRecord),
  });
}));

sessionRouter.get('/sessions/:id/code', requireAuth, requireRoles('lecturer', 'admin'), wrap(async (req, res) => {
  const { session, offering } = await staffSession(req);
  if (session.status !== 'open') throw new HttpError(409, 'This session is closed');
  const rotating = currentCode(session._id);
  res.set('Cache-Control', 'no-store');
  res.json({
    sessionId: session._id,
    sessionCode: session.sessionCode,
    rotatingCode: rotating.code,
    expiresIn: rotating.expiresIn,
    windowSeconds: rotating.windowSeconds,
    allowCodeCheckIn: session.allowCodeCheckIn,
    course: { code: offering.courseId?.code, title: offering.courseId?.title },
  });
}));

sessionRouter.patch('/sessions/:id', requireAuth, requireRoles('lecturer', 'admin'), wrap(async (req, res) => {
  const { session } = await staffSession(req);
  if (session.status !== 'open') throw new HttpError(409, 'This session is closed');
  if (req.body.allowCodeCheckIn != null) session.allowCodeCheckIn = Boolean(req.body.allowCodeCheckIn);
  await session.save();
  res.json({ session: publicSession(session) });
}));

sessionRouter.post('/sessions/:id/recognize', requireSessionWriter, upload.single('image'), wrap(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Upload a photo of the class');
  const { session, offering } = await writerSession(req);
  const result = await recognizeFrame({ session, offering, imageBuffer: req.file.buffer });
  await audit(req, {
    action: 'attendance.scan',
    entity: 'LectureSession',
    entityId: session._id,
    after: { marked: result.marked.length, unmatched: result.unmatched.length, spoofSuspects: result.unmatched.filter((item) => item.reason?.includes('photo')).length },
  });
  res.json(result);
}));

sessionRouter.post('/sessions/:id/records', requireSessionWriter, wrap(async (req, res) => {
  const { session, offering } = await writerSession(req);
  const result = await syncRecords({
    session,
    offering,
    records: req.body.records,
    fromDevice: Boolean(req.device),
    actorId: req.user?.sub,
  });
  await audit(req, {
    action: 'attendance.sync',
    entity: 'LectureSession',
    entityId: session._id,
    after: {
      accepted: result.accepted.length,
      duplicates: result.duplicates.length,
      rejected: result.rejected.length,
    },
  });
  res.json(result);
}));

sessionRouter.post('/sessions/:id/manual', requireAuth, requireRoles('lecturer', 'admin'), wrap(async (req, res) => {
  const { session, offering } = await staffSession(req);
  let studentId = req.body.studentId ? String(req.body.studentId) : '';
  if (!studentId && req.body.indexNumber) {
    const student = await User.findOne({ role: 'student', 'profile.indexNumber': String(req.body.indexNumber).trim() });
    if (!student) throw new HttpError(404, 'No student with that index number');
    studentId = String(student._id);
  }
  studentId = requireId(studentId, 'student id');
  const outcome = await manualMark({
    session,
    offering,
    studentId,
    status: req.body.status,
    reason: req.body.reason,
    actorId: req.user.sub,
  });
  await audit(req, {
    action: outcome.before ? 'attendance.override' : 'attendance.manual',
    entity: 'AttendanceRecord',
    entityId: outcome.record._id,
    before: outcome.before || undefined,
    after: { status: outcome.record.status, reason: outcome.record.overrideReason },
  });
  if (outcome.before) {
    await notify(
      outcome.record.studentId,
      'attendance',
      `Your attendance was changed to ${outcome.record.status}.`,
    );
  }
  res.json({ record: publicRecord(outcome.record), stats: outcome.stats });
}));

sessionRouter.post('/sessions/:id/close', requireAuth, requireRoles('lecturer', 'admin'), wrap(async (req, res) => {
  const { session, offering } = await staffSession(req);
  const closed = await closeSession(session, offering);
  if (!closed) throw new HttpError(409, 'Session is already closed');
  await warnBelowThreshold(offering._id);
  await audit(req, { action: 'session.close', entity: 'LectureSession', entityId: closed._id, after: publicSession(closed) });
  res.json({
    session: publicSession(closed),
    message: 'Session closed. Offline devices can still upload marks that were taken during the lecture.',
  });
}));

sessionRouter.post('/check-in', requireAuth, requireRoles('student'), limitKey(30, 10 * 60 * 1000), wrap(async (req, res) => {
  const result = await checkInWithCode({
    userId: req.user.sub,
    code: requiredText(req.body.code, 'Check-in code'),
  });
  res.json(result);
}));
