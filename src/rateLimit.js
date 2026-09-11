/**
 * Rate limiting simple par utilisateur (par ID Discord).
 */
const buckets = new Map();
const ONE_MINUTE_MS = 60 * 1000;

export function checkRateLimit(userId, limitPerMinute) {
  const now = Date.now();
  let bucket = buckets.get(userId);
  if (!bucket) {
    bucket = { count: 0, resetAt: now + ONE_MINUTE_MS };
    buckets.set(userId, bucket);
  }
  if (now >= bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + ONE_MINUTE_MS;
  }
  bucket.count++;
  if (bucket.count > limitPerMinute) {
    return { allowed: false, retryAfterMs: bucket.resetAt - now };
  }
  return { allowed: true };
}

export function cleanupOldBuckets() {
  const now = Date.now();
  for (const [userId, bucket] of buckets.entries()) {
    if (now >= bucket.resetAt) buckets.delete(userId);
  }
}

let intervalId;
export function startRateLimitCleanup() {
  if (intervalId) return;
  intervalId = setInterval(cleanupOldBuckets, ONE_MINUTE_MS);
}
export function stopRateLimitCleanup() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
