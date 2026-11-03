import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Set a new password" };

// The page itself is a Client Component and cannot do a server-side role
// check, so the gate lives here - the same reason login/layout.js exists.
//
// This screen says "Choose a new password for the owner account", and the
// whole reset flow (api/auth/forgot-password -> /auth/confirm) only ever
// issues a recovery link for the owner's own address. Staff credentials are
// set by the owner in Settings; a staff member who reached this page would
// have changed their own password to something the owner does not know,
// which is the opposite of how those accounts are meant to work.
//
// A session is already guaranteed by proxy.js, which does not allow-list
// /reset-password - this only narrows it to the owner.
export default async function ResetPasswordLayout({ children }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "owner") redirect("/sales");

  return children;
}
