import { theme } from "./theme";

export default function Card({ title, subtitle, actions, children }) {
  return (
    <div
      className="flex flex-col rounded-lg border p-4"
      style={{ backgroundColor: theme.cardBg, borderColor: theme.border }}
    >
      {/* flex-wrap, and `actions` no longer shrink-0. shrink-0 meant the
          header row could not be narrower than title + actions laid side by
          side, so on a phone the Tracking card's extended pagination strip
          widened the card and pushed the page sideways instead of wrapping.
          Now the actions drop to their own line when they do not fit beside
          the title, and min-w-0 lets their own flex-wrap split them further
          if that line is still too narrow.

          Unchanged at desktop width: a flex item only shrinks when space is
          short, and these titles are a few words, so with room to spare
          nothing wraps and nothing shrinks. */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold" style={{ color: theme.textPrimary }}>
            {title}
          </h2>
          {subtitle && (
            <p className="text-xs" style={{ color: theme.textMuted }}>
              {subtitle}
            </p>
          )}
        </div>
        {actions && <div className="min-w-0">{actions}</div>}
      </div>
      <div className={`min-h-0 flex-1 ${subtitle || actions ? "mt-3" : "mt-1"}`}>{children}</div>
    </div>
  );
}
