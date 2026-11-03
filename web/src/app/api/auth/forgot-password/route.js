import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  RESET_QUOTA_PER_EMAIL,
  RESET_QUOTA_PER_IP,
  clientIp,
  consumeQuota,
} from "@/lib/loginLockout";

// Public route (allow-listed in proxy.js) - unauthenticated visitors must be
// able to reach this. Only the owner's own email can ever trigger a reset:
// staff accounts are provisioned and managed by the owner in Settings, so a
// staff member forgetting their password is handled by the owner resetting
// it for them there, not by a self-service email link to an inbox the owner
// may not even control.
const GENERIC_MESSAGE =
  "If that's the owner's account email, reset instructions have been sent to it.";

export async function POST(request) {
  let email;
  try {
    ({ email } = await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const submitted = (email ?? "").trim().toLowerCase();
  if (!submitted) {
    return NextResponse.json({ error: "Enter an email address." }, { status: 400 });
  }

  if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM_EMAIL) {
    return NextResponse.json(
      { error: "Email sending isn't configured yet (RESEND_API_KEY / RESEND_FROM_EMAIL)." },
      { status: 500 }
    );
  }

  const admin = createAdminClient();

  // Rate limited BEFORE the owner lookup, and answered with exactly the same
  // body as every other outcome. Doing it in this order is what keeps the
  // limiter from becoming an enumeration oracle: the counters move on every
  // request regardless of whether the address matches anything, so a caller
  // cannot tell "quota spent" from "wrong email" from "mail sent".
  //
  // Unlimited before this, so anyone could loop the endpoint to inbox-bomb
  // the owner and burn the Resend quota. Three per address and ten per IP
  // per hour; the per-address one is the limit that has to hold, since
  // x-forwarded-for is only trustworthy behind the platform edge.
  // Both counted, not short-circuited: && would skip the IP tally whenever
  // the address quota was already spent, so hammering one address would
  // never accrue against the caller's IP.
  const emailWithinQuota = await consumeQuota(admin, `email:${submitted}`, RESET_QUOTA_PER_EMAIL);
  const ipWithinQuota = await consumeQuota(admin, `ip:${clientIp(request)}`, RESET_QUOTA_PER_IP);
  if (!emailWithinQuota || !ipWithinQuota) {
    return NextResponse.json({ message: GENERIC_MESSAGE });
  }

  const { data: owners } = await admin.from("profiles").select("id").eq("role", "owner").limit(1);
  const ownerId = owners?.[0]?.id;
  const ownerEmail = ownerId ? (await admin.auth.admin.getUserById(ownerId)).data?.user?.email : null;

  // Same response whether the email is unknown, belongs to a staff account,
  // or genuinely matches the owner - this can't be used to probe which
  // emails exist in the system.
  if (!ownerEmail || ownerEmail.toLowerCase() !== submitted) {
    return NextResponse.json({ message: GENERIC_MESSAGE });
  }

  const { origin } = new URL(request.url);
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "recovery",
    email: ownerEmail,
    options: { redirectTo: `${origin}/auth/confirm?next=/reset-password` },
  });

  if (linkError || !linkData?.properties?.hashed_token) {
    console.error("forgot-password: generateLink failed", linkError);
    return NextResponse.json({ message: GENERIC_MESSAGE });
  }

  const confirmUrl = `${origin}/auth/confirm?token_hash=${linkData.properties.hashed_token}&type=recovery&next=/reset-password`;

  const resendRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL,
      to: ownerEmail,
      subject: "Reset your J1SPA Analytics password",
      html: `
        <p>A password reset was requested for your J1SPA Analytics owner account.</p>
        <p><a href="${confirmUrl}">Click here to set a new password</a></p>
        <p>This link will expire shortly. If you didn't request this, you can safely ignore this email.</p>
      `,
    }),
  });

  if (!resendRes.ok) {
    console.error("forgot-password: Resend send failed", resendRes.status, await resendRes.text());
  }

  return NextResponse.json({ message: GENERIC_MESSAGE });
}
