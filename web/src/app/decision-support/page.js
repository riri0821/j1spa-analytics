import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { evaluateDecisionSupport } from "@/lib/decisionSupport";
import { theme, STATUS } from "../dashboard/theme";
import Sidebar from "../dashboard/Sidebar";
import RefreshButton from "../dashboard/RefreshButton";
import AdvisoryList from "./AdvisoryList";

// Advisory severity uses the same reserved status hexes as the dashboard's
// Low stock/Overstocked/Stable badges (dataviz skill) - "critical" maps to
// the same red as "Low stock" there, "warning" to the same amber.
const SEVERITY_COLOR = {
  critical: STATUS["Low stock"],
  warning: STATUS.Overstocked,
  info: STATUS.Stable,
};

export default async function DecisionSupportPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: profile } = await supabase.from("profiles").select("role, full_name").eq("id", user.id).single();
  if (profile?.role !== "owner") redirect("/sales");

  const result = await evaluateDecisionSupport(supabase);

  return (
    <div className="flex flex-col md:flex-row h-screen overflow-hidden font-sans" style={{ backgroundColor: theme.pageBg }}>
      <Sidebar active="decision-support" fullName={profile.full_name} role={profile.role} />

      <main className="flex-1 overflow-y-auto p-8">
        <div className="mb-6 flex items-start justify-between">
          <div>
            <h1 className="text-xl font-semibold" style={{ color: theme.textPrimary }}>
              Decision Support Advisories
            </h1>
            <p className="text-sm" style={{ color: theme.textMuted }}>
              Advisory only - the system makes no automatic reorder or pricing changes.
            </p>
          </div>
          <div className="mt-10">
            <RefreshButton />
          </div>
        </div>

        <AdvisoryList
          advisories={result.advisories}
          byType={result.byType}
          unitsByType={result.unitsByType}
          noAction={result.noAction}
          noActionUnits={result.noActionUnits}
          activeProductCount={result.activeProductCount}
          totalUnits={result.totalUnits}
          severityColor={SEVERITY_COLOR}
        />
      </main>
    </div>
  );
}
