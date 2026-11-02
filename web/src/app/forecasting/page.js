import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { theme } from "../dashboard/theme";
import Sidebar from "../dashboard/Sidebar";
import ForecastWorkspace from "./ForecastWorkspace";

const PAGE_SIZE = 1000; // PostgREST's per-request ceiling

export default async function ForecastingPage({ searchParams }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: profile } = await supabase.from("profiles").select("role, full_name").eq("id", user.id).single();
  if (profile?.role !== "owner") redirect("/sales");

  // category drives the picker's first select; paged because a plain select
  // stops at PostgREST's 1000-row default once the catalog outgrows it.
  const products = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("products")
      .select("sku, name, category")
      .eq("is_active", true)
      .order("name")
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) {
      console.error("product list failed:", error.message);
      break;
    }
    products.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) break;
  }

  // The stock ledger links here with ?sku=, so the picker opens on that
  // product - CategorySkuSelect derives its category from the SKU itself.
  const { sku } = await searchParams;
  const requested = products.find((p) => p.sku.toLowerCase() === (sku ?? "").trim().toLowerCase());

  return (
    <div className="flex flex-col md:flex-row h-screen overflow-hidden font-sans" style={{ backgroundColor: theme.pageBg }}>
      <Sidebar active="forecasting" fullName={profile.full_name} role={profile.role} />
      <main className="flex-1 overflow-y-auto p-8">
        <h1 className="text-xl font-semibold" style={{ color: theme.textPrimary }}>
          Time-Series Demand Forecasting Workspace
        </h1>
        <p className="mb-6 text-sm" style={{ color: theme.textMuted }}>
          Compare five forecasting models per item over a chosen horizon.
        </p>
        <ForecastWorkspace products={products} initialSku={requested?.sku ?? ""} />
      </main>
    </div>
  );
}
