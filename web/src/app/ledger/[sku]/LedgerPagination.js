"use client";

import { useRouter } from "next/navigation";
import PaginationControls from "@/components/PaginationControls";

// Paging for the ledger lives in the URL next to ?from/?to, the same as the
// date range does, so an owner can hand over a link to the exact page of the
// stock card they are reading. The server clamps whatever arrives, so these
// buttons only ever have to build a plausible number.
export default function LedgerPagination({ sku, from, to, page, totalPages, rangeStart, rangeEnd, total }) {
  const router = useRouter();

  function goTo(next) {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    params.set("page", String(next));
    router.push(`/ledger/${encodeURIComponent(sku)}?${params.toString()}`);
  }

  return (
    <PaginationControls
      rangeStart={rangeStart}
      rangeEnd={rangeEnd}
      total={total}
      page={page}
      totalPages={totalPages}
      onPageChange={goTo}
      unitLabel="Rows"
      showEdges
      showPageIndicator
      showJump
    />
  );
}
