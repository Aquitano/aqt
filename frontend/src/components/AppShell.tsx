"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import styles from "./AppShell.module.css";

const navItems = [
  { href: "/health-data", label: "Health Data" },
  { href: "/provider-sync", label: "Provider Sync" },
  { href: "/ingestions", label: "Ingestions" },
];

type AppShellProps = {
  children: ReactNode;
};

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname();

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <Link className={styles.brand} href="/health-data">
          <span className={styles.brandMark}>aqt</span>
          <span className={styles.brandText}>health</span>
        </Link>
        <nav className={styles.nav} aria-label="Primary navigation">
          {navItems.map((item) => {
            const isActive =
              pathname === item.href || (item.href !== "/health-data" && pathname.startsWith(item.href));

            return (
              <Link
                aria-current={isActive ? "page" : undefined}
                className={isActive ? styles.navLinkActive : styles.navLink}
                href={item.href}
                key={item.href}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </header>
      <main className={styles.content}>{children}</main>
    </div>
  );
}
