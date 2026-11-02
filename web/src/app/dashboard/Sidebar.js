"use client";

import { useEffect, useState } from "react";
import {
  LayoutDashboard,
  TrendingUp,
  Lightbulb,
  ShoppingCart,
  Wrench,
  PackagePlus,
  Package,
  ChevronsLeft,
  ChevronsRight,
  LogOut,
} from "lucide-react";
import { theme } from "./theme";
import SignOutButton from "@/components/SignOutButton";
import Topbar from "./Topbar";

// `staff: true` marks the only destinations a staff account may reach -
// sales entry and service entry. Everything else is owner-only. This drives
// what renders in the nav; the matching server-side redirects in each
// page.js are what actually enforce it.
const NAV = [
  {
    section: "Analytics",
    items: [
      { href: "/dashboard", label: "Dashboard", key: "dashboard", icon: LayoutDashboard },
      { href: "/forecasting", label: "Forecasting", key: "forecasting", icon: TrendingUp },
      { href: "/decision-support", label: "Decision Support", key: "decision-support", icon: Lightbulb },
    ],
  },
  {
    section: "Operations",
    items: [
      { href: "/sales", label: "Sales Entry", key: "sales", icon: ShoppingCart, staff: true },
      { href: "/sales?tab=services", label: "Service", key: "services", icon: Wrench, staff: true },
      { href: "/stockin", label: "Stock In", key: "stockin", icon: PackagePlus },
      { href: "/products", label: "Products", key: "products", icon: Package },
    ],
  },
];

function navFor(role) {
  if (role === "owner") return NAV;
  return NAV.map((group) => ({ ...group, items: group.items.filter((i) => i.staff) })).filter(
    (group) => group.items.length > 0
  );
}

const COLLAPSE_KEY = "j1spa.sidebar.collapsed";

export default function Sidebar({ active = "dashboard", fullName, role }) {
  const [open, setOpen] = useState(false);
  // collapsed = rail mode (icons only) for md+ screens, e.g. iPad, where the
  // full-width static sidebar eats too much of the content area
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {
      // ignore (e.g. storage blocked)
    }
  }, []);

  function toggleCollapsed() {
    setCollapsed((v) => {
      const next = !v;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        // ignore
      }
      return next;
    });
  }

  // below md, the drawer sits over the page - block background scroll while it's open
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <>
      <Topbar fullName={fullName} role={role} />

      {/* mobile top bar - normal document flow (not fixed), so it pushes the
          page content down instead of floating over it; the page root needs
          flex-col on mobile (md:flex-row) for that stacking to take effect */}
      <div
        className="flex h-14 shrink-0 items-center gap-3 border-b px-4 md:hidden"
        style={{ backgroundColor: theme.sidebarBg, borderColor: theme.border }}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? "Close menu" : "Open menu"}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md"
          style={{ color: theme.textPrimary }}
        >
          {open ? (
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />
            </svg>
          )}
        </button>
        <p className="text-sm font-semibold" style={{ color: theme.textPrimary }}>
          J1SPA Analytics
        </p>
      </div>

      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-40 flex h-screen w-64 shrink-0 flex-col justify-between border-r px-4 py-5 transition-transform duration-200 ease-in-out md:static md:z-auto md:translate-x-0 md:transition-[width] md:duration-150 ${
          open ? "translate-x-0" : "-translate-x-full"
        } ${collapsed ? "md:w-[4.5rem] md:px-2" : "md:w-56"}`}
        style={{ backgroundColor: theme.sidebarBg, borderColor: theme.border }}
      >
        <div className="flex flex-col gap-6">
        <div className={`flex items-center gap-2 ${collapsed ? "md:justify-center" : "justify-between"}`}>
          <div className={collapsed ? "md:hidden" : "min-w-0"}>
            <p className="truncate text-sm font-semibold" style={{ color: theme.textPrimary }}>
              J1SPA Analytics
            </p>
            <p className="truncate text-xs" style={{ color: theme.textMuted }}>
              Decision Support System
            </p>
          </div>
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="hidden h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-white/5 md:flex"
            style={{ color: theme.textMuted }}
          >
            {collapsed ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
          </button>
        </div>

        {navFor(role).map((group) => (
          <div key={group.section} className="flex flex-col gap-1">
            <p
              className={`mb-1 px-2 text-[10px] font-semibold uppercase tracking-wide ${collapsed ? "md:hidden" : ""}`}
              style={{ color: theme.textMuted }}
            >
              {group.section}
            </p>
            {group.items.map((item) => {
              const isActive = item.key === active;
              const Icon = item.icon;
              return (
                <a
                  key={item.key}
                  href={item.href}
                  title={collapsed ? item.label : undefined}
                  className={`flex items-center gap-2 rounded px-2 py-1.5 text-sm ${collapsed ? "md:justify-center" : ""}`}
                  style={
                    isActive
                      ? { backgroundColor: theme.accent, color: "#05230f", fontWeight: 600 }
                      : { color: theme.textSecondary }
                  }
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className={collapsed ? "md:hidden" : "truncate"}>{item.label}</span>
                </a>
              );
            })}
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-2 border-t pt-3" style={{ borderColor: theme.border }}>
        <div className={`min-w-0 ${collapsed ? "md:hidden" : ""}`}>
          <p className="truncate text-sm" style={{ color: theme.textPrimary }} title={fullName}>
            {fullName}
          </p>
          <p className="text-xs capitalize" style={{ color: theme.textMuted }}>
            {role}
          </p>
        </div>
          <SignOutButton
            className={`w-full rounded border border-white/10 py-1.5 text-center text-xs text-zinc-300 hover:bg-white/5 ${
              collapsed ? "flex items-center justify-center px-0 md:px-2" : "px-2"
            }`}
            title={collapsed ? "Sign out" : undefined}
          >
            {collapsed ? <LogOut className="h-4 w-4 md:block hidden" /> : null}
            <span className={collapsed ? "md:hidden" : ""}>Sign out</span>
          </SignOutButton>
        </div>
      </aside>
    </>
  );
}
