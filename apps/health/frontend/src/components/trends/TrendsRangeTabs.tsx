"use client";

import { useRouter, useSearchParams } from "next/navigation";
import styles from "./TrendsRangeTabs.module.css";

type TrendsRangeTabsProps = {
  days: number;
  options: readonly number[];
};

export function TrendsRangeTabs({ days, options }: TrendsRangeTabsProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function select(next: number) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("days", String(next));
    router.push(`?${params.toString()}`);
  }

  return (
    <div className={styles.tabs} role="group" aria-label="Trend window">
      {options.map((option) => {
        const active = option === days;
        return (
          <button
            key={option}
            type="button"
            className={active ? styles.tabActive : styles.tab}
            onClick={() => select(option)}
            aria-pressed={active}
          >
            {option}d
          </button>
        );
      })}
    </div>
  );
}
