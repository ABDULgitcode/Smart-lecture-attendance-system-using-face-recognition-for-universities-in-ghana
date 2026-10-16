import { AttendanceRecord, CourseOffering, LectureSession } from '../models.js';
import { config } from '../config.js';
import { analyzeImage } from './faceClient.js';
import { loadRoster, recomputeStats } from './stats.js';
import { bestMatches, roundScore, statusForTime } from '../utils/attendance.js';
import { makeCode } from '../utils/crypto.js';
import { HttpError, isId } from '../utils/http.js';
import { notifyMany } from './notify.js';
import { matchesCode } from './codes.js';

export const AUTO_ABSENT_REASON = 'Marked absent when the session closed';
const SKEW_BEFORE_MS = 5 * 60 * 1000;
const SKEW_AFTER_MS = 2 * 60 * 1000;

function courseCode(offering) {
  return offering.courseId?.code || 'your course';
}

function enrolled(offering, studentId) {
  return offering.studentIds.some((id) => String(id?._id || id) === String(studentId));
}

export async function refreshStats(sessionId) {
  const stats = await recomputeStats(sessionId);
  await LectureSession.updateOne({ _id: sessionId }, { $set: { stats } });
  return stats;
}

export function assertMarkTime(session, markedAt) {
  const time = new Date(markedAt).getTime();
  if (Number.isNaN(time)) throw new HttpError(400, 'Invalid attendance time');
  if (time > Date.now() + 60 * 1000) throw new HttpError(400, 'Attendance time cannot be in the future');
  if (time < new Date(session.startedAt).getTime() - SKEW_BEFORE_MS) {
    throw new HttpError(400, 'That attendance time is before the lecture started');
  }
  if (session.endedAt && time > new Date(session.endedAt).getTime() + SKEW_AFTER_MS) {
    throw new HttpError(400, 'That attendance time is after the lecture ended');
  }
  return new Date(markedAt);
}

function isAutoAbsent(record) {
  return record.status === 'absent' && record.overrideReason === AUTO_ABSENT_REASON && !record.overriddenBy;
}

export async function writeAttendance({
  session,
  studentId,
  status,
  method,
  confidence,
  livenessPassed,
  markedAt,
  overrideReason,
  overriddenBy,
  allowUpgrade = false,
}) {
  const when = assertMarkTime(session, markedAt || new Date());
  const existing = await AttendanceRecord.findOne({ sessionId: session._id, studentId });
  if (existing) {
    if (allowUpgrade && isAutoAbsent(existing) && (method === 'face' || method === 'qr')) {
      existing.status = status;
      existing.method = method;
      existing.confidence = confidence;
      existing.livenessPassed = livenessPassed;
      existing.markedAt = when;
      existing.syncedAt = new Date();
      existing.overrideReason = null;
      existing.overriddenBy = null;
      await existing.save();
      return { record: existing, created: false, upgraded: true };
    }
    return { record: existing, created: false, duplicate: true };
  }
  try {
    const record = await AttendanceRecord.create({
      sessionId: session._id,
      offeringId: session.offeringId,
      studentId,
      status,
      method,
      confidence,
      livenessPassed,
      markedAt: when,
      syncedAt: new Date(),
      overrideReason,
      overriddenBy,
    });
    return { record, created: true };
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const record = await AttendanceRecord.findOne({ sessionId: session._id, studentId });
    return { record, created: false, duplicate: true };
  }
}

export async function uniqueSessionCode() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const sessionCode = makeCode();
    const exists = await LectureSession.exists({ status: 'open', sessionCode });
    if (!exists) return sessionCode;
  }
  throw new HttpError(500, 'Could not create a session code');
}

export async function findOpenSessionByCode(code) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!normalized) return null;
  const byStatic = await LectureSession.findOne({
    status: 'open',
    allowCodeCheckIn: true,
    sessionCode: normalized,
  });
  if (byStatic) return byStatic;
  const openSessions = await LectureSession.find({ status: 'open', allowCodeCheckIn: true }).select('_id').limit(1000);
  return openSessions.find((session) => matchesCode(session._id, normalized)) || null;
}

async function tellStudent(userId, status, offering, created) {
  if (!created) return;
  await notifyMany([
    {
      userId,
      type: 'attendance',
      message: `You were marked ${status} for ${courseCode(offering)}.`,
    },
  ]);
}

