"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { theme } from "../dashboard/theme";
import StockInTracker from "./StockInTracker";
import CategoryProductPicker from "@/components/CategoryProductPicker";

const inputClass = "rounded border px-3 py-1.5 text-sm";
const inputStyle = { backgroundColor: theme.cardBgAlt, borderColor: theme.border, color: theme.textPrimary };

// "5 oil" -> qty 5, search term "oil". Optional "x" between the number and
// the term ("5x oil", "5 x oil") since that's a common shorthand too.
const QUICK_LINE_RE = /^(\d+)\s*x?\s+(.+)$/i;

function findMatches(term, catalog) {
  const t = term.trim().toLowerCase();
  if (!t) return [];
  const exactSku = catalog.filter((p) => p.sku.toLowerCase() === t);
  if (exactSku.length > 0) return exactSku;
  return catalog.filter(
    (p) =>
      p.name.toLowerCase().includes(t) ||
      p.sku.toLowerCase().includes(t) ||
      (p.brand ?? "").toLowerCase().includes(t)
  );
}

export default function StockInScreen() {
  const supabase = createClient();

  const [tab, setTab] = useState("entry"); // "entry" | "tracker"

  // Bumped after a stock-in so the picker re-reads stock_on_hand.
  const [catalogVersion, setCatalogVersion] = useState(0);
  const [cart, setCart] = useState([]); // [{product_id, sku, name, stock_on_hand, qty}]
  const [supplierName, setSupplierName] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const [recorded, setRecorded] = useState(null);

  // Per-product supplier, edited inline by clicking a row's SKU.
  const [editingSupplierId, setEditingSupplierId] = useState(null);
  const [supplierDraft, setSupplierDraft] = useState("");

  // Quick entry: paste lines like "5 oil" / "10 J1-0485" and resolve them
  // against the full catalog, same shorthand his old system supported.
  const [catalog, setCatalog] = useState([]);
  const [quickText, setQuickText] = useState("");
  const [quickLines, setQuickLines] = useState(null); // null = not parsed yet

  const loadCatalog = useCallback(async () => {
    const { data } = await supabase
      .from("products")
      .select("product_id, sku, name, brand, supplier, stock_on_hand, reorder_point")
      .eq("is_active", true)
      .order("name")
      .limit(2000);
    setCatalog(data ?? []);
  }, [supabase]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadCatalog();
  }, [loadCatalog]);

  function addToCart(p) {
    setCart((prev) => {
      if (prev.some((l) => l.product_id === p.product_id)) return prev;
      return [...prev, { ...p, qty: 1 }];
    });
  }

  function setQty(product_id, qty) {
    const n = Number(qty);
    setCart((prev) => prev.map((l) => (l.product_id === product_id ? { ...l, qty: Number.isFinite(n) ? n : 0 } : l)));
  }

  function removeFromCart(product_id) {
    setCart((prev) => prev.filter((l) => l.product_id !== product_id));
  }

  function startEditSupplier(p) {
    setEditingSupplierId(p.product_id);
    setSupplierDraft(p.supplier ?? "");
  }

  async function saveSupplier(product_id) {
    const value = supplierDraft.trim() || "Unknown";
    // RPC (security definer), not a direct table update - products writes
    // are owner-only under RLS. The RPC enforces the owner role itself now
    // that Stock In is owner-only (sql/supabase_fix_supplier_owner_only.sql),
    // so bypassing RLS no longer means bypassing the role check.
    const { error: updateError } = await supabase.rpc("set_product_supplier", {
      p_product_id: product_id,
      p_supplier: value,
    });
    if (updateError) {
      setError(updateError.message);
      return;
    }
    // The picker owns the visible rows, so re-read them rather than patching
    // a local copy; the quick-entry catalog is still updated in place.
    setCatalogVersion((v) => v + 1);
    setCatalog((prev) => prev.map((p) => (p.product_id === product_id ? { ...p, supplier: value } : p)));
    setEditingSupplierId(null);
  }

  function parseQuickEntry() {
    const lines = quickText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    const parsed = lines.map((raw, i) => {
      const m = raw.match(QUICK_LINE_RE);
      if (!m) {
        return { id: i, raw, status: "invalid" };
      }
      const qty = Number(m[1]);
      const term = m[2].trim();
      const matches = findMatches(term, catalog);
      const status = matches.length === 0 ? "notfound" : matches.length === 1 ? "matched" : "ambiguous";
      return { id: i, raw, qty, term, matches, status, chosenId: matches[0]?.product_id ?? null };
    });

    setQuickLines(parsed);
  }

  function setChosenMatch(lineId, productId) {
    setQuickLines((prev) => prev.map((l) => (l.id === lineId ? { ...l, chosenId: Number(productId) } : l)));
  }

  function applyQuickEntry() {
    const usable = (quickLines ?? []).filter(
      (l) => (l.status === "matched" || l.status === "ambiguous") && l.chosenId
    );
    if (usable.length === 0) return;

    setCart((prev) => {
      const next = [...prev];
      for (const line of usable) {
        const product = line.matches.find((m) => m.product_id === line.chosenId);
        if (!product) continue;
        const idx = next.findIndex((l) => l.product_id === product.product_id);
        if (idx >= 0) {
          next[idx] = { ...next[idx], qty: next[idx].qty + line.qty };
        } else {
          next.push({ ...product, qty: line.qty });
        }
      }
      return next;
    });

    setQuickText("");
    setQuickLines(null);
  }

  async function handleConfirm() {
    const items = cart.filter((l) => l.qty !== 0).map((l) => ({ product_id: l.product_id, qty: l.qty }));
    if (items.length === 0) {
      setError("No non-zero quantities to record.");
      return;
    }
    setError("");
    setRecorded(null);
    setConfirming(true);

    // supplier is applied server-side (security definer) inside the RPC
    // itself, not a separate client update - products writes are
    // owner-only under RLS, and the RPC checks the owner role itself.
    const { data, error: rpcError } = await supabase.rpc("record_stock_movements", {
      items,
      supplier: supplierName.trim() || null,
    });

    setConfirming(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }

    setRecorded(data.recorded);
    setCart([]);
    setSupplierName("");
    setCatalogVersion((v) => v + 1);
    loadCatalog();
  }

  const usableQuickCount = (quickLines ?? []).filter(
    (l) => (l.status === "matched" || l.status === "ambiguous") && l.chosenId
  ).length;

  return (
    <div className="flex flex-col gap-6" style={{ color: theme.textSecondary }}>
      <div className="flex gap-1 self-start rounded border p-1" style={{ borderColor: theme.border }}>
        <button
          onClick={() => setTab("entry")}
          className="rounded px-3 py-1.5 text-sm font-medium"
          style={tab === "entry" ? { backgroundColor: theme.accent, color: "#05230f" } : { color: theme.textSecondary }}
        >
          Stock In
        </button>
        <button
          onClick={() => setTab("tracker")}
          className="rounded px-3 py-1.5 text-sm font-medium"
          style={tab === "tracker" ? { backgroundColor: theme.accent, color: "#05230f" } : { color: theme.textSecondary }}
        >
          Stock-In Tracker
        </button>
      </div>

      {tab === "tracker" && <StockInTracker />}

      {tab === "entry" && (
        <>
          {error && <p className="text-sm text-red-400">{error}</p>}

          {recorded && (
            <div className="rounded border p-3 text-sm" style={{ borderColor: "#0ca30c55", backgroundColor: "#0ca30c1a" }}>
              <p className="mb-1 font-semibold" style={{ color: "#4ade80" }}>
                Recorded:
              </p>
              <ul className="flex flex-col gap-0.5" style={{ color: "#4ade80" }}>
                {recorded.map((r, i) => (
                  <li key={i}>
                    {r.sku} {r.name}: {r.change > 0 ? `+${r.change}` : r.change} -{`>`} balance {r.balance}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="grid gap-6 lg:grid-cols-2">
          {/* Quick entry */}
          <div className="flex flex-col gap-2 rounded-lg border p-4" style={{ borderColor: theme.border }}>
            <h2 className="text-xs font-semibold" style={{ color: theme.textPrimary }}>
              Quick entry
            </h2>
            <textarea
              value={quickText}
              onChange={(e) => {
                setQuickText(e.target.value);
                setQuickLines(null);
              }}
              rows={4}
              className={inputClass}
              style={inputStyle}
            />
            <div className="flex items-center gap-2">
              <button
                onClick={parseQuickEntry}
                disabled={!quickText.trim()}
                className="rounded border px-3 py-1.5 text-xs font-medium disabled:opacity-40"
                style={{ borderColor: theme.border, color: theme.textSecondary }}
              >
                Check matches
              </button>
              {quickLines !== null && (
                <button
                  onClick={applyQuickEntry}
                  disabled={usableQuickCount === 0}
                  className="rounded px-3 py-1.5 text-xs font-medium disabled:opacity-40"
                  style={{ backgroundColor: theme.accent, color: "#05230f" }}
                >
                  Add {usableQuickCount} matched line{usableQuickCount === 1 ? "" : "s"} to batch
                </button>
              )}
            </div>

            {quickLines !== null && quickLines.length > 0 && (
              <ul className="mt-1 flex flex-col gap-1.5 text-xs">
                {quickLines.map((l) => (
                  <li key={l.id} className="flex flex-wrap items-center gap-2">
                    <span className="font-mono" style={{ color: theme.textMuted }}>
                      {l.raw}
                    </span>
                    {l.status === "invalid" && (
                      <span style={{ color: "#f87171" }}>no quantity found - start the line with a number</span>
                    )}
                    {l.status === "notfound" && <span style={{ color: "#f87171" }}>no product matches &quot;{l.term}&quot;</span>}
                    {l.status === "matched" && (
                      <span style={{ color: "#4ade80" }}>
                        → {l.qty}× {l.matches[0].sku} {l.matches[0].name}
                      </span>
                    )}
                    {l.status === "ambiguous" && (
                      <span className="flex items-center gap-2" style={{ color: "#fbbf24" }}>
                        {l.matches.length} matches for &quot;{l.term}&quot; -
                        <select
                          value={l.chosenId ?? ""}
                          onChange={(e) => setChosenMatch(l.id, e.target.value)}
                          className="rounded border px-1.5 py-0.5"
                          style={{ ...inputStyle, color: theme.textPrimary }}
                        >
                          {l.matches.map((m) => (
                            <option key={m.product_id} value={m.product_id}>
                              {m.sku} {m.name}
                            </option>
                          ))}
                        </select>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

            {/* Batch */}
            <div className="flex flex-col gap-3">
              <h2 className="text-sm font-semibold" style={{ color: theme.textPrimary }}>
                This batch (+ received, - correction)
              </h2>
              <div className="rounded border" style={{ borderColor: theme.border }}>
                <table className="w-full text-left text-sm">
                  <thead style={{ backgroundColor: theme.cardBgAlt, color: theme.textMuted }}>
                    <tr>
                      <th className="px-3 py-2 font-normal">SKU</th>
                      <th className="px-3 py-2 font-normal">Name</th>
                      <th className="px-3 py-2 text-right font-normal">Current</th>
                      <th className="px-3 py-2 text-right font-normal">Qty change</th>
                      <th className="px-3 py-2 text-right font-normal">New balance</th>
                      <th className="px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {cart.map((l) => (
                      <tr key={l.product_id} className="border-t" style={{ borderColor: theme.border }}>
                        <td className="px-3 py-2 font-mono" style={{ color: theme.textPrimary }}>
                          {l.sku}
                        </td>
                        <td className="px-3 py-2">{l.name}</td>
                        <td className="px-3 py-2 text-right">{l.stock_on_hand}</td>
                        <td className="px-3 py-2 text-right">
                          <input
                            type="number"
                            value={l.qty}
                            onChange={(e) => setQty(l.product_id, e.target.value)}
                            className="w-20 rounded border px-1 py-0.5 text-right"
                            style={inputStyle}
                          />
                        </td>
                        <td className="px-3 py-2 text-right">{l.stock_on_hand + l.qty}</td>
                        <td className="px-3 py-2 text-right">
                          <button onClick={() => removeFromCart(l.product_id)} className="text-red-400 hover:underline">
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                    {cart.length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-3 py-4 text-center" style={{ color: theme.textMuted }}>
                          No lines yet - add products below, or use quick entry above.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <input
                value={supplierName}
                onChange={(e) => setSupplierName(e.target.value)}
                placeholder="Supplier name (optional)"
                className={inputClass}
                style={inputStyle}
              />
              <button
                onClick={handleConfirm}
                disabled={cart.length === 0 || confirming}
                className="rounded px-4 py-2 text-sm font-medium disabled:opacity-40"
                style={{ backgroundColor: theme.accent, color: "#05230f" }}
              >
                {confirming ? "Recording..." : "Confirm"}
              </button>
            </div>
          </div>

          {/* Product picker: category first, then the item */}
          <CategoryProductPicker
            columns="product_id, sku, name, category, brand, supplier, stock_on_hand, reorder_point"
            searchFields={["name", "sku", "brand"]}
            searchPlaceholder="Search name, SKU, brand..."
            refreshKey={catalogVersion}
            columnCount={6}
            tableHead={
              <tr>
                <th className="px-3 py-2 font-normal">SKU</th>
                <th className="px-3 py-2 font-normal">Name</th>
                <th className="px-3 py-2 font-normal">Supplier</th>
                <th className="px-3 py-2 text-right font-normal">Stock</th>
                <th className="px-3 py-2 text-right font-normal">Reorder pt</th>
                <th className="px-3 py-2"></th>
              </tr>
            }
            renderRow={(p) => (
              <>
                <td
                  onClick={() => startEditSupplier(p)}
                  title="Click to edit supplier"
                  className="cursor-pointer px-3 py-2 font-mono hover:underline"
                  style={{ color: theme.textPrimary }}
                >
                  {p.sku}
                </td>
                <td className="px-3 py-2">{p.name}</td>
                <td className="px-3 py-2">
                  {editingSupplierId === p.product_id ? (
                    <div className="flex items-center gap-1">
                      <input
                        autoFocus
                        value={supplierDraft}
                        onChange={(e) => setSupplierDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveSupplier(p.product_id);
                          if (e.key === "Escape") setEditingSupplierId(null);
                        }}
                        className="w-28 rounded border px-1.5 py-0.5 text-xs"
                        style={inputStyle}
                      />
                      <button
                        onClick={() => saveSupplier(p.product_id)}
                        className="text-xs font-medium"
                        style={{ color: theme.accent }}
                      >
                        Save
                      </button>
                    </div>
                  ) : (
                    <span style={{ color: p.supplier ? theme.textSecondary : theme.textMuted }}>
                      {p.supplier || "Unknown"}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-right">{p.stock_on_hand}</td>
                <td className="px-3 py-2 text-right">{p.reorder_point}</td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => addToCart(p)}
                    className="rounded px-2 py-1 text-xs font-medium"
                    style={{ backgroundColor: theme.accent, color: "#05230f" }}
                  >
                    Add
                  </button>
                </td>
              </>
            )}
          />
        </>
      )}
    </div>
  );
}
