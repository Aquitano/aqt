import type { HealthDayBucket } from "@/lib/types";

type BarsProps = {
  buckets: HealthDayBucket[];
  height?: number;
};

export function Bars({ buckets, height = 56 }: BarsProps) {
  const width = 240;
  const max = Math.max(...buckets.map((bucket) => bucket.value ?? 0), 1);
  const gap = 1;
  const barWidth = buckets.length ? width / buckets.length : width;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Bucketed bars" preserveAspectRatio="none">
      <line x1="0" x2={width} y1={height - 4} y2={height - 4} stroke="currentColor" opacity="0.18" />
      {buckets.map((bucket, index) => {
        const value = bucket.value ?? 0;
        const barHeight = Math.max(0, (value / max) * (height - 8));
        return (
          <rect
            key={`${bucket.startAt}-${bucket.endAt}`}
            x={index * barWidth}
            y={height - 4 - barHeight}
            width={Math.max(1, barWidth - gap)}
            height={barHeight}
            rx="1"
            fill="currentColor"
            opacity={value > 0 ? 0.9 : 0}
          />
        );
      })}
    </svg>
  );
}
