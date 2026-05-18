import styles from "./tables.module.css";

export function EmptyState({ label }: { label: string }) {
  return <p className={styles.empty}>{label}</p>;
}

export function sourceLabel(source?: { provider: string; providerInstanceId: string } | null): string {
  if (!source) return "n/a";
  return `${source.provider} / ${source.providerInstanceId}`;
}
