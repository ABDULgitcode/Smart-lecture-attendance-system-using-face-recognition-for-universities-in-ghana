import mongoose from 'mongoose';
import { connectDb } from './db.js';
import { Course, CourseOffering, Department, User, Venue } from './models.js';
import { createUser } from './services/users.js';

async function seed() {
  await connectDb();
  const existing = await User.findOne({ email: 'admin@ug.edu.gh' });
  if (existing) {
    console.log('Already seeded.');
    console.log('Lecturer: lecturer@ug.edu.gh / Lecturer12345');
    console.log('Student:  ama@ug.edu.gh / Student12345');
    await mongoose.disconnect();
    return;
  }

  const admin = await createUser({
    role: 'admin',
    email: 'admin@ug.edu.gh',
    password: 'Admin12345',
    profile: { firstName: 'Abena', lastName: 'Admin', staffId: 'STAFF-001' },
  });
  const department = await Department.create({
    name: 'Computer Science',
    code: 'CS',
    facultyName: 'College of Basic and Applied Sciences',
  });
  const hod = await createUser({
    role: 'hod',
    email: 'hod@ug.edu.gh',
    password: 'Hod12345',
    profile: { firstName: 'Yaw', lastName: 'Mensah', staffId: 'STAFF-014', departmentId: department._id },
  });
  const lecturer = await createUser({
    role: 'lecturer',
    email: 'lecturer@ug.edu.gh',
    password: 'Lecturer12345',
    profile: { firstName: 'Akua', lastName: 'Boateng', staffId: 'STAFF-088', departmentId: department._id },
  });
  const students = [];
  const people = [
    ['Ama', 'Mensah', 'ama@ug.edu.gh', '10203040'],
    ['Kojo', 'Owusu', 'kojo@ug.edu.gh', '10203041'],
    ['Efua', 'Boateng', 'efua@ug.edu.gh', '10203042'],
  ];
  for (const [firstName, lastName, email, indexNumber] of people) {
    students.push(await createUser({
      role: 'student',
      email,
      password: 'Student12345',
      profile: {
        firstName,
        lastName,
        indexNumber,
        programme: 'BSc Computer Science',
        level: 300,
        departmentId: department._id,
      },
    }));
  }
  const venue = await Venue.create({
    name: 'Nightingale Lecture Theatre',
    building: 'Legon',
    capacity: 300,
    geo: { type: 'Point', coordinates: [-0.1869, 5.6508] },
  });
  const course = await Course.create({
    code: 'CS 301',
    title: 'Introduction to Software Engineering',
    departmentId: department._id,
    creditHours: 3,
    rules: { lateAfterMinutes: 10, minAttendancePercent: 75 },
  });
  await CourseOffering.create({
    courseId: course._id,
    academicYear: '2026/2027',
    semester: 1,
    lecturerIds: [lecturer._id],
    studentIds: students.map((student) => student._id),
    timetable: [{ day: 'Mon', start: '08:00', end: '10:00', venueId: venue._id }],
  });

  console.log('Seeded the University of Ghana pilot.');
  console.log(`Admin:    ${admin.email} / Admin12345`);
  console.log(`HOD:      ${hod.email} / Hod12345`);
  console.log('Lecturer: lecturer@ug.edu.gh / Lecturer12345');
  console.log('Students: ama@ug.edu.gh, kojo@ug.edu.gh, efua@ug.edu.gh / Student12345');
  await mongoose.disconnect();
}

seed().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
