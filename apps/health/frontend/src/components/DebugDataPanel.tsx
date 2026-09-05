import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import styles from "./DebugDataPanel.module.css";

type DebugDataPanelProps = {
  children: ReactNode;
};

/**
 * Collapsed-by-default container for the raw source tables. The data is already
 * fetched for the charts and highlights above, so this just re-presents it for
 * inspection without any extra requests. Pure CSS disclosure (`<details>`), so
 * it works without JavaScript and stays out of the way of the user-facing view.
 */
export function DebugDataPanel({ children }: DebugDataPanelProps) {
  return (
    <details className={styles.panel} data-reveal>
      <summary className={styles.summary}>
        <ChevronRight className={styles.chevron} size={16} aria-hidden="true" />
        <span className={styles.title}>Raw data</span>
        <span className={styles.hint}>Source tables — expand to inspect</span>
      </summary>
      <div className={styles.body}>
        <div className="grid">{children}</div>
      </div>
    </details>
  );
}
