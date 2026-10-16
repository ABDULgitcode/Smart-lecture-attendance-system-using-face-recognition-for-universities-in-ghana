import crypto from 'crypto';
import { Router } from 'express';
import { requireAuth, requireRoles, requireRosterAccess } from '../middleware/auth.js';
import {
  assertCanViewOffering,
  offeringOrThrow,
} from '../services/access.js';
import { overrideRecord } from '../services/marking.js';
import { notify } from '../services/notify.js';
import { buildPdf, buildWorkbook } from '../services/reports.js';
import { departmentAnalytics, loadRoster, offeringReport, sessionTrend } from '../services/stats.js';
import { audit } from '../utils/audit.js';
import { sha256 } from '../utils/crypto.js';
import { HttpError, requireId, requiredText, wrap } from '../utils/http.js';
import { publicDispute } from '../utils/present.js';
import { AttendanceRecord, AuditLog, Department, Device, Dispute, Notification, User } from '../models.js';

export const insightRouter = Router();

function fileSlug(value) {
  return String(value || 'attendance').replace(/[^A-Za-z0-9_-]+/g, '-');
}

insightRouter.get('/offerings/:id/roster', requireRosterAccess, wrap(async (req, res) => {
  const offering = await offeringOrThrow(requireId(req.params.id, 'offering id'));
  if (req.user) await assertCanViewOffering(req, offering);
  const includeEmbeddings = req.query.embeddings === '1';
  const students = await loadRoster(offering._id, { embeddings: includeEmbeddings });
  res.json({
    offeringId: offering._id,
    students: students.map((student) => ({
      id: student.id,
      name: student.name,
      indexNumber: student.indexNumber,
      embeddingCount: student.embeddingCount,
      modelVersion: student.modelVersion,
      ...(includeEmbeddings ? { embeddings: student.embeddings } : {}),
    })),
  });
}));

insightRouter.get('/offerings/:id/report', requireAuth, requireRoles('lecturer', 'admin', 'hod'), wrap(async (req, res) => {
  const offering = await offeringOrThrow(requireId(req.params.id, 'offering id'));
  await assertCanViewOffering(req, offering);
  const report = await offeringReport(offering._id);
  const format = String(req.query.format || 'json');
  if (format === 'pdf') {
    const pdf = await buildPdf(report);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileSlug(report.course?.code)}-attendance.pdf"`);
    return res.send(Buffer.from(pdf));
  }
  if (format === 'xlsx' || format === 'excel') {
    const body = await buildWorkbook(report);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileSlug(report.course?.code)}-attendance.xlsx"`);
    return res.send(Buffer.from(body));
  }
  if (format !== 'json') throw new HttpError(400, 'Format must be json, pdf, or xlsx');
  return res.json(report);
}));

insightRouter.get('/offerings/:id/trend', requireAuth, requireRoles('lecturer', 'admin', 'hod'), wrap(async (req, res) => {
  const offering = await offeringOrThrow(requireId(req.params.id, 'offering id'));
  await assertCanViewOffering(req, offering);
  res.json(await sessionTrend(offering._id));
}));

insightRouter.patch('/records/:id', requireAuth, requireRoles('lecturer', 'admin', 'hod'), wrap(async (req, res) => {
  const record = await AttendanceRecord.findById(requireId(req.params.id, 'record id'));
  if (!record) throw new HttpError(404, 'Attendance record not found');
  const offering = await offeringOrThrow(String(record.offeringId));
  await assertCanViewOffering(req, offering);
  const outcome = await overrideRecord(record, {
    status: req.body.status,
    reason: req.body.reason,
    actorId: req.user.sub,
  });
  await audit(req, {
    action: 'attendance.override',
    entity: 'AttendanceRecord',
    entityId: record._id,
    before: outcome.before,
    after: { status: outcome.record.status, reason: outcome.record.overrideReason },
  });
  await notify(record.studentId, 'attendance', `Your attendance was changed to ${outcome.record.status}.`);
  res.json({ record: outcome.record, stats: outcome.stats });
}));

insightRouter.post('/disputes', requireAuth, requireRoles('student'), wrap(async (req, res) => {
  const record = await AttendanceRecord.findById(requireId(req.body.recordId, 'record id'));
  if (!record) throw new HttpError(404, 'Attendance record not found');
  if (String(record.studentId) !== req.user.sub) throw new HttpError(403, 'You can only dispute your own attendance');
  const open = await Dispute.findOne({ recordId: record._id, studentId: req.user.sub, status: 'pending' });
  if (open) throw new HttpError(409, 'You already have an open dispute for this lecture');
  const dispute = await Dispute.create({
    recordId: record._id,
    studentId: req.user.sub,
    reason: requiredText(req.body.reason, 'Reason'),
    requestedStatus: req.body.requestedStatus || 'present',
  });
  await audit(req, { action: 'dispute.create', entity: 'Dispute', entityId: dispute._id, after: { recordId: record._id } });
  res.status(201).json({ dispute });
}));

