"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { theme } from "@/app/dashboard/theme";
import { orIlikeFilter } from "@/lib/searchFilter";

// Shared "pick a category, then the item" product picker, used by Sales
// Entry, the Edit Sale panel, Stock In and (as the select-pair variant
// below) Forecasting, so finding a product works the same way everywhere.
//
// Categories are products.category - the same values the dashboard's Stock
// by Category chart groups on.
//
// Callers pass their own `columns` and row renderer: the picker decides how
// products are FOUND, never what a row shows or what its button does. That
// also keeps cost columns out of the staff-facing screens - nothing here
// selects unit_cost, and no caller can be given it by accident.

const PAGE_SIZE = 1000; // PostgREST's per-request ceiling

const ALL = "__all__";

const inputClass = "rounded border px-3 py-1.5 text-sm";
const inputStyle = { backgroundColor: theme.cardBgAlt, borderColor: theme.border, color: theme.textPrimary };

// products.category is NOT NULL with an 'Uncategorized' default, so the
// fallback here is belt-and-braces rather than an expected case.
const nameOf = (row) => (row.category ?? "").trim() || "Uncategorized";

/** [{ category, count }], alphabetical. Pure, so it can group rows a screen
 *  has already loaded as easily as a dedicated category read. */
export function categoriesFrom(rows) {
  const counts = new Map();
  for (const row of rows) {
    const key = nameOf(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

/** [{ category, items }], categories alphabetical, items by name. */
export function groupByCategory(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = nameOf(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()]
    .map(([category, items]) => ({
      category,
      items: [...items].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
    }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

// Paged so neither the category list nor a big category's item list stops
// at PostgREST's 1000-row default once the catalog outgrows it.
async function fetchAllPages(build) {
  const all = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await build().range(offset, offset + PAGE_SIZE - 1);
    if (error) return { rows: all, error: error.message };
    all.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) return { rows: all, error: null };
  }
}

/** Category list with item counts. `activeOnly` off is for the Products
 *  screen, whose table shows deactivated products too - every row there has
 *  to stay reachable from the filter. */
export async function fetchCategoryCounts(supabase, { activeOnly = true } = {}) {
  const { rows, error } = await fetchAllPages(() => {
    const q = supabase.from("products").select("category");
    return activeOnly ? q.eq("is_active", true) : q;
  });
  return { categories: categoriesFrom(rows), error };
}

/** Active products, optionally narrowed to one category and/or a search
 *  term. `columns` is the caller's own select list. */
export async function fetchActiveProducts(supabase, { columns, category, term, searchFields }) {
  // Escaped and quoted rather than stripped - see lib/searchFilter.js. The
  // old version deleted , ( ) from the term, which made a supplier called
  // "Acme, Inc." unsearchable and left the LIKE wildcards alone.
  const searchFilter = orIlikeFilter(searchFields, term);
  return fetchAllPages(() => {
    let q = supabase.from("products").select(columns).eq("is_active", true).order("name");
    if (category) q = q.eq("category", category);
    if (searchFilter) q = q.or(searchFilter);
    return q;
  });
}

/** Loads the category list once per mount. Shared by the picker and the
 *  Products screen's filter. */
export function useCategoryCounts(supabase, { activeOnly = true } = {}) {
  const [categories, setCategories] = useState([]);

  useEffect(() => {
    let live = true;
    fetchCategoryCounts(supabase, { activeOnly }).then(({ categories: list, error }) => {
      if (!live) return;
      if (error) console.error("category list failed:", error);
      else setCategories(list);
    });
    return () => {
      live = false;
    };
  }, [supabase, activeOnly]);

  return categories;
}

/** "Gaskets & Seals (42)" options, with an "All categories" entry. */
export function CategorySelect({ value, onChange, categories, total, className = "", allLabel = "All categories" }) {
  return (
    <select
      value={value || ALL}
      onChange={(e) => onChange(e.target.value === ALL ? "" : e.target.value)}
      className={`${inputClass} ${className}`}
      style={inputStyle}
      aria-label="Category"
    >
      <option value={ALL}>{total === undefined ? allLabel : `${allLabel} (${total})`}</option>
      {categories.map((c) => (
        <option key={c.category} value={c.category}>
          {c.category} ({c.count})
        </option>
      ))}
    </select>
  );
}

export default function CategoryProductPicker({
  columns,
  searchFields = ["name", "sku"],
  searchPlaceholder = "Search name, SKU...",
  tableHead,
  columnCount,
  renderRow,
  rowKey = (p) => p.product_id,
  // Bumping this reloads the current view - the screens use it to pick up
  // stock_on_hand after recording a sale or a stock-in.
  refreshKey = 0,
  maxHeightClass = "max-h-96",
}) {
  const supabase = useMemo(() => createClient(), []);
  const categories = useCategoryCounts(supabase);

  const [category, setCategory] = useState("");
  const [term, setTerm] = useState("");
  // The submitted term, kept apart from what is being typed so the screens
  // keep their existing "press Search" behaviour - and so changing category
  // re-runs the search that is actually showing.
  const [appliedTerm, setAppliedTerm] = useState("");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const totalProducts = useMemo(() => categories.reduce((s, c) => s + c.count, 0), [categories]);

  // Nothing picked and nothing searched: listing an arbitrary first page of
  // the catalog invited scrolling it, which is what the category step is
  // meant to replace.
  const idle = !category && !appliedTerm;

  const load = useCallback(async () => {
    if (!category && !appliedTerm) {
      setRows([]);
      setError("");
      return;
    }
    setLoading(true);
    const { rows: found, error: failed } = await fetchActiveProducts(supabase, {
      columns,
      category,
      term: appliedTerm,
      searchFields,
    });
    setRows(found);
    setError(failed ?? "");
    setLoading(false);
    // searchFields is a literal array at every call site, so it is stable in
    // practice; listing it here would re-run this on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, columns, category, appliedTerm]);

  useEffect(() => {
    // Fetch-on-change: load()'s setState calls land before its first await
    // (or clear an already-empty list), which is the established pattern on
    // these screens rather than a render loop.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load, refreshKey]);

  const groups = useMemo(() => groupByCategory(rows), [rows]);

  function submitSearch(e) {
    e.preventDefault();
    setAppliedTerm(term);
  }

  return (
    <div className="flex flex-col gap-3">
      <form onSubmit={submitSearch} className="flex flex-wrap gap-2">
        <CategorySelect
          value={category}
          onChange={(next) => {
            setCategory(next);
            setAppliedTerm(term); // keep the visible search in step
          }}
          categories={categories}
          total={totalProducts}
          className="w-48"
        />
        <input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder={searchPlaceholder}
          className={`min-w-40 flex-1 ${inputClass}`}
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

      {error && <p className="text-xs text-red-400">{error}</p>}

      <div className={`${maxHeightClass} overflow-y-auto rounded border`} style={{ borderColor: theme.border }}>
        <table className="w-full text-left text-sm">
          <thead style={{ backgroundColor: theme.cardBgAlt, color: theme.textMuted }}>{tableHead}</thead>
          {idle ? (
            <tbody>
              <tr>
                <td colSpan={columnCount} className="px-3 py-6 text-center" style={{ color: theme.textMuted }}>
                  Pick a category or search to see products.
                </td>
              </tr>
            </tbody>
          ) : loading ? (
            <tbody>
              <tr>
                <td colSpan={columnCount} className="px-3 py-6 text-center" style={{ color: theme.textMuted }}>
                  Loading...
                </td>
              </tr>
            </tbody>
          ) : groups.length === 0 ? (
            <tbody>
              <tr>
                <td colSpan={columnCount} className="px-3 py-4 text-center" style={{ color: theme.textMuted }}>
                  No products found.
                </td>
              </tr>
            </tbody>
          ) : (
            groups.map((group) => (
              <tbody key={group.category}>
                {/* Sticky on the th, not the tr - a sticky tr is ignored by
                    some browsers. The thead scrolls away as it always did. */}
                <tr>
                  <th
                    colSpan={columnCount}
                    className="sticky top-0 z-10 border-y px-3 py-1.5 text-left text-xs font-semibold"
                    style={{
                      backgroundColor: theme.cardBgAlt,
                      borderColor: theme.border,
                      color: theme.textSecondary,
                    }}
                  >
                    {group.category}{" "}
                    <span className="font-normal tabular-nums" style={{ color: theme.textMuted }}>
                      ({group.items.length})
                    </span>
                  </th>
                </tr>
                {group.items.map((p) => (
                  <tr key={rowKey(p)} className="border-t" style={{ borderColor: theme.border }}>
                    {renderRow(p)}
                  </tr>
                ))}
              </tbody>
            ))
          )}
        </table>
      </div>
    </div>
  );
}

/** Category -> SKU select pair, for Forecasting, where the picker has to
 *  yield a single SKU rather than a list with row actions. Works off a
 *  products array the caller already has, so it shares this module's
 *  grouping and labelling without a second round trip. */
export function CategorySkuSelect({ products, value, onChange, disabled = false }) {
  const categories = useMemo(() => categoriesFrom(products), [products]);

  // Seeded from the incoming SKU so /forecasting?sku=X lands with X's
  // category already chosen and X selected (the ledger's "View demand
  // forecast" button relies on this).
  const [category, setCategory] = useState(() => {
    const found = products.find((p) => p.sku === value);
    return found ? nameOf(found) : "";
  });

  const visible = useMemo(() => {
    const inCategory = category ? products.filter((p) => nameOf(p) === category) : products;
    return [...inCategory].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  }, [products, category]);

  function changeCategory(next) {
    setCategory(next);
    // Drop a selection that the new category doesn't contain, so the two
    // selects can never disagree.
    if (value && next && !products.some((p) => p.sku === value && nameOf(p) === next)) onChange("");
  }

  return (
    <div className="flex flex-wrap gap-2">
      <CategorySelect
        value={category}
        onChange={changeCategory}
        categories={categories}
        total={products.length}
        className="w-48"
      />
      <select
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={`w-72 ${inputClass}`}
        style={inputStyle}
        aria-label="Product"
      >
        <option value="">{category ? `Select an item (${visible.length})` : "Select an item..."}</option>
        {visible.map((p) => (
          <option key={p.sku} value={p.sku}>
            {p.sku} — {p.name}
          </option>
        ))}
      </select>
    </div>
  );
}
