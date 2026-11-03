"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { theme } from "../dashboard/theme";
import SalesTracker from "./SalesTracker";
import ServicesScreen from "./ServicesScreen";
import RecordsTable, { CustomerDetail } from "./RecordsTable";
import { formatManilaDateTime } from "@/lib/ledger";
import CategoryProductPicker from "@/components/CategoryProductPicker";

const inputClass = "rounded border px-3 py-1.5 text-sm";
const inputStyle = { backgroundColor: theme.cardBgAlt, borderColor: theme.border, color: theme.textPrimary };

export default function SalesScreen({ userId, role, initialTab = "entry" }) {
  const supabase = createClient();

  const [tab, setTab] = useState(initialTab); // "entry" | "services" | "tracker"
  // Bumped after a sale so both pickers re-read stock_on_hand.
  const [catalogVersion, setCatalogVersion] = useState(0);
  const [cart, setCart] = useState([]); // [{product_id, sku, name, unit_price, stock_on_hand, qty}]
  const [note, setNote] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerContact, setCustomerContact] = useState("");
  const [customerAddress, setCustomerAddress] = useState("");
  const [customerVehicleBrand, setCustomerVehicleBrand] = useState("");
  const [showCustomerDetails, setShowCustomerDetails] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [recentSales, setRecentSales] = useState([]);

  // Editing an already-confirmed sale from the Recent sales list.
  const [editingSale, setEditingSale] = useState(null);
  const [editSaving, setEditSaving] = useState(false);

  const loadRecentSales = useCallback(async () => {
    const { data: sales } = await supabase
      .from("sales")
      .select(
        "sale_id, sale_ts, total_amount, note, user_id, customer_name, customer_contact, customer_address, customer_vehicle_brand, profiles(full_name)"
      )
      .eq("status", "confirmed")
      .order("sale_id", { ascending: false })
      .limit(200);

    const list = sales ?? [];
    if (list.length === 0) {
      setRecentSales([]);
      return;
    }

    const { data: items } = await supabase
      .from("sale_items")
      .select("sale_id")
      .in("sale_id", list.map((s) => s.sale_id));

    const lineCounts = {};
    (items ?? []).forEach((it) => {
      lineCounts[it.sale_id] = (lineCounts[it.sale_id] ?? 0) + 1;
    });

    const today = new Date().toDateString();
    setRecentSales(
      list.map((s) => ({
        ...s,
        lines: lineCounts[s.sale_id] ?? 0,
        can_undo: role === "owner" || (s.user_id === userId && new Date(s.sale_ts).toDateString() === today),
      }))
    );
  }, [supabase, role, userId]);

  useEffect(() => {
    // Fetch-on-mount: setState lands before the first await, which is the
    // established pattern on these screens (not a render loop).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadRecentSales();
  }, [loadRecentSales]);

  function addToCart(p) {
    setCart((prev) => {
      const existing = prev.find((line) => line.product_id === p.product_id);
      if (existing) {
        return prev.map((line) =>
          line.product_id === p.product_id ? { ...line, qty: line.qty + 1 } : line
        );
      }
      return [...prev, { ...p, qty: 1 }];
    });
  }

  function setQty(product_id, qty) {
    const n = Math.max(1, Number(qty) || 1);
    setCart((prev) => prev.map((l) => (l.product_id === product_id ? { ...l, qty: n } : l)));
  }

  function removeFromCart(product_id) {
    setCart((prev) => prev.filter((l) => l.product_id !== product_id));
  }

  const cartTotal = cart.reduce((sum, l) => sum + l.qty * Number(l.unit_price), 0);

  async function handleConfirm() {
    if (cart.length === 0) return;
    setError("");
    setNotice("");
    setConfirming(true);

    const { data, error: rpcError } = await supabase.rpc("confirm_sale", {
      items: cart.map((l) => ({ product_id: l.product_id, qty: l.qty })),
      note: note.trim() || null,
      customer_name: customerName.trim() || null,
      customer_contact: customerContact.trim() || null,
      customer_address: customerAddress.trim() || null,
      customer_vehicle_brand: customerVehicleBrand.trim() || null,
    });

    setConfirming(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }

    setNotice(`Sale #${data.sale_id} recorded - total ${Number(data.total_amount).toFixed(2)}.`);
    setCart([]);
    setNote("");
    setCustomerName("");
    setCustomerContact("");
    setCustomerAddress("");
    setCustomerVehicleBrand("");
    setShowCustomerDetails(false);
    setCatalogVersion((v) => v + 1); // refresh stock_on_hand shown in the picker
    loadRecentSales();
  }

  async function handleUndo(row) {
    const saleId = row.sale_id;
    if (!confirm(`Undo sale #${saleId}? Stock will be restored.`)) return;
    setError("");
    const { error: rpcError } = await supabase.rpc("undo_sale", { p_sale_id: saleId });
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    setNotice(`Sale #${saleId} undone.`);
    setCatalogVersion((v) => v + 1);
    loadRecentSales();
  }

  async function openEditSale(row) {
    setError("");
    // unit_price comes from products, not sale_items - edit_sale() always
    // re-prices every line at the product's CURRENT price when it saves
    // (same as confirm_sale), so this preview has to show that same price,
    // not the one frozen on the original sale, or the total shown here
    // could silently differ from what actually gets persisted.
    const { data, error: fetchError } = await supabase
      .from("sale_items")
      .select("product_id, sku, quantity, products(name, unit_price)")
      .eq("sale_id", row.sale_id);
    if (fetchError) {
      setError(fetchError.message);
      return;
    }
    setEditingSale({
      sale_id: row.sale_id,
      lines: (data ?? []).map((it) => ({
        product_id: it.product_id,
        sku: it.sku,
        name: it.products?.name ?? it.sku,
        unit_price: it.products?.unit_price ?? 0,
        qty: it.quantity,
      })),
      note: row.note ?? "",
      customer_name: row.customer_name ?? "",
      customer_contact: row.customer_contact ?? "",
      customer_address: row.customer_address ?? "",
      customer_vehicle_brand: row.customer_vehicle_brand ?? "",
    });
  }

  function closeEditSale() {
    setEditingSale(null);
  }

  function addEditLine(p) {
    setEditingSale((prev) => {
      if (!prev) return prev;
      const existing = prev.lines.find((l) => l.product_id === p.product_id);
      const lines = existing
        ? prev.lines.map((l) => (l.product_id === p.product_id ? { ...l, qty: l.qty + 1 } : l))
        : [...prev.lines, { product_id: p.product_id, sku: p.sku, name: p.name, unit_price: p.unit_price, qty: 1 }];
      return { ...prev, lines };
    });
  }

  function setEditQty(product_id, qty) {
    const n = Math.max(1, Number(qty) || 1);
    setEditingSale((prev) =>
      prev ? { ...prev, lines: prev.lines.map((l) => (l.product_id === product_id ? { ...l, qty: n } : l)) } : prev
    );
  }

  function removeEditLine(product_id) {
    setEditingSale((prev) => (prev ? { ...prev, lines: prev.lines.filter((l) => l.product_id !== product_id) } : prev));
  }

  async function saveEditSale() {
    if (!editingSale || editingSale.lines.length === 0) {
      setError("A sale needs at least one line item.");
      return;
    }
    setError("");
    setEditSaving(true);

    const { error: rpcError } = await supabase.rpc("edit_sale", {
      p_sale_id: editingSale.sale_id,
      items: editingSale.lines.map((l) => ({ product_id: l.product_id, qty: l.qty })),
      p_note: editingSale.note.trim() || null,
      p_customer_name: editingSale.customer_name.trim() || null,
      p_customer_contact: editingSale.customer_contact.trim() || null,
      p_customer_address: editingSale.customer_address.trim() || null,
      p_customer_vehicle_brand: editingSale.customer_vehicle_brand.trim() || null,
    });

    setEditSaving(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }

    setNotice(`Sale #${editingSale.sale_id} updated.`);
    closeEditSale();
    setCatalogVersion((v) => v + 1);
    loadRecentSales();
  }

  // Memoized so the array reference (and therefore RecordsTable's cached
  // row detail) only changes when a reload actually replaces recentSales,
  // not on every unrelated re-render of this screen.
  const recentSalesRows = useMemo(() => recentSales.map((s) => ({ ...s, key: s.sale_id })), [recentSales]);

  async function fetchSaleDetail(row) {
    const { data } = await supabase
      .from("sale_items")
      .select("sku, quantity, unit_price, line_revenue, products(name)")
      .eq("sale_id", row.sale_id);
    const items = data ?? [];
    return (
      <>
        <CustomerDetail row={row} />
        <table className="mt-2 w-full text-xs">
          <thead>
            <tr style={{ color: theme.textMuted }}>
              <th className="px-2 py-1 text-left font-normal">SKU</th>
              <th className="px-2 py-1 text-left font-normal">Name</th>
              <th className="px-2 py-1 text-right font-normal">Qty</th>
              <th className="px-2 py-1 text-right font-normal">Unit price</th>
              <th className="px-2 py-1 text-right font-normal">Line total</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={i}>
                <td className="px-2 py-1 font-mono">{it.sku}</td>
                <td className="px-2 py-1">{it.products?.name}</td>
                <td className="px-2 py-1 text-right">{it.quantity}</td>
                <td className="px-2 py-1 text-right">{Number(it.unit_price).toFixed(2)}</td>
                <td className="px-2 py-1 text-right">{Number(it.line_revenue).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </>
    );
  }

  return (
    <div className="flex flex-col gap-6" style={{ color: theme.textSecondary }}>
      <div className="flex gap-1 rounded border p-1 self-start" style={{ borderColor: theme.border }}>
        <button
          onClick={() => setTab("entry")}
          className="rounded px-3 py-1.5 text-sm font-medium"
          style={tab === "entry" ? { backgroundColor: theme.accent, color: "#05230f" } : { color: theme.textSecondary }}
        >
          Sales Entry
        </button>
        <button
          onClick={() => setTab("services")}
          className="rounded px-3 py-1.5 text-sm font-medium"
          style={tab === "services" ? { backgroundColor: theme.accent, color: "#05230f" } : { color: theme.textSecondary }}
        >
          Services
        </button>
        <button
          onClick={() => setTab("tracker")}
          className="rounded px-3 py-1.5 text-sm font-medium"
          style={tab === "tracker" ? { backgroundColor: theme.accent, color: "#05230f" } : { color: theme.textSecondary }}
        >
          Sales Tracker
        </button>
      </div>

      {tab === "tracker" && <SalesTracker role={role} />}
      {tab === "services" && <ServicesScreen userId={userId} role={role} />}

      {tab === "entry" && (
        <>
          {error && <p className="text-sm text-red-400">{error}</p>}
          {notice && <p className="text-sm text-green-400">{notice}</p>}

          <div className="grid gap-6 lg:grid-cols-2">
        {/* Product picker: category first, then the item */}
        <CategoryProductPicker
          columns="product_id, sku, name, category, brand, unit_price, stock_on_hand"
          searchFields={["name", "sku", "brand"]}
          searchPlaceholder="Search name, SKU, brand..."
          refreshKey={catalogVersion}
          columnCount={5}
          tableHead={
            <tr>
              <th className="px-3 py-2 font-normal">SKU</th>
              <th className="px-3 py-2 font-normal">Name</th>
              <th className="px-3 py-2 text-right font-normal">Price</th>
              <th className="px-3 py-2 text-right font-normal">Stock</th>
              <th className="px-3 py-2"></th>
            </tr>
          }
          renderRow={(p) => (
            <>
              <td className="px-3 py-2 font-mono" style={{ color: theme.textPrimary }}>
                {p.sku}
              </td>
              <td className="px-3 py-2">{p.name}</td>
              <td className="px-3 py-2 text-right">{Number(p.unit_price).toFixed(2)}</td>
              <td className="px-3 py-2 text-right">{p.stock_on_hand}</td>
              <td className="px-3 py-2 text-right">
                <button
                  onClick={() => addToCart(p)}
                  disabled={p.stock_on_hand <= 0}
                  className="rounded px-2 py-1 text-xs font-medium disabled:opacity-40"
                  style={{ backgroundColor: theme.accent, color: "#05230f" }}
                >
                  Add
                </button>
              </td>
            </>
          )}
        />

        {/* Cart */}
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold" style={{ color: theme.textPrimary }}>
            Current sale
          </h2>
          <div className="rounded border" style={{ borderColor: theme.border }}>
            <table className="w-full text-left text-sm">
              <thead style={{ backgroundColor: theme.cardBgAlt, color: theme.textMuted }}>
                <tr>
                  <th className="px-3 py-2 font-normal">SKU</th>
                  <th className="px-3 py-2 font-normal">Name</th>
                  <th className="px-3 py-2 text-right font-normal">Qty</th>
                  <th className="px-3 py-2 text-right font-normal">Line total</th>
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
                    <td className="px-3 py-2 text-right">
                      <input
                        type="number"
                        min={1}
                        value={l.qty}
                        onChange={(e) => setQty(l.product_id, e.target.value)}
                        className="w-16 rounded border px-1 py-0.5 text-right"
                        style={inputStyle}
                      />
                    </td>
                    <td className="px-3 py-2 text-right">{(l.qty * Number(l.unit_price)).toFixed(2)}</td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => removeFromCart(l.product_id)} className="text-red-400 hover:underline">
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
                {cart.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-4 text-center" style={{ color: theme.textMuted }}>
                      No items yet - add products from the left.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between text-sm font-semibold" style={{ color: theme.textPrimary }}>
            <span>Total</span>
            <span>{cartTotal.toFixed(2)}</span>
          </div>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (optional)"
            className={inputClass}
            style={inputStyle}
          />

          {showCustomerDetails ? (
            <div className="flex flex-col gap-2 rounded border p-3" style={{ borderColor: theme.border }}>
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold" style={{ color: theme.textMuted }}>
                  Customer details (optional)
                </h3>
                <button
                  type="button"
                  onClick={() => setShowCustomerDetails(false)}
                  className="text-xs font-medium hover:underline"
                  style={{ color: theme.textMuted }}
                >
                  Hide
                </button>
              </div>
              <input
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                placeholder="Customer name"
                className={inputClass}
                style={inputStyle}
              />
              <input
                value={customerContact}
                onChange={(e) => setCustomerContact(e.target.value)}
                placeholder="Contact number"
                className={inputClass}
                style={inputStyle}
              />
              <input
                value={customerAddress}
                onChange={(e) => setCustomerAddress(e.target.value)}
                placeholder="Address"
                className={inputClass}
                style={inputStyle}
              />
              <input
                value={customerVehicleBrand}
                onChange={(e) => setCustomerVehicleBrand(e.target.value)}
                placeholder="Scooter/motorcycle brand"
                className={inputClass}
                style={inputStyle}
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowCustomerDetails(true)}
              className="self-start text-sm font-medium hover:underline"
              style={{ color: theme.textSecondary }}
            >
              + Add customer info
            </button>
          )}

          <button
            onClick={handleConfirm}
            disabled={cart.length === 0 || confirming}
            className="rounded px-4 py-2 text-sm font-medium disabled:opacity-40"
            style={{ backgroundColor: theme.accent, color: "#05230f" }}
          >
            {confirming ? "Recording..." : "Confirm sale"}
          </button>
        </div>
      </div>

      {/* Recent sales */}
      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold" style={{ color: theme.textPrimary }}>
          Recent sales
        </h2>

        {editingSale && (
          <div className="flex flex-col gap-3 rounded border p-4" style={{ borderColor: theme.border, backgroundColor: theme.cardBg }}>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold" style={{ color: theme.textPrimary }}>
                Edit sale #{editingSale.sale_id}
              </h3>
              <button onClick={closeEditSale} className="text-xs font-medium hover:underline" style={{ color: theme.textMuted }}>
                Cancel
              </button>
            </div>

            <div className="rounded border" style={{ borderColor: theme.border }}>
              <table className="w-full text-left text-sm">
                <thead style={{ backgroundColor: theme.cardBgAlt, color: theme.textMuted }}>
                  <tr>
                    <th className="px-3 py-2 font-normal">SKU</th>
                    <th className="px-3 py-2 font-normal">Name</th>
                    <th className="px-3 py-2 text-right font-normal">Qty</th>
                    <th className="px-3 py-2 text-right font-normal">Line total</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {editingSale.lines.map((l) => (
                    <tr key={l.product_id} className="border-t" style={{ borderColor: theme.border }}>
                      <td className="px-3 py-2 font-mono" style={{ color: theme.textPrimary }}>
                        {l.sku}
                      </td>
                      <td className="px-3 py-2">{l.name}</td>
                      <td className="px-3 py-2 text-right">
                        <input
                          type="number"
                          min={1}
                          value={l.qty}
                          onChange={(e) => setEditQty(l.product_id, e.target.value)}
                          className="w-16 rounded border px-1 py-0.5 text-right"
                          style={inputStyle}
                        />
                      </td>
                      <td className="px-3 py-2 text-right">{(l.qty * Number(l.unit_price)).toFixed(2)}</td>
                      <td className="px-3 py-2 text-right">
                        <button onClick={() => removeEditLine(l.product_id)} className="text-red-400 hover:underline">
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                  {editingSale.lines.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-4 text-center" style={{ color: theme.textMuted }}>
                        No items - add a product below.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <p className="text-xs font-medium" style={{ color: theme.textSecondary }}>
              Add a product
            </p>
            <CategoryProductPicker
              columns="product_id, sku, name, category, unit_price, stock_on_hand"
              searchFields={["name", "sku"]}
              searchPlaceholder="Search name or SKU..."
              refreshKey={catalogVersion}
              maxHeightClass="max-h-56"
              columnCount={4}
              tableHead={
                <tr>
                  <th className="px-3 py-2 font-normal">SKU</th>
                  <th className="px-3 py-2 font-normal">Name</th>
                  <th className="px-3 py-2 text-right font-normal">Price</th>
                  <th className="px-3 py-2"></th>
                </tr>
              }
              renderRow={(p) => (
                <>
                  <td className="px-3 py-2 font-mono" style={{ color: theme.textPrimary }}>
                    {p.sku}
                  </td>
                  <td className="px-3 py-2">{p.name}</td>
                  <td className="px-3 py-2 text-right">{Number(p.unit_price).toFixed(2)}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => addEditLine(p)}
                      className="rounded px-2 py-1 text-xs font-medium"
                      style={{ backgroundColor: theme.accent, color: "#05230f" }}
                    >
                      Add
                    </button>
                  </td>
                </>
              )}
            />

            <div className="grid gap-2 sm:grid-cols-2">
              <input
                value={editingSale.note}
                onChange={(e) => setEditingSale((prev) => ({ ...prev, note: e.target.value }))}
                placeholder="Note (optional)"
                className={inputClass}
                style={inputStyle}
              />
              <input
                value={editingSale.customer_name}
                onChange={(e) => setEditingSale((prev) => ({ ...prev, customer_name: e.target.value }))}
                placeholder="Customer name"
                className={inputClass}
                style={inputStyle}
              />
              <input
                value={editingSale.customer_contact}
                onChange={(e) => setEditingSale((prev) => ({ ...prev, customer_contact: e.target.value }))}
                placeholder="Contact number"
                className={inputClass}
                style={inputStyle}
              />
              <input
                value={editingSale.customer_address}
                onChange={(e) => setEditingSale((prev) => ({ ...prev, customer_address: e.target.value }))}
                placeholder="Address"
                className={inputClass}
                style={inputStyle}
              />
              <input
                value={editingSale.customer_vehicle_brand}
                onChange={(e) => setEditingSale((prev) => ({ ...prev, customer_vehicle_brand: e.target.value }))}
                placeholder="Scooter/motorcycle brand"
                className={inputClass}
                style={inputStyle}
              />
            </div>

            <div className="flex gap-2">
              <button
                onClick={saveEditSale}
                disabled={editSaving}
                className="rounded px-4 py-1.5 text-sm font-medium disabled:opacity-40"
                style={{ backgroundColor: theme.accent, color: "#05230f" }}
              >
                {editSaving ? "Saving..." : "Save changes"}
              </button>
              <button
                onClick={closeEditSale}
                className="rounded border px-4 py-1.5 text-sm"
                style={{ borderColor: theme.border, color: theme.textSecondary }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <RecordsTable
          rows={recentSalesRows}
          renderId={(r) => `#${r.sale_id}`}
          columns={[
            { label: "Time", render: (r) => formatManilaDateTime(r.sale_ts) },
            { label: "Cashier", render: (r) => r.profiles?.full_name ?? "Former staff" },
            { label: "Lines", align: "right", render: (r) => r.lines },
            { label: "Total", align: "right", render: (r) => Number(r.total_amount).toFixed(2) },
            { label: "Note", render: (r) => r.note },
          ]}
          fetchDetail={fetchSaleDetail}
          onUndo={handleUndo}
          onEdit={openEditSale}
          emptyMessage="No sales recorded yet."
        />
      </div>
        </>
      )}
    </div>
  );
}