export async function recognizeFrame({ session, offering, imageBuffer }) {
  if (session.status !== 'open') throw new HttpError(409, 'This session is closed');
  const analysis = await analyzeImage(imageBuffer, 'recognize');
  const roster = await loadRoster(offering._id, { embeddings: true });
  const marked = [];
  const unmatched = [];
  const seen = new Set();
  let spoofCount = 0;

  for (const face of analysis.faces || []) {
    if (!face.liveness?.passed) {
      spoofCount += 1;
      unmatched.push({ box: face.box, reason: 'Possible photo or screen replay' });
      continue;
    }
    const { decision, scores } = bestMatches(face.embedding, roster, config.match);
    if (decision.type !== 'match') {
      unmatched.push({
        box: face.box,
        reason: decision.type === 'ambiguous' ? 'Two students look too similar' : 'No enrolled student matched',
        candidates: (scores || []).map((item) => ({
          name: item.name,
          indexNumber: item.indexNumber,
          score: roundScore(item.score),
        })),
      });
      continue;
    }
    const studentId = String(decision.best.studentId);
    if (seen.has(studentId)) continue;
    seen.add(studentId);
    const markedAt = new Date();
    const status = statusForTime(session.startedAt, markedAt, session.lateAfterMinutes);
    const result = await writeAttendance({
      session,
      studentId,
      status,
      method: 'face',
      confidence: roundScore(decision.best.score),
      livenessPassed: true,
      markedAt,
    });
    marked.push({
      studentId,
      name: decision.best.name,
      indexNumber: decision.best.indexNumber,
      status: result.record.status,
      confidence: roundScore(decision.best.score),
      duplicate: Boolean(result.duplicate),
    });
    await tellStudent(studentId, status, offering, result.created);
  }

  const stats = await refreshStats(session._id);
  if (spoofCount) {
    await LectureSession.updateOne(
      { _id: session._id },
      {
        $push: {
          suspicious: {
            $each: [{ at: new Date(), reason: `${spoofCount} face(s) failed the liveness check` }],
            $slice: -20,
          },
        },
      },
    );
  }
  return { modelVersion: analysis.modelVersion, marked, unmatched, stats };
}

export async function syncRecords({ session, offering, records, fromDevice, actorId }) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new HttpError(400, 'Add at least one attendance record');
  }
  if (records.length > 500) throw new HttpError(400, 'Send at most 500 records at a time');
  const accepted = [];
  const duplicates = [];
  const rejected = [];

  for (let index = 0; index < records.length; index += 1) {
    const item = records[index] || {};
    try {
      const method = item.method;
      if (!['face', 'manual', 'qr'].includes(method)) throw new HttpError(400, 'Unknown attendance method');
      if (fromDevice && method === 'manual') throw new HttpError(400, 'A device cannot submit a manual mark');
      if (!isId(String(item.studentId || ''))) throw new HttpError(400, 'Invalid student id');
      if (!enrolled(offering, item.studentId)) throw new HttpError(400, 'Student is not enrolled in this course');
      if (method === 'face') {
        if (item.livenessPassed !== true) throw new HttpError(400, 'Face attendance requires a passed liveness check');
        const confidence = Number(item.confidence);
        if (!Number.isFinite(confidence) || confidence < config.match.threshold) {
          throw new HttpError(400, 'Face match is below the acceptance threshold');
        }
      }
      const markedAt = item.markedAt ? new Date(item.markedAt) : new Date();
      let status;
      let overrideReason;
      let overriddenBy;
      if (method === 'manual') {
        if (session.status !== 'open') throw new HttpError(409, 'Use the override endpoint to change a closed session');
        if (!['present', 'late', 'absent', 'excused'].includes(item.status)) throw new HttpError(400, 'Choose a valid status');
        if (!item.reason || String(item.reason).trim().length < 3) throw new HttpError(400, 'A manual mark needs a reason');
        status = item.status;
        overrideReason = String(item.reason).trim();
        overriddenBy = actorId;
      } else {
        status = statusForTime(session.startedAt, markedAt, session.lateAfterMinutes);
      }
      const result = await writeAttendance({
        session,
        studentId: item.studentId,
        status,
        method,
        confidence: method === 'face' ? roundScore(Number(item.confidence)) : undefined,
        livenessPassed: method === 'face' ? true : undefined,
        markedAt,
        overrideReason,
        overriddenBy,
        allowUpgrade: method === 'face' || method === 'qr',
      });
      const row = { index, studentId: item.studentId, status: result.record.status, id: result.record._id };
      if (result.created || result.upgraded) {
        accepted.push(row);
        await tellStudent(item.studentId, result.record.status, offering, true);
      } else {
        duplicates.push(row);
      }
    } catch (error) {
      if (!error.status || error.status >= 500) console.error(error);
      rejected.push({
        index,
        error: error.status && error.status < 500 ? error.message : 'Could not save that record',
      });
    }
  }

  const stats = await refreshStats(session._id);
  return { accepted, duplicates, rejected, stats };
}

