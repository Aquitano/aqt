"use client";

import { Activity, Database, PlugZap, TrendingUp } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import styles from "./AppShell.module.css";

const navItems = [
  { href: "/health-data", label: "Health Data", icon: Activity },
  { href: "/trends", label: "Trends", icon: TrendingUp },
  { href: "/provider-sync", label: "Provider Sync", icon: PlugZap },
  { href: "/ingestions", label: "Ingestions", icon: Database },
];

type AppShellProps = {
  children: ReactNode;
};

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname();

  return (
    <div className={styles.shell}>
      <aside className={styles.rail}>
        <Link className={styles.brand} href="/health-data">
          <span className={styles.brandPulse} aria-hidden="true" />
          <span className={styles.brandName}>
            aqt<em>health</em>
          </span>
        </Link>

        <nav className={styles.nav} aria-label="Primary navigation">
          {navItems.map((item) => {
            const isActive =
              pathname === item.href ||
              (item.href !== "/health-data" && pathname.startsWith(item.href));
            const Icon = item.icon;

            return (
              <Link
                aria-current={isActive ? "page" : undefined}
                className={isActive ? styles.navLinkActive : styles.navLink}
                href={item.href}
                key={item.href}
              >
                <Icon className={styles.navIcon} size={17} strokeWidth={2} aria-hidden="true" />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <p className={styles.railFoot}>local health hub</p>
      </aside>

      <main className={styles.content}>{children}</main>
    </div>
  );
}
