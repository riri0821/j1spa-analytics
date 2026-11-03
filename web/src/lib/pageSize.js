"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Page size and page number for the paginated lists - the dashboard's
 * Tracking table, Products, Decision Support and the shared record tables
 * (Sales Tracker, Stock-In Tracker, recent sales and services).
 *
 * All four used to hard-code 20 and reimplement the same clamping and slice
 * arithmetic. They now share this, and show ten rows by default like the
 * stock ledger does. The ledger itself deliberately does NOT use this: it is
 * fixed at ten because its brought-forward and carried-forward lines are
 * what joins one page of a stock card to the next, and a page size the
 * reader can change would make those rows mean something different each time.
 *
 * Note this is about DISPLAY. The 1000-row PAGE_SIZE constants in
 * forecasting/page.js, ledger/[sku]/page.js and CategoryProductPicker.js are
 * PostgREST's fetch cap and have nothing to do with this.
 */

/** The sizes the Rows selector offers. */
export const ROW_SIZE_OPTIONS = [10, 20, 50];

/** What a list opens on, and where an unusable stored value lands. */
export const DEFAULT_ROW_SIZE = 10;

// Past this many pages, Prev/Next alone stops being a way to reach anything:
// the Sales Tracker's year view can hold ~33,000 records, which is 3,300
// pages of ten. Those lists get the ledger's fuller control strip instead.
const SIMPLE_CONTROLS_MAX_PAGES = 5;

export function wantsExtendedControls(totalPages) {
  return totalPages > SIMPLE_CONTROLS_MAX_PAGES;
}

function storageKey(listKey) {
  return `j1spa.rows.${listKey}`;
}

/**
 * The remembered size for one list, defensively: localStorage throws
 * outright in a private window or with site data blocked, and any value at
 * all could be sitting under the key - including one written by a future
 * version of this list with different options.
 */
export function readRowSize(listKey) {
  try {
    const stored = Number(window.localStorage.getItem(storageKey(listKey)));
    return ROW_SIZE_OPTIONS.includes(stored) ? stored : DEFAULT_ROW_SIZE;
  } catch {
    return DEFAULT_ROW_SIZE;
  }
}

export function writeRowSize(listKey, size) {
  try {
    window.localStorage.setItem(storageKey(listKey), String(size));
  } catch {
    // A remembered page size is not worth failing an interaction over.
  }
}

/**
 * @param total how many rows the list holds right now, AFTER its own
 *   filters - not the rows themselves. Slicing stays with the caller, which
 *   is the only thing that knows what it is rendering.
 * @param listKey the localStorage suffix, e.g. "tracking" -> j1spa.rows.tracking.
 *
 * Returns the clamped page, the slice bounds, the "N-M of T" figures the
 * shared PaginationControls wants, and whether this list is long enough to
 * need the extended controls.
 */
export function usePageSize(total, listKey) {
  const [rowSize, setStoredSize] = useState(DEFAULT_ROW_SIZE);
  const [page, setPage] = useState(1);

  // Read on mount rather than in the useState initializer. These lists are
  // server-rendered first, where there is no localStorage, so reading it
  // during the first render would have the client disagree with the server's
  // HTML and fail hydration. The first paint shows ten rows either way.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStoredSize(readRowSize(listKey));
  }, [listKey]);

  const setRowSize = useCallback(
    (next) => {
      setStoredSize(next);
      writeRowSize(listKey, next);
      // Page 4 of 10-row pages is a different part of the list than page 4
      // of 50-row pages, so the old number means nothing at the new size.
      setPage(1);
    },
    [listKey]
  );

  const totalPages = Math.max(1, Math.ceil(total / rowSize));
  // Filters change which rows exist, so a page picked before may now be out
  // of range - clamped during render rather than kept as a second copy of
  // page state to hold in sync.
  const currentPage = Math.min(page, totalPages);

  return {
    rowSize,
    setRowSize,
    page: currentPage,
    setPage,
    totalPages,
    // For `rows.slice(start, end)`.
    start: (currentPage - 1) * rowSize,
    end: currentPage * rowSize,
    // 1-based and inclusive, for "1-10 of 576". An empty list reads 0-0.
    rangeStart: total === 0 ? 0 : (currentPage - 1) * rowSize + 1,
    rangeEnd: Math.min(currentPage * rowSize, total),
    extended: wantsExtendedControls(totalPages),
  };
}
