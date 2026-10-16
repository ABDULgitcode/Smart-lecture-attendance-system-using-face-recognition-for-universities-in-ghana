import mongoose from 'mongoose';

const { Schema, model } = mongoose;

const userSchema = new Schema(
  {
    role: { type: String, enum: ['student', 'lecturer', 'hod', 'admin'], required: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    profile: {
      firstName: { type: String, trim: true },
      lastName: { type: String, trim: true },
      phone: { type: String, trim: true },
      indexNumber: { type: String, trim: true },
      staffId: { type: String, trim: true },
      departmentId: { type: Schema.Types.ObjectId, ref: 'Department' },
      programme: { type: String, trim: true },
      level: Number,
    },
    isActive: { type: Boolean, default: true },
    refreshTokens: [{ tokenHash: String, expiresAt: Date }],
    resetOtpHash: String,
    resetOtpExpires: Date,
    lastActiveAt: Date,
  },
  { timestamps: true },
);
userSchema.index({ 'profile.indexNumber': 1 }, { unique: true, sparse: true });
userSchema.index({ 'profile.staffId': 1 }, { unique: true, sparse: true });

const faceSchema = new Schema(
  {
    studentId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    embeddings: [
      {
        vectorEnc: { type: String, required: true },
        quality: Number,
        capturedAt: Date,
      },
    ],
    modelVersion: String,
    consent: {
      given: Boolean,
      givenAt: Date,
      policyVersion: String,
    },
  },
  { timestamps: true },
);

const departmentSchema = new Schema({
  name: { type: String, required: true, trim: true },
  code: { type: String, required: true, trim: true, uppercase: true, unique: true },
  facultyName: { type: String, trim: true },
});

const courseSchema = new Schema({
  code: { type: String, required: true, trim: true },
  title: { type: String, required: true, trim: true },
  departmentId: { type: Schema.Types.ObjectId, ref: 'Department', required: true },
  creditHours: { type: Number, default: 3 },
  rules: {
    lateAfterMinutes: { type: Number, default: 10 },
    minAttendancePercent: { type: Number, default: 75 },
  },
});

const offeringSchema = new Schema({
  courseId: { type: Schema.Types.ObjectId, ref: 'Course', required: true },
  academicYear: { type: String, required: true },
  semester: { type: Number, required: true },
  lecturerIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  studentIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  timetable: [
    {
      day: String,
      start: String,
      end: String,
      venueId: { type: Schema.Types.ObjectId, ref: 'Venue' },
    },
  ],
});
offeringSchema.index({ academicYear: 1, semester: 1 });
offeringSchema.index({ studentIds: 1 });
offeringSchema.index({ lecturerIds: 1 });

const venueSchema = new Schema({
  name: { type: String, required: true, trim: true },
  building: { type: String, trim: true },
  capacity: Number,
  geo: {
    type: { type: String, enum: ['Point'] },
    coordinates: { type: [Number] },
  },
});
venueSchema.index({ geo: '2dsphere' });

const sessionSchema = new Schema({
  offeringId: { type: Schema.Types.ObjectId, ref: 'CourseOffering', required: true },
  venueId: { type: Schema.Types.ObjectId, ref: 'Venue' },
  lecturerId: { type: Schema.Types.ObjectId, ref: 'User' },
  startedAt: { type: Date, required: true },
  endedAt: Date,
  status: { type: String, enum: ['open', 'closed'], default: 'open' },
  deviceId: { type: Schema.Types.ObjectId, ref: 'Device' },
  sessionCode: { type: String, required: true },
  allowCodeCheckIn: { type: Boolean, default: true },
  lateAfterMinutes: { type: Number, default: 10 },
  stats: {
    present: { type: Number, default: 0 },
    late: { type: Number, default: 0 },
    absent: { type: Number, default: 0 },
    excused: { type: Number, default: 0 },
  },
  suspicious: [{ at: Date, reason: String }],
});
sessionSchema.index({ offeringId: 1, startedAt: -1 });

const recordSchema = new Schema({
  sessionId: { type: Schema.Types.ObjectId, ref: 'LectureSession', required: true },
  offeringId: { type: Schema.Types.ObjectId, ref: 'CourseOffering', required: true },
  studentId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  status: { type: String, enum: ['present', 'late', 'absent', 'excused'], required: true },
  method: { type: String, enum: ['face', 'manual', 'qr'], required: true },
  confidence: Number,
  livenessPassed: Boolean,
  markedAt: { type: Date, required: true },
  syncedAt: Date,
  overriddenBy: { type: Schema.Types.ObjectId, ref: 'User' },
  overrideReason: String,
});
recordSchema.index({ sessionId: 1, studentId: 1 }, { unique: true });
recordSchema.index({ studentId: 1, offeringId: 1 });

const disputeSchema = new Schema(
  {
    recordId: { type: Schema.Types.ObjectId, ref: 'AttendanceRecord', required: true },
    studentId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reason: { type: String, required: true },
    requestedStatus: { type: String, enum: ['present', 'late', 'absent', 'excused'], default: 'present' },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    resolutionNote: String,
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

const deviceSchema = new Schema({
  name: { type: String, required: true, trim: true },
  type: { type: String, enum: ['tablet', 'phone', 'camera'], default: 'tablet' },
  venueId: { type: Schema.Types.ObjectId, ref: 'Venue' },
  apiKeyHash: { type: String, required: true },
  lastSeenAt: Date,
});

const notificationSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, required: true },
  message: { type: String, required: true },
  read: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});
notificationSchema.index({ userId: 1, createdAt: -1 });

const auditSchema = new Schema({
  actorId: { type: Schema.Types.ObjectId, ref: 'User' },
  action: { type: String, required: true },
  entity: { type: String, required: true },
  entityId: Schema.Types.ObjectId,
  before: Schema.Types.Mixed,
  after: Schema.Types.Mixed,
  ip: String,
  createdAt: { type: Date, default: Date.now },
});
auditSchema.index({ entityId: 1, createdAt: -1 });
auditSchema.index({ createdAt: -1 });

export const User = model('User', userSchema, 'users');
export const FaceTemplate = model('FaceTemplate', faceSchema, 'faceTemplates');
export const Department = model('Department', departmentSchema, 'departments');
export const Course = model('Course', courseSchema, 'courses');
export const CourseOffering = model('CourseOffering', offeringSchema, 'courseOfferings');
export const Venue = model('Venue', venueSchema, 'venues');
export const LectureSession = model('LectureSession', sessionSchema, 'sessions');
export const AttendanceRecord = model('AttendanceRecord', recordSchema, 'attendanceRecords');
export const Dispute = model('Dispute', disputeSchema, 'disputes');
export const Device = model('Device', deviceSchema, 'devices');
export const Notification = model('Notification', notificationSchema, 'notifications');
export const AuditLog = model('AuditLog', auditSchema, 'auditLogs');
