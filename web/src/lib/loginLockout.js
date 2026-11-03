// Escalating brute-force login lockout. Backed by the `login_lockouts`
// table (sql/migrations/022_add_login_lockouts.sql) rather than an in-memory
// dict - a Vercel serverless function can cold-start on any request, so
// in-process state (what the old Flask app used) wouldn't persist or be
// shared across instances.
//
// Policy: 3 failed attempts locks the account out for 30 seconds. If
// another lockout is triggered within RESET_WINDOW_MS of the *previous*
// lockout ending, the duration escalates to the next rung of the ladder;
// otherwise it resets back to the first rung.
const MAX_ATTEMPTS = 3;
const LADDER_SECONDS = [30, 5 * 60, 15 * 60, 30 * 60, 60 * 60];
const RESET_WINDOW_MS = 5 * 60 * 1000;

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

async function getRow(admin, identifier) {
  const { data } = await admin.from("login_lockouts").select("*").eq("identifier", identifier).maybeSingle();
  return data;
}

// Call before attempting a password check. Returns { locked: false } if
// the attempt may proceed, or { locked: true, secondsRemaining,
// message } if it's currently locked out.
export async function checkLockout(admin, identifier) {
  const row = await getRow(admin, identifier);
  if (!row?.locked_until) return { locked: false };

  const remainingMs = new Date(row.locked_until).getTime() - Date.now();
  if (remainingMs > 0) {
    const secondsRemaining = Math.ceil(remainingMs / 1000);
    return {
      locked: true,
      secondsRemaining,
      message: `Too many failed attempts. Try again in ${formatDuration(secondsRemaining)}.`,
    };
  }

  // Lock just expired - record when, so the next lockout (if any) can
  // tell whether it falls inside the escalation window.
  await admin
    .from("login_lockouts")
    .update({ locked_until: null, last_lockout_ended_at: row.locked_until, updated_at: new Date().toISOString() })
    .eq("identifier", identifier);
  return { locked: false };
}

// Call after a failed password check. Returns { locked: false,
// attemptsRemaining } or { locked: true, secondsRemaining, message }.
export async function recordFailure(admin, identifier) {
  const row = await getRow(admin, identifier);
  const failCount = (row?.fail_count ?? 0) + 1;

  if (failCount <= MAX_ATTEMPTS) {
    await admin.from("login_lockouts").upsert({
      identifier,
      fail_count: failCount,
      lockout_stage: row?.lockout_stage ?? -1,
      last_lockout_ended_at: row?.last_lockout_ended_at ?? null,
      updated_at: new Date().toISOString(),
    });
    return { locked: false, attemptsRemaining: MAX_ATTEMPTS - failCount };
  }

  const withinEscalationWindow =
    row?.last_lockout_ended_at && Date.now() - new Date(row.last_lockout_ended_at).getTime() <= RESET_WINDOW_MS;
  const nextStage = withinEscalationWindow
    ? Math.min((row?.lockout_stage ?? -1) + 1, LADDER_SECONDS.length - 1)
    : 0;
  const durationSeconds = LADDER_SECONDS[nextStage];
  const lockedUntil = new Date(Date.now() + durationSeconds * 1000).toISOString();

  await admin.from("login_lockouts").upsert({
    identifier,
    fail_count: 0,
    locked_until: lockedUntil,
    lockout_stage: nextStage,
    last_lockout_ended_at: row?.last_lockout_ended_at ?? null,
    updated_at: new Date().toISOString(),
  });

  return {
    locked: true,
    secondsRemaining: durationSeconds,
    message: `Too many failed attempts. Locked for ${formatDuration(durationSeconds)}.`,
  };
}

// Call after a successful password check - clears all lockout state.
export async function recordSuccess(admin, identifier) {
  await admin.from("login_lockouts").delete().eq("identifier", identifier);
}

// ---------------------------------------------------------------- quotas
//
// A fixed-window request quota, counted in the same table. Used by
// api/auth/forgot-password, which was an unauthenticated POST with no limit
// at all: anyone could loop it to inbox-bomb the owner, burn the Resend
// quota, and make two Supabase admin round trips per call.
//
// Deliberately NOT the escalating ladder above. That one exists to slow
// password guessing, where every attempt is a guess at a secret. Here
// nothing is being guessed - the limit is on how often the endpoint may be
// used at all - so a flat "N per hour, then nothing" is the right shape.
//
// Identifiers are namespaced ("reset:email:..." / "reset:ip:...") so they
// cannot collide with the login lockout's own rows, which are bare emails.
// `fail_count` carries the count and `locked_until` the end of the window.

const RESET_WINDOW_SECONDS = 60 * 60;
export const RESET_QUOTA_PER_EMAIL = 3;
export const RESET_QUOTA_PER_IP = 10;

/**
 * Counts one request against `key`'s quota. Returns true if it is within
 * quota, false if the quota for the current window is already spent.
 *
 * Two simultaneous requests can both read the same count and each write
 * count+1, so the effective limit can overshoot by the number of requests
 * in flight. That is an acceptable margin for a quota whose job is to stop
 * a loop, and the alternative (a locking RPC) is more machinery than this
 * endpoint warrants.
 */
export async function consumeQuota(admin, key, quota) {
  const identifier = `reset:${key}`;
  const row = await getRow(admin, identifier);
  const now = Date.now();
  const windowOpen = row?.locked_until && new Date(row.locked_until).getTime() > now;

  if (!windowOpen) {
    // First request of a new window - including the very first ever, and
    // the case where the previous window has expired.
    await admin.from("login_lockouts").upsert({
      identifier,
      fail_count: 1,
      locked_until: new Date(now + RESET_WINDOW_SECONDS * 1000).toISOString(),
      lockout_stage: -1,
      updated_at: new Date().toISOString(),
    });
    return true;
  }

  if ((row.fail_count ?? 0) >= quota) {
    // Spent. Not counted again, so hammering the endpoint cannot push the
    // window's end further out.
    return false;
  }

  await admin.from("login_lockouts").upsert({
    identifier,
    fail_count: (row.fail_count ?? 0) + 1,
    locked_until: row.locked_until,
    lockout_stage: -1,
    updated_at: new Date().toISOString(),
  });
  return true;
}

/**
 * Best-effort client IP. On Vercel x-forwarded-for is set by the edge and
 * its first entry is the real client; anywhere else a client can forge the
 * header outright, which is why the per-email quota is the one that has to
 * hold on its own.
 */
export function clientIp(request) {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}
