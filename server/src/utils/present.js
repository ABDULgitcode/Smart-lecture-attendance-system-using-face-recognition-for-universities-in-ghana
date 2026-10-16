import { fullName } from './http.js';

export function publicSession(session, { includeCode = true } = {}) {
  return {
    id: session._id,
    offeringId: session.offeringId,
    venueId: session.venueId || null,
    lecturerId: session.lecturerId,
    startedAt: session.startedAt,
    endedAt: session.endedAt || null,
    status: session.status,
    sessionCode: includeCode ? session.sessionCode : undefined,
    allowCodeCheckIn: session.allowCodeCheckIn,
    lateAfterMinutes: session.lateAfterMinutes,
    stats: session.stats,
    suspicious: session.suspicious || [],
  };
}

export function publicRecord(record) {
  const student = record.studentId?.profile ? record.studentId : null;
  return {
    id: record._id,
    studentId: student ? student._id : record.studentId,
    name: student ? fullName(student.profile) : '',
    indexNumber: student?.profile?.indexNumber || '',
    status: record.status,
    method: record.method,
    confidence: record.confidence ?? null,
    livenessPassed: record.livenessPassed ?? null,
    markedAt: record.markedAt,
    overrideReason: record.overrideReason || '',
  };
}

export function publicOffering(offering) {
  const course = offering.courseId?.code
    ? {
        id: offering.courseId._id,
        code: offering.courseId.code,
        title: offering.courseId.title,
        departmentId: offering.courseId.departmentId,
        creditHours: offering.courseId.creditHours,
        rules: offering.courseId.rules,
      }
    : { id: offering.courseId };
  return {
    id: offering._id,
    course,
    academicYear: offering.academicYear,
    semester: offering.semester,
    lecturerIds: offering.lecturerIds,
    studentCount: offering.studentIds?.length || 0,
    timetable: offering.timetable || [],
  };
}

export function publicDispute(dispute) {
  const student = dispute.studentId?.profile ? dispute.studentId : null;
  return {
    id: dispute._id,
    recordId: dispute.recordId?._id || dispute.recordId,
    studentId: student?._id || dispute.studentId,
    studentName: student ? fullName(student.profile) : '',
    indexNumber: student?.profile?.indexNumber || '',
    reason: dispute.reason,
    requestedStatus: dispute.requestedStatus,
    status: dispute.status,
    resolutionNote: dispute.resolutionNote || '',
    createdAt: dispute.createdAt,
  };
}
