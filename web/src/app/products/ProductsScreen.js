"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { theme, CATEGORICAL } from "../dashboard/theme";
import PaginationControls from "@/components/PaginationControls";
import RowSizeSelect from "@/components/RowSizeSelect";
import { usePageSize } from "@/lib/pageSize";
import { CategorySelect, fetchCategoryCounts } from "@/components/CategoryProductPicker";

const inputClass = "rounded border px-2 py-1.5 text-sm w-full";
const inputStyle = { backgroundColor: theme.cardBgAlt, borderColor: theme.border, color: theme.textPrimary };

const emptyForm = {
  product_id: null,
  sku: "",
  name: "",
  category: "",
  supplier: "",
  unit_cost: "",
  unit_price: "",
  reorder_point: "",
  opening_stock: "",
  is_active: true,
};

export default function ProductsScreen() {
  const supabase = createClient();
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [search, setSearch] = useState("");
  // Filter is applied server-side, so picking a category shows all of it
  // rather than whichever of its items happened to fall inside the 500-row
  // page the unfiltered query returns.
  const [categoryFilter, setCategoryFilter] = useState("");
  const [categoryCounts, setCategoryCounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState(null); // null = form closed

  const loadProducts = useCallback(
    async (term, category) => {
      setLoading(true);
      setError("");
      const safeTerm = (term ?? "").replace(/[,()]/g, "");
      let query = supabase
        .from("products")
        .select(
          "product_id, sku, name, category, supplier, unit_cost, unit_price, reorder_point, stock_on_hand, is_active"
        )
        .order("name")
        .limit(500);

      if (category) query = query.eq("category", category);

      if (safeTerm) {
        query = query.or(
          `name.ilike.%${safeTerm}%,sku.ilike.%${safeTerm}%,supplier.ilike.%${safeTerm}%,category.ilike.%${safeTerm}%`
        );
      }

      const { data, error: fetchError } = await query;
      if (fetchError) setError(fetchError.message);
      else setProducts(data ?? []);
      setLoading(false);
    },
    [supabase]
  );

  useEffect(() => {
    // Fetch-on-mount: setLoading/setError inside loadProducts run before
    // its first await, which is the standard pattern here (not a loop).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadProducts("", "");
    // activeOnly off: this table lists deactivated products too, so every
    // row has to stay reachable from the filter (and selectable in the form).
    fetchCategoryCounts(supabase, { activeOnly: false }).then(({ categories: list, error: failed }) => {
      if (failed) {
        console.error("category list failed:", failed);
        return;
      }
      setCategoryCounts(list);
      setCategories(list.map((c) => c.category));
    });
  }, [loadProducts, supabase]);

  function handleSearchSubmit(e) {
    e.preventDefault();
    setPage(1);
    loadProducts(search, categoryFilter);
  }

  function changeCategoryFilter(next) {
    setCategoryFilter(next);
    setPage(1);
    loadProducts(search, next);
  }

  const {
    rowSize,
    setRowSize,
    page: currentPage,
    setPage,
    totalPages,
    start,
    end,
    rangeStart,
    rangeEnd,
    extended,
  } = usePageSize(products.length, "products");

  const paginated = products.slice(start, end);

  function openCreate() {
    setForm({ ...emptyForm });
    setNotice("");
  }

  function openEdit(p) {
    setForm({
      product_id: p.product_id,
      sku: p.sku,
      name: p.name,
      category: p.category,
      supplier: p.supplier,
      unit_cost: String(p.unit_cost),
      unit_price: String(p.unit_price),
      reorder_point: String(p.reorder_point),
      opening_stock: "", // not editable on existing products
      is_active: p.is_active,
    });
    setNotice("");
  }

  async function handleSave(e) {
    e.preventDefault();
    setError("");
    const res = await fetch("/api/products/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const body = await res.json();
    if (!res.ok) {
      setError(body.error || "Save failed.");
      return;
    }
    setForm(null);
    setNotice(form.product_id ? "Product updated." : "Product created.");
    loadProducts(search, categoryFilter);
  }

  async function handleDelete(product_id) {
    if (!confirm("Remove this product?")) return;
    setError("");
    const res = await fetch("/api/products/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product_id }),
    });
    const body = await res.json();
    if (!res.ok) {
      setError(body.error || "Delete failed.");
      return;
    }
    setNotice(body.message);
    loadProducts(search, categoryFilter);
  }

  return (
    <div className="flex flex-col gap-4" style={{ color: theme.textSecondary }}>
      <div className="flex items-center justify-between gap-4">
        <form onSubmit={handleSearchSubmit} className="flex flex-wrap gap-2">
          <CategorySelect
            value={categoryFilter}
            onChange={changeCategoryFilter}
            categories={categoryCounts}
            className="w-48"
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, SKU, supplier, category..."
            className="w-72 rounded border px-3 py-1.5 text-sm"
            style={inputStyle}
          />
          <button
            type="submit"
            className="rounded border px-3 py-1.5 text-sm"
            style={{ borderColor: theme.border, color: theme.textSecondary }}
          >
            Search
          </button>
        </form>
        <div className="flex items-center gap-4">
          <RowSizeSelect value={rowSize} onChange={setRowSize} />
          <PaginationControls
            rangeStart={rangeStart}
            rangeEnd={rangeEnd}
            total={products.length}
            page={currentPage}
            totalPages={totalPages}
            onPageChange={setPage}
            showEdges={extended}
            showPageIndicator={extended}
            showJump={extended}
          />
          <button
            onClick={openCreate}
            className="rounded px-4 py-1.5 text-sm font-medium"
            style={{ backgroundColor: theme.accent, color: "#05230f" }}
          >
            + Add product
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}
      {notice && <p className="text-sm text-green-400">{notice}</p>}

      {form && (
        <ProductForm
          form={form}
          setForm={setForm}
          categories={categories}
          onSave={handleSave}
          onCancel={() => setForm(null)}
        />
      )}

      <div className="overflow-x-auto rounded border" style={{ borderColor: theme.border }}>
        <table className="w-full text-left text-sm">
          <thead style={{ backgroundColor: theme.cardBgAlt, color: theme.textMuted }}>
            <tr>
              <th className="px-3 py-2 font-normal">SKU</th>
              <th className="px-3 py-2 font-normal">Name</th>
              <th className="px-3 py-2 font-normal">Category</th>
              <th className="px-3 py-2 font-normal">Supplier</th>
              <th className="px-3 py-2 text-right font-normal">Cost</th>
              <th className="px-3 py-2 text-right font-normal">Price</th>
              <th className="px-3 py-2 text-right font-normal">Stock</th>
              <th className="px-3 py-2 text-right font-normal">Reorder pt</th>
              <th className="px-3 py-2 font-normal">Active</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={10} className="px-3 py-4 text-center" style={{ color: theme.textMuted }}>
                  Loading...
                </td>
              </tr>
            ) : products.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-3 py-4 text-center" style={{ color: theme.textMuted }}>
                  No products found.
                </td>
              </tr>
            ) : (
              paginated.map((p) => (
                <tr key={p.product_id} className="border-t" style={{ borderColor: theme.border }}>
                  <td className="px-3 py-2 font-mono" style={{ color: theme.textPrimary }}>
                    {p.sku}
                  </td>
                  <td className="px-3 py-2">{p.name}</td>
                  <td className="px-3 py-2">{p.category}</td>
                  <td className="px-3 py-2">{p.supplier}</td>
                  <td className="px-3 py-2 text-right">{Number(p.unit_cost).toFixed(2)}</td>
                  <td className="px-3 py-2 text-right">{Number(p.unit_price).toFixed(2)}</td>
                  <td className="px-3 py-2 text-right">{p.stock_on_hand}</td>
                  <td className="px-3 py-2 text-right">{p.reorder_point}</td>
                  <td className="px-3 py-2">{p.is_active ? "yes" : "no"}</td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => openEdit(p)} className="mr-2 hover:underline" style={{ color: CATEGORICAL[0] }}>
                      Edit
                    </button>
                    <button onClick={() => handleDelete(p.product_id)} className="text-red-400 hover:underline">
                      Delete
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ProductForm({ form, setForm, categories, onSave, onCancel }) {
  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  return (
    <form
      onSubmit={onSave}
      className="grid grid-cols-2 gap-3 rounded border p-4 sm:grid-cols-4"
      style={{ borderColor: theme.border, backgroundColor: theme.cardBg }}
    >
      <Field label="SKU">
        <input
          required
          disabled={!!form.product_id}
          value={form.sku}
          onChange={(e) => set("sku", e.target.value)}
          className={inputClass}
          style={inputStyle}
        />
      </Field>
      <Field label="Name">
        <input required value={form.name} onChange={(e) => set("name", e.target.value)} className={inputClass} style={inputStyle} />
      </Field>
      <Field label="Category">
        <input
          list="category-options"
          value={form.category}
          onChange={(e) => set("category", e.target.value)}
          className={inputClass}
          style={inputStyle}
        />
        <datalist id="category-options">
          {categories.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </Field>
      <Field label="Supplier">
        <input value={form.supplier} onChange={(e) => set("supplier", e.target.value)} className={inputClass} style={inputStyle} />
      </Field>
      <Field label="Unit cost">
        <input
          type="number"
          step="0.01"
          value={form.unit_cost}
          onChange={(e) => set("unit_cost", e.target.value)}
          className={inputClass}
          style={inputStyle}
        />
      </Field>
      <Field label="Unit price">
        <input
          type="number"
          step="0.01"
          value={form.unit_price}
          onChange={(e) => set("unit_price", e.target.value)}
          className={inputClass}
          style={inputStyle}
        />
      </Field>
      <Field label="Reorder point">
        <input
          type="number"
          value={form.reorder_point}
          onChange={(e) => set("reorder_point", e.target.value)}
          className={inputClass}
          style={inputStyle}
        />
      </Field>
      {!form.product_id && (
        <Field label="Opening stock">
          <input
            type="number"
            value={form.opening_stock}
            onChange={(e) => set("opening_stock", e.target.value)}
            className={inputClass}
            style={inputStyle}
          />
        </Field>
      )}
      <label className="flex flex-col gap-1 text-xs" style={{ color: theme.textMuted }}>
        &nbsp;
        <span className="flex h-[34px] items-center gap-2 text-sm" style={{ color: theme.textSecondary }}>
          Active
          <input
            type="checkbox"
            checked={form.is_active}
            onChange={(e) => set("is_active", e.target.checked)}
            className="h-4 w-4 rounded"
            style={{ accentColor: theme.accent }}
          />
        </span>
      </label>

      <div className="col-span-full flex gap-2">
        <button
          type="submit"
          className="rounded px-4 py-1.5 text-sm font-medium"
          style={{ backgroundColor: theme.accent, color: "#05230f" }}
        >
          Save
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded border px-4 py-1.5 text-sm"
          style={{ borderColor: theme.border, color: theme.textSecondary }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function Field({ label, children }) {
  return (
    <label className="flex flex-col gap-1 text-xs" style={{ color: theme.textMuted }}>
      {label}
      {children}
    </label>
  );
}
