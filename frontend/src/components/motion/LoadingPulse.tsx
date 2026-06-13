import { PulseLine } from "@/components/motion/PulseLine";
import styles from "./LoadingPulse.module.css";

type LoadingPulseProps = {
  label?: string;
};

/**
 * The app's loading affordance: a quick heartbeat sweep with a caption. The
 * EKG trace only animates here (while data is in flight), not perpetually in
 * the page chrome.
 */
export function LoadingPulse({ label = "Loading health data…" }: LoadingPulseProps) {
  return (
    <div className={styles.wrap} role="status" aria-live="polite">
      <PulseLine className={styles.pulse} duration={1.8} repeatDelay={0.15} />
      <span className={styles.label}>{label}</span>
    </div>
  );
}
