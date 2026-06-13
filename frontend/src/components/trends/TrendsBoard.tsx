"use client";

import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react";
import { useState } from "react";
import type { TrendChange, TrendStat } from "@/lib/trends";
import { insightSentence } from "@/lib/trends";
import { Sparkline } from "./Sparkline";
import { TrendChart } from "./TrendChart";
import styles from "./TrendsBoard.module.css";

type TrendsBoardProps = {
  stats: TrendStat[];
};

export function TrendsBoard({ stats }: TrendsBoardProps) {
  const [selectedKey, setSelectedKey] = useState(stats[0]?.key ?? "");
  const selected = stats.find((stat) => stat.key === selectedKey) ?? stats[0];

  if (!selected) {
    return <p className={styles.empty}>No trend data in this range yet. Sync a provider to populate it.</p>;
  }

  return (
    <div className={styles.board}>
      <section className={styles.focus} aria-live="polite">
        <div className={styles.focusHead}>
          <div>
            <p className={styles.focusEyebrow} style={{ color: selected.color }}>
              {selected.label}
            </p>
            <p className={styles.focusValue}>
              {formatValue(selected.latest, selected.unit)}
              <span className={styles.focusUnit}>{unitLabel(selected.unit)}</span>
            </p>
            <p className={styles.insight}>{insightSentence(selected)}</p>
          </div>
          <div className={styles.focusStats}>
            <FocusStat label="7-day" change={selected.change7d} stat={selected} />
            <FocusStat label="30-day" change={selected.change30d} stat={selected} />
            <div className={styles.focusStat}>
              <span className={styles.focusStatLabel}>Average</span>
              <span className={styles.focusStatValue}>{formatValue(selected.average, selected.unit)}</span>
            </div>
            <div className={styles.focusStat}>
              <span className={styles.focusStatLabel}>Range</span>
              <span className={styles.focusStatValue}>
                {formatValue(selected.min, selected.unit)} – {formatValue(selected.max, selected.unit)}
              </span>
            </div>
          </div>
        </div>
        <TrendChart
          points={selected.points}
          color={selected.color}
          unit={selected.unit}
          label={selected.label}
          average={selected.average}
        />
      </section>

      <div className={styles.cards}>
        {stats.map((stat) => {
          const active = stat.key === selected.key;
          return (
            <button
              key={stat.key}
              type="button"
              className={active ? styles.cardActive : styles.card}
              onClick={() => setSelectedKey(stat.key)}
              aria-pressed={active}
              style={{ "--card-accent": stat.color } as React.CSSProperties}
            >
              <span className={styles.cardLabel}>{stat.label}</span>
              <span className={styles.cardValue}>
                {formatValue(stat.latest, stat.unit)}
                <span className={styles.cardUnit}>{unitLabel(stat.unit)}</span>
              </span>
              <span className={styles.cardChips}>
                <ChangeChip change={stat.change7d} stat={stat} window="7d" />
                <ChangeChip change={stat.change30d} stat={stat} window="30d" />
              </span>
              <Sparkline
                className={styles.cardSpark}
                values={stat.points.map((point) => point.value)}
                color={stat.color}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function FocusStat({ label, change, stat }: { label: string; change: TrendChange | null; stat: TrendStat }) {
  return (
    <div className={styles.focusStat}>
      <span className={styles.focusStatLabel}>{label}</span>
      <span className={styles.focusStatValue}>
        <ChangeChip change={change} stat={stat} window="" />
      </span>
    </div>
  );
}

function ChangeChip({
  change,
  stat,
  window,
}: {
  change: TrendChange | null;
  stat: TrendStat;
  window: string;
}) {
  if (!change || Math.abs(change.abs) < 1e-6) {
    return (
      <span className={`${styles.chip} ${styles.chipFlat}`}>
        <ArrowRight size={13} aria-hidden="true" />
        {window ? <span className={styles.chipWindow}>{window}</span> : "flat"}
      </span>
    );
  }
  const up = change.abs > 0;
  const tone = chipTone(stat.goodWhen, up);
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`${styles.chip} ${styles[tone]}`}>
      <Icon size={13} aria-hidden="true" />
      {formatDelta(change, stat.unit)}
      {window ? <span className={styles.chipWindow}>{window}</span> : null}
    </span>
  );
}

function chipTone(goodWhen: TrendStat["goodWhen"], up: boolean): "chipUp" | "chipDown" | "chipNeutral" {
  if (!goodWhen) return "chipNeutral";
  const good = (goodWhen === "up" && up) || (goodWhen === "down" && !up);
  return good ? "chipUp" : "chipDown";
}

function unitLabel(unit: string): string {
  if (!unit || unit === "steps" || unit === "h") return "";
  return ` ${unit}`;
}

function formatValue(value: number | null, unit: string): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (unit === "steps") return new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(value);
  if (unit === "h") {
    const totalMinutes = Math.round(value * 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  return new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(value);
}

function formatDelta(change: TrendChange, unit: string): string {
  const sign = change.abs > 0 ? "+" : "−";
  const magnitude = Math.abs(change.abs);
  if (unit === "steps") {
    return `${sign}${new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(magnitude)}`;
  }
  if (unit === "h") {
    const minutes = Math.round(magnitude * 60);
    return `${sign}${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
  }
  const formatted = new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(magnitude);
  return unit ? `${sign}${formatted} ${unit}` : `${sign}${formatted}`;
}
