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
