import { Router } from 'express';
import { requireAuth, requireRoles } from '../middleware/auth.js';
import { Course, CourseOffering, Department, User, Venue } from '../models.js';
import { assertCanReadOffering, assertCanTeach, offeringOrThrow } from '../services/access.js';
import { audit } from '../utils/audit.js';
import { HttpError, isId, requireId, requiredText, wrap } from '../utils/http.js';
import { publicOffering } from '../utils/present.js';

export const catalogRouter = Router();

function ownsCatalog(path) {
  if (path === '/departments' || path.startsWith('/departments/')) return true;
  if (path === '/courses' || path.startsWith('/courses/')) return true;
  if (path === '/venues' || path.startsWith('/venues/')) return true;
  if (path === '/offerings') return true;
  if (/^\/offerings\/[^/]+$/.test(path)) return true;
  if (/^\/offerings\/[^/]+\/students(\/[^/]+)?$/.test(path)) return true;
  return false;
}

catalogRouter.use((req, res, next) => {
  if (!ownsCatalog(req.path)) return next('router');
  return requireAuth(req, res, next);
});

function cleanTimetable(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new HttpError(400, 'Timetable must be a list');
  return value.map((slot) => ({
    day: String(slot.day || '').trim().slice(0, 12),
    start: String(slot.start || '').trim(),
    end: String(slot.end || '').trim(),
    venueId: isId(String(slot.venueId || '')) ? slot.venueId : undefined,
  }));
}

catalogRouter.post('/departments', requireRoles('admin'), wrap(async (req, res) => {
  const department = await Department.create({
    name: requiredText(req.body.name, 'Name'),
    code: requiredText(req.body.code, 'Code'),
    facultyName: String(req.body.facultyName || '').trim(),
  });
  await audit(req, { action: 'department.create', entity: 'Department', entityId: department._id, after: department });
  res.status(201).json({ department });
}));

catalogRouter.get('/departments', wrap(async (req, res) => {
  const departments = await Department.find().sort({ code: 1 });
  res.json({ departments });
}));

catalogRouter.post('/courses', requireRoles('admin'), wrap(async (req, res) => {
  const departmentId = requireId(req.body.departmentId, 'department id');
  const department = await Department.findById(departmentId);
  if (!department) throw new HttpError(404, 'Department not found');
  const course = await Course.create({
    code: requiredText(req.body.code, 'Code'),
    title: requiredText(req.body.title, 'Title'),
    departmentId,
    creditHours: Number(req.body.creditHours || 3),
    rules: {
      lateAfterMinutes: Number(req.body.lateAfterMinutes ?? 10),
      minAttendancePercent: Number(req.body.minAttendancePercent ?? 75),
    },
  });
  await audit(req, { action: 'course.create', entity: 'Course', entityId: course._id, after: course });
  res.status(201).json({ course });
}));

catalogRouter.get('/courses', wrap(async (req, res) => {
  const filter = {};
  if (req.query.departmentId) filter.departmentId = requireId(String(req.query.departmentId), 'department id');
  const courses = await Course.find(filter).sort({ code: 1 });
  res.json({ courses });
}));

catalogRouter.patch('/courses/:id', requireRoles('admin'), wrap(async (req, res) => {
  const course = await Course.findById(requireId(req.params.id, 'course id'));
  if (!course) throw new HttpError(404, 'Course not found');
  const before = course.toObject();
  if (req.body.title) course.title = requiredText(req.body.title, 'Title');
  if (req.body.code) course.code = requiredText(req.body.code, 'Code');
  if (req.body.creditHours != null) course.creditHours = Number(req.body.creditHours);
  if (req.body.lateAfterMinutes != null) course.rules.lateAfterMinutes = Number(req.body.lateAfterMinutes);
  if (req.body.minAttendancePercent != null) course.rules.minAttendancePercent = Number(req.body.minAttendancePercent);
  await course.save();
  await audit(req, { action: 'course.update', entity: 'Course', entityId: course._id, before, after: course });
  res.json({ course });
}));

catalogRouter.post('/venues', requireRoles('admin'), wrap(async (req, res) => {
  const venue = await Venue.create({
    name: requiredText(req.body.name, 'Name'),
    building: String(req.body.building || '').trim(),
    capacity: req.body.capacity == null ? undefined : Number(req.body.capacity),
    geo: readGeo(req.body),
  });
  await audit(req, { action: 'venue.create', entity: 'Venue', entityId: venue._id, after: venue });
  res.status(201).json({ venue });
}));

catalogRouter.get('/venues', wrap(async (req, res) => {
  res.json({ venues: await Venue.find().sort({ name: 1 }) });
}));

function readGeo(body) {
  if (body.longitude == null && body.latitude == null) return undefined;
  const longitude = Number(body.longitude);
  const latitude = Number(body.latitude);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
    throw new HttpError(400, 'Coordinates must be numbers');
  }
  return { type: 'Point', coordinates: [longitude, latitude] };
}

async function offeringFilter(req) {
  if (req.user.role === 'admin') return {};
  if (req.user.role === 'lecturer') return { lecturerIds: req.user.sub };
  if (req.user.role === 'student') return { studentIds: req.user.sub };
  if (req.user.role === 'hod') {
    const me = await User.findById(req.user.sub).select('profile.departmentId');
    if (!me?.profile?.departmentId) return { _id: null };
    const courses = await Course.find({ departmentId: me.profile.departmentId }).select('_id');
    return { courseId: { $in: courses.map((course) => course._id) } };
  }
  return { _id: null };
}

