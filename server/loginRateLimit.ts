const windowMs = 60_000;
const attemptsPerIp = 20;
const concurrentChecks = 4;
const maximumIps = 10_000;

type Admission = { allowed: true; release: () => void } | { allowed: false; retryAfterSeconds: number };

// Admission happens before scrypt and includes in-flight requests, so changing
// an email or submitting a parallel burst cannot bypass the IP work budget.
export function createLoginLimiter(now = Date.now): (ip: string) => Admission {
  const windows = new Map<string, { count: number; until: number }>();
  let active = 0;
  return ip => {
    const timestamp = now();
    for (const [key, value] of windows) if (value.until <= timestamp) windows.delete(key);
    const previous = windows.get(ip);
    if (previous && previous.count >= attemptsPerIp) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((previous.until - timestamp) / 1000)) };
    }
    if (active >= concurrentChecks || !previous && windows.size >= maximumIps) return { allowed: false, retryAfterSeconds: 1 };
    const current = previous || { count: 0, until: timestamp + windowMs };
    current.count++;
    windows.set(ip, current);
    active++;
    let released = false;
    return { allowed: true, release: () => { if (!released) { released = true; active--; } } };
  };
}
