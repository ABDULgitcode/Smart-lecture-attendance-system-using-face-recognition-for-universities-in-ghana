import dotenv from 'dotenv';

dotenv.config();

function text(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

export const config = {
  port: Number(text('PORT', '4000')),
  mongoUri: text('MONGO_URI', 'mongodb://127.0.0.1:27017/lecture_attendance'),
  accessSecret: text('JWT_ACCESS_SECRET', 'dev-access-secret-change-me'),
  refreshSecret: text('JWT_REFRESH_SECRET', 'dev-refresh-secret-change-me'),
  embeddingKey: text(
    'EMBEDDING_KEY',
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  ),
  faceUrl: text('FACE_SERVICE_URL', 'http://127.0.0.1:8000'),
  faceKey: text('FACE_INTERNAL_KEY', 'dev-face-key-change-me'),
  match: {
    threshold: Number(text('MATCH_THRESHOLD', '0.75')),
    margin: Number(text('MATCH_MARGIN', '0.06')),
  },
  universityName: text('UNIVERSITY_NAME', 'University of Ghana'),
  policyVersion: text('POLICY_VERSION', '1.0'),
  exposeOtp: text('EXPOSE_OTP', 'true') === 'true',
  signupKey: text('STUDENT_SIGNUP_KEY', 'legon-pilot'),
  inactivityMinutes: Number(text('INACTIVITY_MINUTES', '30')),
};

const key = Buffer.from(config.embeddingKey, 'hex');
if (key.length !== 32) {
  throw new Error('EMBEDDING_KEY must be 64 hex characters');
}
