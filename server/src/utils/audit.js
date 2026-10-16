import { AuditLog } from '../models.js';

const HIDDEN = new Set(['passwordHash', 'refreshTokens', 'resetOtpHash', 'vectorEnc', 'embeddings']);

function clean(value, depth = 0) {
  if (value == null || depth > 4) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => clean(item, depth + 1));
  if (typeof value !== 'object') return value;
  if (value._bsontype || value instanceof Date) return value;
  const output = {};
  for (const [key, item] of Object.entries(value.toObject ? value.toObject() : value)) {
    if (HIDDEN.has(key)) continue;
    output[key] = clean(item, depth + 1);
  }
  return output;
}

export async function audit(req, { action, entity, entityId, before, after }) {
  await AuditLog.create({
    actorId: req.user?.sub || req.actorId,
    action,
    entity,
    entityId,
    before: before ? clean(before) : undefined,
    after: after ? clean(after) : undefined,
    ip: req.ip,
  });
}
