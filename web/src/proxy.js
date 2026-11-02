import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";

// Next.js 16 renamed `middleware.js` -> `proxy.js` (same job: runs before
// every matched request). This refreshes the Supabase auth cookie on each
// request and redirects signed-out users to /login.
export async function proxy(request) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // /auth/confirm verifies a password-reset link for a not-yet-signed-in
  // visitor, and /api/auth/forgot-password is the public form submission
  // that sends that link - both have to be reachable with no session.
  const isPublicPath = [
    "/login",
    "/auth/confirm",
    "/api/auth/forgot-password",
    "/api/auth/login",
  ].some((p) => request.nextUrl.pathname.startsWith(p));

  if (!user && !isPublicPath) {
    // A fresh URL, not request.nextUrl.clone() - cloning carries over every
    // query param from the original request, including Next's internal
    // `_rsc=...` prefetch param, which would otherwise leak into the
    // address bar as http://.../login?_rsc=...
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // A deactivated account (Settings -> Deactivate) still has a valid
  // Supabase session - Supabase Auth doesn't know about our own
  // profiles.is_active flag, so this needs an explicit check on every
  // request to actually kick them out, not just block future logins.
  if (user && !isPublicPath) {
    const { data: profile } = await supabase.from("profiles").select("is_active").eq("id", user.id).single();
    if (profile && !profile.is_active) {
      await supabase.auth.signOut();
      const url = new URL("/login", request.url);
      url.searchParams.set("deactivated", "1");
      return NextResponse.redirect(url);
    }
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
