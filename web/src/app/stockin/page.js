import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { theme } from "../dashboard/theme";
import Sidebar from "../dashboard/Sidebar";
import StockInScreen from "./StockInScreen";

export const metadata = { title: "Stock In" };

export default async function StockInPage() {
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

  if (profile?.role !== "owner") redirect("/sales");

  return (
    <div
      className="flex flex-col md:flex-row h-screen overflow-hidden font-sans"
      style={{ backgroundColor: theme.pageBg }}
    >
      <Sidebar active="stockin" fullName={profile.full_name} role={profile.role} />

      <main className="flex-1 overflow-y-auto p-4 md:p-8">
        <div className="mb-6">
          <h1 className="text-xl font-semibold" style={{ color: theme.textPrimary }}>
            Stock-in
          </h1>
          <p className="text-sm" style={{ color: theme.textMuted }}>
            A positive quantity records stock received; a negative quantity records a correction.
          </p>
        </div>
        <StockInScreen />
      </main>
    </div>
  );
}
