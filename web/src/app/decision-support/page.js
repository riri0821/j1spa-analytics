import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { evaluateDecisionSupport } from "@/lib/decisionSupport";
import { theme } from "../dashboard/theme";
import Sidebar from "../dashboard/Sidebar";
import RefreshButton from "../dashboard/RefreshButton";
import AdvisoryList from "./AdvisoryList";

// Manila, not the server's zone (UTC on Vercel), the same way the
// dashboard's own date line is pinned.
function manilaDateTime(ts) {
  return new Date(ts).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Manila",
  });
}

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
          <div className="mt-10 flex flex-col items-end gap-1.5">
            <RefreshButton />
            {/* A run only records a batch when the advice itself changes, so
                this is the age of the advice, not of the page. Absent while
                nothing is recorded - an empty advisory set cannot be stored
                as a batch of no rows. */}
            {result.lastChangedAt && (
              <p className="text-xs whitespace-nowrap" style={{ color: theme.textMuted }}>
                Advisories last changed: {manilaDateTime(result.lastChangedAt)}
              </p>
            )}
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
        />
      </main>
    </div>
  );
}
