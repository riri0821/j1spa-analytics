/**
 * Display names for the Cashier / Recorded by columns.
 *
 * The profiles policy lets a user read their own row and nothing else (an
 * owner reads all of them), which is the right shape for a table holding
 * usernames - they are email addresses - plus everyone's role and active
 * flag. It also meant the embedded `profiles(full_name)` came back empty
 * for every sale a staff member had not recorded themselves, so a staff
 * user saw "Former staff" against all of their colleagues' work.
 *
 * profile_names() is a security definer function returning only (id,
 * full_name), so the policy stays as it is. See
 * sql/migrations/035_hide_provenance_and_names.sql.
 */
export async function fetchProfileNames(supabase) {
  const { data, error } = await supabase.rpc("profile_names");
  if (error) return { names: new Map(), error: error.message };
  return { names: new Map((data ?? []).map((p) => [p.id, p.full_name])), error: null };
}

/**
 * "Former staff" means the account is gone, which is a real state: user_id
 * on sales, services and stock_movements is nullable precisely so deleting
 * a staff account does not block on their history. A name that is merely
 * missing is a different thing and is not labelled as that one - before
 * migration 035 the two were indistinguishable on screen, and every row
 * recorded by somebody else read as a departure.
 */
export function cashierName(names, userId) {
  if (userId == null) return "Former staff";
  return names.get(userId) || "—";
}
