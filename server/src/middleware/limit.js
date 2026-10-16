const buckets = new Map();

export function limitKey(max, windowMs) {
  return (req, res, next) => {
    if (buckets.size > 5000) buckets.clear();
    const key = req.user?.sub || req.ip;
    const now = Date.now();
    const stamps = (buckets.get(key) || []).filter((stamp) => now - stamp < windowMs);
    if (stamps.length >= max) {
      return res.status(429).json({ error: 'Too many attempts. Wait a moment and try again.' });
    }
    stamps.push(now);
    buckets.set(key, stamps);
    return next();
  };
}
