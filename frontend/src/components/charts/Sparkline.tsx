import type { HealthDayBucket } from "@/lib/types";

type SparklineProps = {
  buckets: HealthDayBucket[];
  height?: number;
};

export function Sparkline({ buckets, height = 56 }: SparklineProps) {
  const width = 240;
  const values = buckets.map((bucket) => bucket.value).filter((value): value is number => value !== undefined);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const range = max - min || 1;
  const points = buckets
    .map((bucket, index) => {
      const x = buckets.length <= 1 ? 0 : (index / (buckets.length - 1)) * width;
      const value = bucket.value ?? min;
      const y = height - ((value - min) / range) * (height - 8) - 4;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Trend" preserveAspectRatio="none">
      <line x1="0" x2={width} y1={height - 4} y2={height - 4} stroke="currentColor" opacity="0.18" />
      {buckets.length ? (
        <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
      ) : null}
    </svg>
  );
}