export async function checkInWithCode({ userId, code }) {
  const session = await findOpenSessionByCode(code);
  if (!session) throw new HttpError(400, 'That code is not valid');
  const offering = await CourseOffering.findById(session.offeringId).populate('courseId');
  if (!offering) throw new HttpError(404, 'Course offering not found');
  if (!enrolled(offering, userId)) throw new HttpError(403, 'You are not enrolled in this course');
  const markedAt = new Date();
  const status = statusForTime(session.startedAt, markedAt, session.lateAfterMinutes);
  const result = await writeAttendance({
    session,
    studentId: userId,
    status,
    method: 'qr',
    markedAt,
  });
  if (result.created) {
    await tellStudent(userId, status, offering, true);
    await refreshStats(session._id);
  }
  return {
    duplicate: Boolean(result.duplicate),
    status: result.record.status,
    markedAt: result.record.markedAt,
    course: { code: offering.courseId?.code, title: offering.courseId?.title },
    sessionId: session._id,
  };
}

export async function manualMark({ session, offering, studentId, status, reason, actorId }) {
  if (!enrolled(offering, studentId)) throw new HttpError(400, 'Student is not enrolled in this course');
  if (!['present', 'late', 'absent', 'excused'].includes(status)) throw new HttpError(400, 'Choose a valid status');
  const note = String(reason || '').trim();
  if (note.length < 3) throw new HttpError(400, 'A manual mark needs a reason');
  const existing = await AttendanceRecord.findOne({ sessionId: session._id, studentId });
  if (existing) return overrideRecord(existing, { status, reason: note, actorId });
  const result = await writeAttendance({
    session,
    studentId,
    status,
    method: 'manual',
    markedAt: new Date(),
    overrideReason: note,
    overriddenBy: actorId,
  });
  const stats = await refreshStats(session._id);
  await notifyMany([
    {
      userId: studentId,
      type: 'attendance',
      message: `A lecturer marked you ${status} for ${courseCode(offering)}.`,
    },
  ]);
  return { record: result.record, stats, before: null };
}

export async function overrideRecord(record, { status, reason, actorId }) {
  if (!['present', 'late', 'absent', 'excused'].includes(status)) throw new HttpError(400, 'Choose a valid status');
  const note = String(reason || '').trim();
  if (note.length < 3) throw new HttpError(400, 'An override needs a reason');
  const before = {
    status: record.status,
    method: record.method,
    overrideReason: record.overrideReason,
    overriddenBy: record.overriddenBy,
  };
  record.status = status;
  record.overrideReason = note;
  record.overriddenBy = actorId;
  await record.save();
  const stats = await refreshStats(record.sessionId);
  return { before, record, stats };
}

export async function closeSession(session, offering) {
  if (session.status !== 'open') throw new HttpError(409, 'Session is already closed');
  const existing = await AttendanceRecord.find({ sessionId: session._id }).select('studentId');
  const have = new Set(existing.map((row) => String(row.studentId)));
  const now = new Date();
  for (const studentId of offering.studentIds) {
    const id = studentId?._id || studentId;
    if (have.has(String(id))) continue;
    await writeAttendance({
      session,
      studentId: id,
      status: 'absent',
      method: 'manual',
      markedAt: now,
      overrideReason: AUTO_ABSENT_REASON,
    });
  }
  const stats = await recomputeStats(session._id);
  await LectureSession.updateOne(
    { _id: session._id, status: 'open' },
    { $set: { status: 'closed', endedAt: now, stats } },
  );
  return LectureSession.findById(session._id);
}
