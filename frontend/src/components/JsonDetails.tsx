"use client";

import { useCallback, useRef, useState } from "react";
import styles from "./JsonDetails.module.css";

type JsonDetailsProps = {
  title: string;
  value: unknown;
};

export function JsonDetails({ title, value }: JsonDetailsProps) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    const text = preRef.current?.textContent ?? JSON.stringify(value, null, 2);
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [value]);

  return (
    <details className={styles.details}>
      <summary className={styles.summary}>{title}</summary>
      <div className={styles.content}>
        <div className={styles.header}>
          <span />
          <button className={styles.copyBtn} type="button" onClick={handleCopy}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <pre ref={preRef} className={styles.pre}>{JSON.stringify(value, null, 2)}</pre>
      </div>
    </details>
  );
}
