import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getKpis, getMarginTrend, getProductPerformance, summarizeDashboard } from "@/lib/analytics";
import { theme } from "./theme";
import Sidebar from "./Sidebar";
import HeroStatCard from "./HeroStatCard";
import Card from "./Card";
import GrossNetChart from "./GrossNetChart";
import BestSellingChart from "./BestSellingChart";
import StockByCategoryChart from "./StockByCategoryChart";
import TrackingTable from "./TrackingTable";

export const metadata = { title: "Dashboard" };

export default async function DashboardPage() {
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

  const [kpis, performance, marginTrend] = await Promise.all([
    getKpis(supabase),
    getProductPerformance(supabase),
    getMarginTrend(supabase),
  ]);
  // Pinned to Manila time: the server (Vercel) runs in UTC, which would show
  // yesterday's date for the first 8 hours of each Philippine day.
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "Asia/Manila",
  });
  const delta = kpis.grossProfitMarginDeltaPct;
  const deltaText = `${delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(2)}% vs previous 90 days`;
  const summary = summarizeDashboard(performance);

  return (
    <div className="flex flex-col md:flex-row h-screen overflow-hidden font-sans" style={{ backgroundColor: theme.pageBg }}>
      <Sidebar active="dashboard" fullName={profile.full_name} role={profile.role} />

      <main className="flex-1 overflow-y-auto p-4 md:p-8">
        <div className="mb-6 flex items-start justify-between">
          <div>
            <h1 className="text-xl font-semibold" style={{ color: theme.textPrimary }}>
              Business Analytics &amp; Sales Intelligence
            </h1>
            <p className="text-sm" style={{ color: theme.textMuted }}>
              {today}
            </p>
          </div>
        </div>

        <div className="mb-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
          <HeroStatCard
            label="Gross profit margin"
            value={`${kpis.grossProfitMarginPct}%`}
            deltaText={deltaText}
            trend={marginTrend}
            secondary={[
              {
                label: "Total units in stock",
                // Same en-US formatting as the Stock by Category donut's centre
                // total, so the two read identically and not merely equal.
                value: summary.totalUnitsInStock.toLocaleString("en-US"),
                href: "/products",
              },
              { label: "Restocking items (critical)", value: summary.restockingCritical, href: "/decision-support" },
            ]}
          />
          <Card title="Stock by Category" subtitle="Share of units on hand">
            <StockByCategoryChart data={summary.categoryTotals} totalUnits={summary.totalUnitsInStock} />
          </Card>
        </div>

        <div className="mb-6 grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <Card title="Gross & Net Sales" subtitle="Sales + services combined">
            <GrossNetChart />
          </Card>
          <Card title="Top 5 Best-Selling Parts" subtitle="Trailing 90-day unit volume">
            <BestSellingChart data={summary.topSelling} />
          </Card>
        </div>

        <TrackingTable rows={performance} />
      </main>
    </div>
  );
}
