import type { ApiResult } from "@/lib/types";
import styles from "./ErrorNotice.module.css";

type ErrorNoticeProps<T> = {
  result: ApiResult<T>;
};

const AlertIcon = () => (
  <svg className={styles.icon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="8" x2="12" y2="12" />
    <line x1="12" y1="16" x2="12.01" y2="16" />
  </svg>
);

export function ErrorNotice<T>({ result }: ErrorNoticeProps<T>) {
  if (result.ok) return null;

  return (
    <div className={`${styles.notice} ${styles.error}`}>
      <AlertIcon />
      <span>
        {result.status ? <span className={styles.status}>HTTP {result.status}: </span> : null}
        {result.message}
      </span>
    </div>
  );
}