insightRouter.get('/disputes', requireAuth, wrap(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = String(req.query.status);
  if (req.user.role === 'student') filter.studentId = req.user.sub;
  let disputes = await Dispute.find(filter)
    .sort({ createdAt: -1 })
    .limit(100)
    .populate('studentId', 'profile')
    .populate('recordId', 'offeringId status');
  if (req.user.role === 'student') {
    // Students only receive their own disputes from the query above.
  } else if (req.user.role === 'lecturer') {
    const allowed = new Set();
    for (const dispute of disputes) {
      const offeringId = dispute.recordId?.offeringId;
      if (!offeringId || allowed.has(String(offeringId))) continue;
      const offering = await offeringOrThrow(String(offeringId));
      if (offering.lecturerIds.some((id) => String(id) === req.user.sub)) allowed.add(String(offeringId));
    }
    disputes = disputes.filter((dispute) => allowed.has(String(dispute.recordId?.offeringId)));
  } else if (req.user.role === 'hod') {
    const me = await User.findById(req.user.sub).select('profile.departmentId');
    const allowed = new Set();
    for (const dispute of disputes) {
      const offeringId = dispute.recordId?.offeringId;
      if (!offeringId) continue;
      const offering = await offeringOrThrow(String(offeringId));
      if (String(offering.courseId?.departmentId) === String(me?.profile?.departmentId)) allowed.add(String(offeringId));
    }
    disputes = disputes.filter((dispute) => allowed.has(String(dispute.recordId?.offeringId)));
  } else if (req.user.role !== 'admin') {
    disputes = [];
  }
  res.json({ disputes: disputes.map(publicDispute) });
}));

insightRouter.patch('/disputes/:id', requireAuth, requireRoles('lecturer', 'admin', 'hod'), wrap(async (req, res) => {
  const dispute = await Dispute.findById(requireId(req.params.id, 'dispute id'));
  if (!dispute) throw new HttpError(404, 'Dispute not found');
  if (dispute.status !== 'pending') throw new HttpError(409, 'This dispute is already resolved');
  const record = await AttendanceRecord.findById(dispute.recordId);
  if (!record) throw new HttpError(404, 'Attendance record not found');
  const offering = await offeringOrThrow(String(record.offeringId));
  await assertCanViewOffering(req, offering);
  const decision = requiredText(req.body.status, 'Decision');
  if (!['approved', 'rejected'].includes(decision)) throw new HttpError(400, 'Decision must be approved or rejected');
  dispute.status = decision;
  dispute.resolutionNote = String(req.body.resolutionNote || '').trim();
  dispute.resolvedBy = req.user.sub;
  if (decision === 'approved') {
    await overrideRecord(record, {
      status: dispute.requestedStatus || 'present',
      reason: dispute.resolutionNote || dispute.reason,
      actorId: req.user.sub,
    });
  }
  await dispute.save();
  await notify(
    dispute.studentId,
    'dispute',
    decision === 'approved'
      ? 'Your attendance dispute was approved.'
      : 'Your attendance dispute was rejected.',
  );
  await audit(req, {
    action: 'dispute.resolve',
    entity: 'Dispute',
    entityId: dispute._id,
    after: { status: decision },
  });
  res.json({ dispute });
}));

insightRouter.get('/notifications', requireAuth, wrap(async (req, res) => {
  const notes = await Notification.find({ userId: req.user.sub }).sort({ createdAt: -1 }).limit(50);
  res.json({ notifications: notes });
}));

insightRouter.post('/notifications/read-all', requireAuth, wrap(async (req, res) => {
  await Notification.updateMany({ userId: req.user.sub, read: false }, { $set: { read: true } });
  res.json({ ok: true });
}));

insightRouter.patch('/notifications/:id', requireAuth, wrap(async (req, res) => {
  const note = await Notification.findOne({ _id: requireId(req.params.id, 'notification id'), userId: req.user.sub });
  if (!note) throw new HttpError(404, 'Notification not found');
  note.read = true;
  await note.save();
  res.json({ notification: note });
}));

insightRouter.get('/analytics/department/:id', requireAuth, requireRoles('admin', 'hod'), wrap(async (req, res) => {
  const departmentId = requireId(req.params.id, 'department id');
  const department = await Department.findById(departmentId);
  if (!department) throw new HttpError(404, 'Department not found');
  if (req.user.role === 'hod') {
    const me = await User.findById(req.user.sub).select('profile.departmentId');
    if (String(me?.profile?.departmentId) !== departmentId) throw new HttpError(403, 'You do not have access to this department');
  }
  res.json({ department, ...(await departmentAnalytics(departmentId)) });
}));

insightRouter.get('/audit', requireAuth, requireRoles('admin'), wrap(async (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const filter = {};
  if (req.query.entity) filter.entity = String(req.query.entity);
  const logs = await AuditLog.find(filter).sort({ createdAt: -1 }).limit(limit);
  res.json({ logs });
}));

insightRouter.post('/devices', requireAuth, requireRoles('admin'), wrap(async (req, res) => {
  const apiKey = crypto.randomBytes(24).toString('hex');
  const device = await Device.create({
    name: requiredText(req.body.name, 'Name'),
    type: ['tablet', 'phone', 'camera'].includes(req.body.type) ? req.body.type : 'tablet',
    venueId: req.body.venueId ? requireId(req.body.venueId, 'venue id') : undefined,
    apiKeyHash: sha256(apiKey),
  });
  await audit(req, { action: 'device.create', entity: 'Device', entityId: device._id, after: { name: device.name } });
  res.status(201).json({
    device: { id: device._id, name: device.name, type: device.type, venueId: device.venueId },
    apiKey,
  });
}));

insightRouter.get('/devices', requireAuth, requireRoles('admin'), wrap(async (req, res) => {
  const devices = await Device.find().sort({ name: 1 });
  res.json({
    devices: devices.map((device) => ({
      id: device._id,
      name: device.name,
      type: device.type,
      venueId: device.venueId || null,
      lastSeenAt: device.lastSeenAt || null,
    })),
  });
}));
