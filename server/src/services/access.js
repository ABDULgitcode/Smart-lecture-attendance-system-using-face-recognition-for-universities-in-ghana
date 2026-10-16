import { CourseOffering, LectureSession, User } from '../models.js';
import { HttpError } from '../utils/http.js';

export async function offeringOrThrow(id) {
  const offering = await CourseOffering.findById(id).populate('courseId');
  if (!offering) throw new HttpError(404, 'Course offering not found');
  return offering;
}

export async function sessionOrThrow(id) {
  const session = await LectureSession.findById(id);
  if (!session) throw new HttpError(404, 'Attendance session not found');
  return session;
}

export function canTeach(user, offering) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role !== 'lecturer') return false;
  return offering.lecturerIds.some((id) => String(id) === user.sub);
}

export function assertCanTeach(user, offering) {
  if (!canTeach(user, offering)) throw new HttpError(403, 'You do not teach this course');
}

export async function assertCanViewOffering(req, offering) {
  if (req.user.role === 'admin') return;
  if (req.user.role === 'lecturer' && offering.lecturerIds.some((id) => String(id) === req.user.sub)) return;
  if (req.user.role === 'hod') {
    const me = await User.findById(req.user.sub).select('profile.departmentId');
    const departmentId = offering.courseId?.departmentId;
    if (me?.profile?.departmentId && String(me.profile.departmentId) === String(departmentId)) return;
  }
  throw new HttpError(403, 'You do not have access to this course');
}

export async function assertCanReadOffering(req, offering) {
  if (req.user.role === 'student') {
    const enrolled = offering.studentIds.some((id) => String(id?._id || id) === req.user.sub);
    if (!enrolled) throw new HttpError(403, 'You do not have access to this course');
    return;
  }
  await assertCanViewOffering(req, offering);
}

export function assertDeviceVenue(device, session) {
  if (!device?.venueId || !session?.venueId) return;
  if (String(device.venueId) !== String(session.venueId)) {
    throw new HttpError(403, 'This device is registered to a different venue');
  }
}

export async function assertCanViewStudent(req, student) {
  if (req.user.role === 'admin' || req.user.sub === String(student._id)) return;
  if (req.user.role === 'hod') {
    const me = await User.findById(req.user.sub).select('profile.departmentId');
    if (me?.profile?.departmentId && String(me.profile.departmentId) === String(student.profile?.departmentId)) return;
  }
  if (req.user.role === 'lecturer') {
    const teaches = await CourseOffering.exists({ lecturerIds: req.user.sub, studentIds: student._id });
    if (teaches) return;
  }
  throw new HttpError(403, 'You do not have access to this student');
}
