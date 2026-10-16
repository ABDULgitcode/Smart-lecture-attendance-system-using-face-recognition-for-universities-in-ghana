import { AttendanceRecord, Course, CourseOffering, FaceTemplate, LectureSession, Notification } from '../models.js';
import { decryptJson } from '../utils/crypto.js';
import { attendancePercentage } from '../utils/attendance.js';
import { fullName } from '../utils/http.js';
import { notifyMany } from './notify.js';

export async function offeringReport(offeringId) {
  const offering = await CourseOffering.findById(offeringId)
    .populate('courseId')
    .populate('studentIds', 'profile email');
  if (!offering) return null;
  const sessions = await LectureSession.find({ offeringId, status: 'closed' }).sort({ startedAt: 1 });
  const sessionIds = sessions.map((session) => session._id);
  const grouped = sessionIds.length
    ? await AttendanceRecord.aggregate([
        { $match: { offeringId: offering._id, sessionId: { $in: sessionIds } } },
        {
          $group: {
            _id: '$studentId',
            present: { $sum: { $cond: [{ $eq: ['$status', 'present'] }, 1, 0] } },
            late: { $sum: { $cond: [{ $eq: ['$status', 'late'] }, 1, 0] } },
            absent: { $sum: { $cond: [{ $eq: ['$status', 'absent'] }, 1, 0] } },
            excused: { $sum: { $cond: [{ $eq: ['$status', 'excused'] }, 1, 0] } },
          },
        },
      ])
    : [];
  const counts = new Map(grouped.map((row) => [String(row._id), row]));
  const minimum = offering.courseId?.rules?.minAttendancePercent ?? 75;
  const students = offering.studentIds.map((student) => {
    const row = counts.get(String(student._id)) || { present: 0, late: 0, absent: 0, excused: 0 };
    const percentage = attendancePercentage(row, sessions.length);
    return {
      id: student._id,
      name: fullName(student.profile),
      indexNumber: student.profile?.indexNumber || '',
      email: student.email,
      present: row.present,
      late: row.late,
      absent: row.absent,
      excused: row.excused,
      percentage,
      eligible: percentage === null ? null : percentage >= minimum,
    };
  });
  students.sort((a, b) => a.name.localeCompare(b.name));
  return {
    offeringId: offering._id,
    course: {
      code: offering.courseId?.code,
      title: offering.courseId?.title,
      creditHours: offering.courseId?.creditHours,
    },
    academicYear: offering.academicYear,
    semester: offering.semester,
    closedSessions: sessions.length,
    minAttendancePercent: minimum,
    students,
  };
}

export async function sessionTrend(offeringId) {
  const sessions = await LectureSession.find({ offeringId, status: 'closed' }).sort({ startedAt: 1 }).limit(12);
  return {
    sessions: sessions.map((session) => ({
      id: session._id,
      startedAt: session.startedAt,
      present: session.stats?.present || 0,
      late: session.stats?.late || 0,
      absent: session.stats?.absent || 0,
      excused: session.stats?.excused || 0,
    })),
  };
}

export async function loadRoster(offeringId, options = {}) {
  const includeEmbeddings = options.embeddings !== false;
  const offering = await CourseOffering.findById(offeringId).populate('studentIds', 'profile');
  if (!offering) return [];
  const ids = offering.studentIds.map((student) => student._id);
  const templates = await FaceTemplate.find({ studentId: { $in: ids } });
  const byStudent = new Map(templates.map((template) => [String(template.studentId), template]));
  return offering.studentIds.map((student) => {
    const template = byStudent.get(String(student._id));
    const embeddings = [];
    if (template && includeEmbeddings) {
      for (const item of template.embeddings) {
        try {
          embeddings.push(decryptJson(item.vectorEnc));
        } catch {
          // Skip a template that cannot be decrypted with the current key.
        }
      }
    }
    return {
      id: String(student._id),
      name: fullName(student.profile),
      indexNumber: student.profile?.indexNumber || '',
      modelVersion: template?.modelVersion || null,
      embeddingCount: template?.embeddings?.length || 0,
      embeddings: includeEmbeddings ? embeddings : undefined,
    };
  });
}

export async function recomputeStats(sessionId) {
  const rows = await AttendanceRecord.aggregate([
    { $match: { sessionId } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  const stats = { present: 0, late: 0, absent: 0, excused: 0 };
  for (const row of rows) stats[row._id] = row.count;
  return stats;
}

export async function studentAttendance(studentId) {
  const offerings = await CourseOffering.find({ studentIds: studentId }).populate('courseId');
  const courses = [];
  for (const offering of offerings) {
    const report = await offeringReport(offering._id);
    const mine = report?.students.find((item) => String(item.id) === String(studentId));
    courses.push({
      offeringId: offering._id,
      academicYear: offering.academicYear,
      semester: offering.semester,
      course: report?.course,
      closedSessions: report?.closedSessions || 0,
      minAttendancePercent: report?.minAttendancePercent ?? 75,
      present: mine?.present || 0,
      late: mine?.late || 0,
      absent: mine?.absent || 0,
      excused: mine?.excused || 0,
      percentage: mine?.percentage ?? null,
      eligible: mine?.eligible ?? null,
    });
  }
  const recent = await AttendanceRecord.find({ studentId })
    .sort({ markedAt: -1 })
    .limit(40)
    .populate({ path: 'offeringId', populate: { path: 'courseId', select: 'code title' } });
  return {
    courses,
    recent: recent.map((record) => ({
      id: record._id,
      status: record.status,
      method: record.method,
      markedAt: record.markedAt,
      overrideReason: record.overrideReason || '',
      course: {
        code: record.offeringId?.courseId?.code || '',
        title: record.offeringId?.courseId?.title || '',
      },
    })),
  };
}

export async function departmentAnalytics(departmentId) {
  const courses = await Course.find({ departmentId }).select('_id');
  const offerings = await CourseOffering.find({ courseId: { $in: courses.map((course) => course._id) } }).populate('courseId');
  const rows = [];
  for (const offering of offerings) {
    const report = await offeringReport(offering._id);
    const scored = report.students.filter((student) => student.percentage !== null);
    const average = scored.length
      ? Math.round((scored.reduce((sum, student) => sum + student.percentage, 0) / scored.length) * 10) / 10
      : null;
    rows.push({
      offeringId: offering._id,
      course: report.course,
      academicYear: offering.academicYear,
      semester: offering.semester,
      enrolled: report.students.length,
      closedSessions: report.closedSessions,
      average,
      belowThreshold: report.students.filter((student) => student.eligible === false).length,
    });
  }
  return { departmentId, offerings: rows };
}

export async function warnBelowThreshold(offeringId) {
  const report = await offeringReport(offeringId);
  if (!report) return 0;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const notices = [];
  for (const student of report.students) {
    if (student.eligible !== false) continue;
    const already = await Notification.exists({
      userId: student.id,
      type: 'low-attendance',
      createdAt: { $gte: start },
    });
    if (already) continue;
    notices.push({
      userId: student.id,
      type: 'low-attendance',
      message: `${report.course?.code || 'A course'}: your attendance is ${student.percentage}%, below the ${report.minAttendancePercent}% exam threshold.`,
    });
  }
  await notifyMany(notices);
  return notices.length;
}
