/**
 * Deciding whether a Decision Support run is worth recording.
 *
 * evaluateDecisionSupport() used to insert its whole advisory set into
 * `alerts` on every page load and every Refresh, which grew the table to
 * ~149,000 rows of mostly identical repeats. Nothing displays alerts; its
 * only reader is api/products/delete, which counts a product's rows to
 * decide "deactivate instead of delete". So a run only needs recording when
 * the advisory set itself is different from the last one recorded.
 *
 * "Different" is deliberately narrow: the sorted set of
 * (product_id, alert_type, severity). Stock counts, forecasts and
 * days-to-depletion move on nearly every run without the advice changing at
 * all, and including them is what made every run look new.
 *
 * Pure functions over plain objects - checked by
 * web/scripts/alertsBatch.check.mjs (`npm run check:alerts`).
 */

// Rows arrive from two places with two spellings: freshly built advisories
// (productId / type) and rows read back out of `alerts` (product_id /
// alert_type). Both are accepted so the two sides of a comparison cannot
// drift apart through a mapping step done twice.
function entryKey(entry) {
  const productId = entry.productId ?? entry.product_id;
  const alertType = entry.type ?? entry.alert_type;
  // product_id comes back from PostgREST as a number and goes in as one, but
  // String() keeps the two sides comparable whichever way a caller holds it.
  return `${String(productId)}|${alertType}|${entry.severity}`;
}

/**
 * A canonical string for an advisory set, independent of row order: the
 * sorted (product_id, alert_type, severity) triples. Sorted as strings,
 * which is not numeric order for the ids - it does not need to be, only the
 * same order every time.
 *
 * `|` and `\n` are safe separators here because every field is either a
 * number or one of the alert_type / alert_severity enum labels.
 */
export function advisoryFingerprint(entries) {
  return (entries ?? [])
    .map(entryKey)
    .sort()
    .join("\n");
}

/** Whether two advisory sets would give the same advice. */
export function sameAdvisorySet(a, b) {
  return advisoryFingerprint(a) === advisoryFingerprint(b);
}

/**
 * PostgREST caps a single insert the same way it caps a read, and a batch is
 * only 120-360 rows today, but the catalog is the only thing keeping it
 * under the cap - so the insert is chunked regardless.
 */
export const ALERT_INSERT_CHUNK = 1000;

export function chunkRows(rows, size = ALERT_INSERT_CHUNK) {
  const chunks = [];
  for (let i = 0; i < rows.length; i += size) chunks.push(rows.slice(i, i + size));
  return chunks;
}
