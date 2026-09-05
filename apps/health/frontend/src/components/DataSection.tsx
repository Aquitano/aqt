import type { ReactNode } from "react";

import type { ApiResult } from "@/lib/types";

import { ErrorNotice } from "./ErrorNotice";

import styles from "./DataSection.module.css";

type DataSectionProps<T> = {
  title: string;
  result: ApiResult<T>;
  children: (data: T) => ReactNode;
};

export function DataSection<T>({ title, result, children }: DataSectionProps<T>) {
  const count = result.ok ? itemCount(result.data) : undefined;

  return (
    <section className={styles.section}>
      <div className={styles.heading}>
        <h2>{title}</h2>
        {count !== undefined ? <span className={styles.count}>{count}</span> : null}
      </div>
      <ErrorNotice result={result} />
      {result.ok ? children(result.data) : null}
    </section>
  );
}

/** Response payloads carry their rows under `items`; anything else renders without a count. */
function itemCount<T>(data: T): number | undefined {
  if (typeof data !== "object" || data === null || !("items" in data)) return undefined;
  return Array.isArray(data.items) ? data.items.length : undefined;
}
