"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, useCallback, useEffect } from "react";
import styles from "./DateRangeForm.module.css";

type DateRangeFormProps = {
  fromDate: string;
  toDate: string;
};

export function DateRangeForm({ fromDate, toDate }: DateRangeFormProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const browserTimezone =
    Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  useEffect(() => {
    if (searchParams.get("timezone")) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set("timezone", browserTimezone);
    router.replace(`?${params.toString()}`);
  }, [browserTimezone, router, searchParams]);

  const navigate = useCallback(
    (from: string, to: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("fromDate", from);
      params.set("toDate", to);
      params.set("timezone", params.get("timezone") ?? browserTimezone);
      router.push(`?${params.toString()}`);
    },
    [browserTimezone, router, searchParams],
  );

  function applyPreset(days: number) {
    const to = localDateInputValue(new Date());
    const now = new Date(`${to}T00:00:00`);
    const fromD = new Date(now);
    fromD.setDate(fromD.getDate() - days + 1);
    navigate(localDateInputValue(fromD), to);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const from = String(form.get("fromDate") ?? fromDate);
    const to = String(form.get("toDate") ?? toDate);
    navigate(from, to);
  }

  return (
    <form className={styles.form} onSubmit={onSubmit}>
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

function localDateInputValue(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
