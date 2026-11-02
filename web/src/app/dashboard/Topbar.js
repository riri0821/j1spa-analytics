"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Settings, LogOut } from "lucide-react";
import { theme } from "./theme";
import SignOutButton from "@/components/SignOutButton";

function initials(name) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase();
}

export default function Topbar({ fullName, role }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    function onPointerDown(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, []);

  return (
    <div className="fixed right-3 top-3 z-50 flex items-center gap-2 md:right-6 md:top-4">
      <div className="relative" ref={menuRef}>
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          className="flex items-center gap-2 rounded-full border py-1 pl-1 pr-2"
          style={{ backgroundColor: theme.cardBg, borderColor: theme.border }}
        >
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
            style={{ backgroundColor: theme.accent, color: "#05230f" }}
          >
            {initials(fullName)}
          </span>
          <span className="hidden text-left sm:block">
            <span className="block max-w-[8rem] truncate text-xs font-medium" style={{ color: theme.textPrimary }}>
              {fullName}
            </span>
            <span className="block text-[10px] capitalize" style={{ color: theme.textMuted }}>
              {role}
            </span>
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0" style={{ color: theme.textMuted }} />
        </button>

        {menuOpen && (
          <div
            className="absolute right-0 top-11 w-48 overflow-hidden rounded-lg border shadow-lg"
            style={{ backgroundColor: theme.cardBg, borderColor: theme.border }}
          >
            {/* /settings is owner-only (it manages staff accounts), so staff
                get Sign Out as the only item in this menu. */}
            {role === "owner" && (
              <a
                href="/settings"
                className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-white/5"
                style={{ color: theme.textSecondary }}
              >
                <Settings className="h-4 w-4" />
                Account Settings
              </a>
            )}
            <SignOutButton className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-white/5" style={{ color: theme.textSecondary }}>
              <LogOut className="h-4 w-4" />
              Sign Out
            </SignOutButton>
          </div>
        )}
      </div>
    </div>
  );
}