catalogRouter.get('/offerings', wrap(async (req, res) => {
  const offerings = await CourseOffering.find(await offeringFilter(req))
    .populate('courseId')
    .sort({ academicYear: -1, semester: -1 })
    .limit(100);
  res.json({ offerings: offerings.map(publicOffering) });
}));

catalogRouter.post('/offerings', requireRoles('admin'), wrap(async (req, res) => {
  const course = await Course.findById(requireId(req.body.courseId, 'course id'));
  if (!course) throw new HttpError(404, 'Course not found');
  const semester = Number(req.body.semester);
  if (![1, 2].includes(semester)) throw new HttpError(400, 'Semester must be 1 or 2');
  const lecturerIds = await staffIds(req.body.lecturerIds);
  const studentIds = await studentIds(req.body.studentIds);
  const offering = await CourseOffering.create({
    courseId: course._id,
    academicYear: requiredText(req.body.academicYear, 'Academic year'),
    semester,
    lecturerIds,
    studentIds,
    timetable: cleanTimetable(req.body.timetable),
  });
  await audit(req, { action: 'offering.create', entity: 'CourseOffering', entityId: offering._id, after: offering });
  const populated = await offering.populate('courseId');
  res.status(201).json({ offering: publicOffering(populated) });
}));

catalogRouter.get('/offerings/:id', wrap(async (req, res) => {
  const offering = await offeringOrThrow(requireId(req.params.id, 'offering id'));
  await assertCanReadOffering(req, offering);
  res.json({ offering: publicOffering(offering) });
}));

catalogRouter.patch('/offerings/:id', requireRoles('admin'), wrap(async (req, res) => {
  const offering = await offeringOrThrow(requireId(req.params.id, 'offering id'));
  const before = offering.toObject();
  if (req.body.academicYear) offering.academicYear = requiredText(req.body.academicYear, 'Academic year');
  if (req.body.semester != null) {
    const semester = Number(req.body.semester);
    if (![1, 2].includes(semester)) throw new HttpError(400, 'Semester must be 1 or 2');
    offering.semester = semester;
  }
  if (req.body.lecturerIds) offering.lecturerIds = await staffIds(req.body.lecturerIds);
  if (req.body.studentIds) offering.studentIds = await studentIds(req.body.studentIds);
  if (req.body.timetable) offering.timetable = cleanTimetable(req.body.timetable);
  await offering.save();
  await audit(req, { action: 'offering.update', entity: 'CourseOffering', entityId: offering._id, before, after: offering });
  res.json({ offering: publicOffering(offering) });
}));

catalogRouter.post('/offerings/:id/students', requireRoles('lecturer', 'admin'), wrap(async (req, res) => {
  const offering = await offeringOrThrow(requireId(req.params.id, 'offering id'));
  assertCanTeach(req.user, offering);
  const ids = [
    ...(await studentIds(req.body.studentIds)),
    ...(await studentsByIndex(req.body.indexNumbers)),
  ];
  if (!ids.length) throw new HttpError(400, 'Add at least one student');
  await CourseOffering.updateOne({ _id: offering._id }, { $addToSet: { studentIds: { $each: ids } } });
  await audit(req, { action: 'offering.enroll', entity: 'CourseOffering', entityId: offering._id, after: { added: ids } });
  const updated = await offeringOrThrow(String(offering._id));
  res.json({ offering: publicOffering(updated) });
}));

catalogRouter.delete('/offerings/:id/students/:studentId', requireRoles('lecturer', 'admin'), wrap(async (req, res) => {
  const offering = await offeringOrThrow(requireId(req.params.id, 'offering id'));
  assertCanTeach(req.user, offering);
  const studentId = requireId(req.params.studentId, 'student id');
  await CourseOffering.updateOne({ _id: offering._id }, { $pull: { studentIds: studentId } });
  await audit(req, { action: 'offering.unenroll', entity: 'CourseOffering', entityId: offering._id, after: { removed: studentId } });
  const updated = await offeringOrThrow(String(offering._id));
  res.json({ offering: publicOffering(updated) });
}));

async function staffIds(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new HttpError(400, 'Lecturers must be a list');
  const ids = value.map((id) => requireId(String(id), 'lecturer id'));
  if (!ids.length) return [];
  const people = await User.find({ _id: { $in: ids }, role: { $in: ['lecturer', 'hod'] }, isActive: true }).select('_id');
  if (people.length !== ids.length) throw new HttpError(400, 'Every lecturer must be an active lecturer or head of department');
  return people.map((person) => person._id);
}

async function studentIds(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new HttpError(400, 'Students must be a list');
  const ids = value.map((id) => requireId(String(id), 'student id'));
  if (!ids.length) return [];
  const people = await User.find({ _id: { $in: ids }, role: 'student', isActive: true }).select('_id');
  if (people.length !== ids.length) throw new HttpError(400, 'Every student id must be an active student');
  return people.map((person) => person._id);
}

async function studentsByIndex(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new HttpError(400, 'Index numbers must be a list');
  const indexNumbers = value.map((item) => String(item).trim()).filter(Boolean);
  if (!indexNumbers.length) return [];
  const people = await User.find({ role: 'student', isActive: true, 'profile.indexNumber': { $in: indexNumbers } }).select('_id profile.indexNumber');
  if (people.length !== indexNumbers.length) throw new HttpError(400, 'One or more index numbers were not found');
  return people.map((person) => person._id);
}
