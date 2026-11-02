import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { theme } from "../dashboard/theme";
import Sidebar from "../dashboard/Sidebar";
import SalesScreen from "./SalesScreen";
import ExportButton from "./ExportButton";

export default async function SalesPage({ searchParams }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, full_name")
    .eq("id", user.id)
    .single();

  // The sidebar's "Service" entry is this same page deep-linked to the
  // services tab, so the nav highlight has to follow ?tab= too.
  const { tab } = await searchParams;
  const initialTab = tab === "services" ? "services" : "entry";

  return (
    <div
      className="flex flex-col md:flex-row h-screen overflow-hidden font-sans"
      style={{ backgroundColor: theme.pageBg }}
    >
      <Sidebar
        active={initialTab === "services" ? "services" : "sales"}
        fullName={profile?.full_name}
        role={profile?.role}
      />

      <main className="flex-1 overflow-y-auto p-4 md:p-8">
        <div className="mb-6 flex items-start justify-between">
          <div>
            <h1 className="text-xl font-semibold" style={{ color: theme.textPrimary }}>
              Sales
            </h1>
            <p className="text-sm" style={{ color: theme.textMuted }}>
              {profile?.full_name} · Unit cost and gross profit are not shown on this screen.
            </p>
          </div>
          <div className="mt-10 flex items-center gap-3">
            <ExportButton role={profile?.role} />
          </div>
        </div>

        <SalesScreen userId={user.id} role={profile?.role} initialTab={initialTab} />
      </main>
    </div>
  );
}
