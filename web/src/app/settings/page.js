import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { theme } from "../dashboard/theme";
import Sidebar from "../dashboard/Sidebar";
import SettingsScreen from "./SettingsScreen";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: profile } = await supabase.from("profiles").select("role, full_name").eq("id", user.id).single();
  if (profile?.role !== "owner") redirect("/sales");

  const { data: users } = await supabase
    .from("profiles")
    .select("id, username, full_name, role, is_active, created_at")
    .order("role")
    .order("username");

  return (
    <div className="flex flex-col md:flex-row h-screen overflow-hidden font-sans" style={{ backgroundColor: theme.pageBg }}>
      <Sidebar active="settings" fullName={profile.full_name} role={profile.role} />

      <main className="flex-1 overflow-y-auto p-8">
        <h1 className="mb-6 text-xl font-semibold" style={{ color: theme.textPrimary }}>
          Settings
        </h1>
        <SettingsScreen currentUserId={user.id} currentEmail={user.email} initialUsers={users ?? []} />
      </main>
    </div>
  );
}
