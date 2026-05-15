"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import styles from "./DateRangeForm.module.css";

type DateRangeFormProps = {
  fromDate: string;
  toDate: string;
};

export function DateRangeForm({ fromDate, toDate }: DateRangeFormProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const navigate = useCallback(
    (from: string, to: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("fromDate", from);
      params.set("toDate", to);
      router.push(`?${params.toString()}`);
    },
    [router, searchParams],
  );

  function applyPreset(days: number) {
    const now = new Date();
    const to = now.toISOString().slice(0, 10);
    const fromD = new Date(now);
    fromD.setDate(fromD.getDate() - days + 1);
    navigate(fromD.toISOString().slice(0, 10), to);
  }

  return (
    <form className={styles.form}>
      <div className={styles.field}>
        <span className={styles.fieldLabel}>From</span>
        <input className={styles.input} name="fromDate" type="date" defaultValue={fromDate} />
      </div>
      <div className={styles.field}>
        <span className={styles.fieldLabel}>To</span>
        <input className={styles.input} name="toDate" type="date" defaultValue={toDate} />
      </div>
      <button className={styles.submit} type="submit">Apply</button>
      <div className={styles.presets}>
        <button className={styles.preset} type="button" onClick={() => applyPreset(1)}>Today</button>
        <button className={styles.preset} type="button" onClick={() => applyPreset(7)}>7d</button>
        <button className={styles.preset} type="button" onClick={() => applyPreset(30)}>30d</button>
        <button className={styles.preset} type="button" onClick={() => applyPreset(90)}>90d</button>
      </div>
    </form>
  );
}
