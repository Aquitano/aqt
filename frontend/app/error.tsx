"use client";

import styles from "./error.module.css";

export default function Error({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section className={styles.panel}>
      <h2>Something went wrong</h2>
      <span className={styles.message}>
        An unexpected error occurred.
      </span>
      <button className={styles.retry} onClick={reset} type="button">
        Try again
      </button>
    </section>
  );
}
