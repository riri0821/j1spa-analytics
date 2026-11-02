import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Keeps the Render forecasting service running so nobody's "Run comparison"
// has to pay for starting it. Render's free tier spins the instance down
// after ~15 minutes idle, and the next request then waits 30-50s for a cold
// boot - by far the largest part of a slow forecast, next to the ~0.6s the
// model fitting itself costs.
//
// Two callers, two ways in:
//   - a scheduler (Vercel Cron, a GitHub Actions workflow, any uptime
//     pinger) presenting `Authorization: Bearer $CRON_SECRET`, every ~10
//     minutes - see README;
//   - the signed-in owner's browser when /forecasting mounts, so the spin-up
//     overlaps with them picking a SKU rather than with their first click.
//
// Only hits the service's unauthenticated /health endpoint: no SKU, no sales
// data, and FORECAST_SERVICE_KEY is not needed or sent. proxy.js lets
// /api/cron/* through unauthenticated precisely because this authorizes
// itself below.

export const maxDuration = 60; // a cold Render boot can take 30-50s

const TIMEOUT_MS = 55_000;
const COLD_START_MS = 5_000; // slower than this and we absorbed a real boot

async function isOwner() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return false;
    const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
    return profile?.role === "owner";
  } catch {
    return false; // no session cookie at all (the scheduler's path)
  }
}

export async function GET(request) {
  const secret = process.env.CRON_SECRET;
  const fromScheduler = Boolean(secret) && request.headers.get("authorization") === `Bearer ${secret}`;

  if (!fromScheduler && !(await isOwner())) {
    return NextResponse.json({ error: "Not authorized." }, { status: 401 });
  }

  const base = process.env.FORECAST_SERVICE_URL;
  if (!base) {
    return NextResponse.json({ error: "FORECAST_SERVICE_URL is not set." }, { status: 500 });
  }

  const started = Date.now();
  try {
    const upstream = await fetch(new URL("/health", base), {
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const elapsed_ms = Date.now() - started;
    return NextResponse.json({
      warm: upstream.ok,
      status: upstream.status,
      elapsed_ms,
      cold_start: elapsed_ms > COLD_START_MS,
    });
  } catch (err) {
    return NextResponse.json(
      {
        warm: false,
        elapsed_ms: Date.now() - started,
        error:
          err?.name === "TimeoutError"
            ? "Timed out waiting for the forecasting service."
            : "Forecasting service is unreachable.",
      },
      { status: 502 }
    );
  }
}
