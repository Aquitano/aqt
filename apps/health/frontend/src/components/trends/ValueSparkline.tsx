import { useId } from "react";

type ValueSparklineProps = {
  values: number[];
  color: string;
  width?: number;
  height?: number;
  className?: string;
};

/** Minimal inline trend glyph: an area-filled polyline normalized to its range. */
export function ValueSparkline({ values, color, width = 120, height = 36, className }: ValueSparklineProps) {
  const gradientId = useId();
  if (values.length === 0) {
    return <svg className={className} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" />;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const stepX = values.length > 1 ? width / (values.length - 1) : 0;
  const pad = 3;
  const usable = height - pad * 2;

  const points = values.map((value, index) => {
    const x = values.length > 1 ? index * stepX : width / 2;
    const y = pad + usable - ((value - min) / span) * usable;
    return [x, y] as const;
  });

  const line = points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const area = `${line} L${width} ${height} L0 ${height} Z`;

  return (
    <svg
      className={className}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.32" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} />
      <path
        d={line}
        stroke={color}
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={points.at(-1)![0]} cy={points.at(-1)![1]} r="2.4" fill={color} />
    </svg>
  );
}
