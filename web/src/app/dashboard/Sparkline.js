"use client";

import { LineChart, Line, Tooltip, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { theme, DELTA_UP } from "./theme";
import { formatManilaDate } from "@/lib/ledger";

// Axis-free trend line with a dot on the latest point. The hover tooltip is
// the only floating element, so it's the only thing that gets a shadow.
export default function Sparkline({ data, color = DELTA_UP, suffix = "%" }) {
  if (!data || data.length < 2) return null;

  const last = data.length - 1;
  // Manila, like every other date in the app - toLocaleDateString with no
  // timeZone renders in whatever zone the viewer's machine is in.
  const label = (d) => `90 days to ${formatManilaDate(d)}`;

  return (
    <ResponsiveContainer width="100%" height={64}>
      <LineChart data={data} margin={{ top: 6, right: 6, left: 6, bottom: 6 }}>
        <XAxis dataKey="period" hide />
        <YAxis hide domain={["dataMin", "dataMax"]} />
        <Tooltip
          cursor={false}
          formatter={(v) => [`${v}${suffix}`, "Margin"]}
          labelFormatter={label}
          contentStyle={{
            background: theme.cardBg,
            border: `1px solid ${theme.border}`,
            borderRadius: 6,
            fontSize: 12,
            color: theme.textPrimary,
            boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
          }}
          labelStyle={{ color: theme.textSecondary }}
          itemStyle={{ color: theme.textPrimary }}
        />
        <Line
          type="monotone"
          dataKey="margin"
          stroke={color}
          strokeWidth={2}
          dot={(p) =>
            p.index === last ? (
              <circle key="end" cx={p.cx} cy={p.cy} r={3.5} fill={color} stroke={theme.cardBg} strokeWidth={2} />
            ) : (
              <g key={p.index} />
            )
          }
          activeDot={{ r: 3.5, fill: color, stroke: theme.cardBg, strokeWidth: 2 }}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
