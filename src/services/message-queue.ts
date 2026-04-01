const RATE_LIMIT_MAX = 15;
const RATE_LIMIT_TTL = 60; // 1 minute
const PROCESSING_LOCK_TTL = 30; // 30 seconds safety timeout

export interface QueueResult {
  action: 'process' | 'queued' | 'rate_limited';
  queuedMessages?: string[];
}

/**
 * Check rate limit for abuse detection.
 * Returns true if the message should be dropped (rate limited).
 */
export async function isRateLimited(
  kv: KVNamespace,
  phoneNumber: string,
): Promise<{ limited: boolean; isFirstHit: boolean }> {
  const key = `msgcount:${phoneNumber}`;
  const currentStr = await kv.get(key);
  const current = currentStr ? parseInt(currentStr, 10) : 0;

  if (current >= RATE_LIMIT_MAX) {
    return { limited: true, isFirstHit: current === RATE_LIMIT_MAX };
  }

  // Increment counter with TTL
  await kv.put(key, String(current + 1), { expirationTtl: RATE_LIMIT_TTL });
  return { limited: false, isFirstHit: false };
}

/**
 * Try to acquire a processing lock for a phone number.
 * If already processing, queue the message instead.
 */
export async function tryAcquireOrQueue(
  kv: KVNamespace,
  phoneNumber: string,
  messageText: string,
): Promise<QueueResult> {
  const lockKey = `processing:${phoneNumber}`;
  const queueKey = `queue:${phoneNumber}`;

  const isProcessing = await kv.get(lockKey);

  if (isProcessing) {
    // Agent is already working on this phone number — queue the message
    const queue = await kv.get<string[]>(queueKey, 'json') ?? [];
    queue.push(messageText);
    await kv.put(queueKey, JSON.stringify(queue));
    return { action: 'queued' };
  }

  // Acquire lock with safety TTL
  await kv.put(lockKey, '1', { expirationTtl: PROCESSING_LOCK_TTL });
  return { action: 'process' };
}

/**
 * Release the processing lock and drain any queued messages.
 * Returns queued messages if any were waiting.
 */
export async function releaseAndDrain(
  kv: KVNamespace,
  phoneNumber: string,
): Promise<string[]> {
  const lockKey = `processing:${phoneNumber}`;
  const queueKey = `queue:${phoneNumber}`;

  // Grab and clear the queue atomically (as close as KV allows)
  const queued = await kv.get<string[]>(queueKey, 'json') ?? [];
  await Promise.all([
    kv.delete(lockKey),
    kv.delete(queueKey),
  ]);

  return queued;
}
