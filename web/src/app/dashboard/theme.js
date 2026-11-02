// Fixed dark theme for the analytics dashboard (not light/dark-adaptive
// like the rest of the app - this screen deliberately commits to one look,
// matching the reference design). Colors are the dataviz skill's validated
// dark-surface values (references/palette.md) plus a brand green accent.
export const theme = {
  pageBg: "#05070c",
  sidebarBg: "#0a0e16",
  cardBg: "#10151f",
  cardBgAlt: "#0d1119",
  border: "rgba(255,255,255,0.08)",
  textPrimary: "#f5f6f8",
  textSecondary: "#9aa3b2",
  textMuted: "#6b7280",
  accent: "#22c55e", // brand accent (active nav, refresh button) - distinct from status "good"
};

// Categorical palette, dark-surface steps, fixed order (dataviz skill).
export const CATEGORICAL = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#9085e9"];
export const CATEGORY_OTHER = "#5b6472";

// Status palette (fixed, never themed - dataviz skill).
export const STATUS = {
  "Low stock": "#d03b3b",
  Overstocked: "#fab219",
  Stable: "#0ca30c",
};

// Advisory/stock-state colors keyed by TYPE, not by severity. Severity is
// too coarse to colour by: demand_spike and overstock are both "warning",
// which made their chips identical. Defined once here, and derived from
// STATUS above wherever a matching state already has a reserved hex, so
// Decision Support and the dashboard's Tracking table cannot drift apart.
export const ADVISORY_TYPE = {
  low_stock: STATUS["Low stock"], // same red as Tracking's "Low stock"
  // Orange, between that red and the amber below. It clears 3:1 on the card
  // background (6.5:1) and is a distinct hue from both, but the chips keep
  // their text labels so colour is never the only cue.
  demand_spike: "#f97316",
  overstock: STATUS.Overstocked, // same amber as Tracking's "Overstocked"
  no_action: STATUS.Stable, // same green as Tracking's "Stable"
};

// Sequential blue ramp, light->dark (dataviz skill) - used for the heatmap.
export const SEQUENTIAL = ["#cde2fb", "#86b6ef", "#3987e5", "#1c5cab", "#0d366b"];

export const DELTA_UP = "#0ca30c";
export const DELTA_DOWN = "#d03b3b";
