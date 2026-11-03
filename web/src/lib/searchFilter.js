/**
 * Putting user-typed search text into a PostgREST filter safely.
 *
 * Two shapes are in use and they need different treatment:
 *
 *   .ilike("sku", value)                     - value is its own argument
 *   .or("name.ilike.%x%,sku.ilike.%x%")      - value is inside a filter string
 *
 * The screens used to handle the second by STRIPPING the characters that
 * would break it - `(term ?? "").replace(/[,()]/g, "")`. A blocklist, so it
 * left the LIKE wildcards `%` and `_` and the escape `\` alone, and it made
 * a supplier called "Acme, Inc." unsearchable. Escaping covers everything
 * and keeps the text searchable.
 */

/**
 * Escape the three characters SQL LIKE/ILIKE treats as special, so the term
 * matches literally. `\` is LIKE's own escape character and has to go first,
 * which `replace` with one character class does for free.
 *
 * This is what a value passed as its own argument needs - nothing else sees
 * it, so there is no filter syntax to worry about.
 */
export function escapeLikeTerm(term) {
  return String(term ?? "").replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * An `or=` filter matching `term` against every one of `fields`.
 *
 * The value is wrapped in double quotes, which is PostgREST's own mechanism
 * for a value containing reserved characters - inside them a comma or a
 * parenthesis is just text, so the filter tree cannot be broken out of. Two
 * layers of escaping stack up and the order matters:
 *
 *   1. the LIKE layer (escapeLikeTerm): % _ \ -> \% \_ \\
 *   2. the quoting layer: \ -> \\ and " -> \", which PostgREST unescapes
 *      back to exactly what step 1 produced
 *
 * Returns "" for an empty term, so callers can skip the filter entirely.
 *
 * One character this cannot cover: PostgREST aliases `*` to `%` for
 * like/ilike, and does so before any LIKE escaping applies - tested against
 * this project's PostgREST, where the quoted, backslash-escaped and bare
 * forms all matched every row. So a search for a literal asterisk matches
 * everything instead. Harmless (the caller can already read the whole table)
 * and no worse than the stripping it replaces, which did not handle `*`
 * either.
 */
export function orIlikeFilter(fields, term) {
  const trimmed = String(term ?? "").trim();
  if (!trimmed) return "";
  const quoted = escapeLikeTerm(trimmed).replace(/[\\"]/g, (c) => `\\${c}`);
  return fields.map((f) => `${f}.ilike."%${quoted}%"`).join(",");
}
