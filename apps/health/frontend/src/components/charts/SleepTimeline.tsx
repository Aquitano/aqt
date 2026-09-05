type SleepTimelineProps = {
  from?: string;
  to?: string;
  timeline: Array<{
    stage: string;
    startAt: string;
    endAt: string;
  }>;
};

const stageClass: Record<string, string> = {
  awake: "var(--warning)",
  restless: "#d99a6c",
  asleep: "#8b9dff",
  light: "#45d6a4",
  deep: "#5d77e8",
  rem: "#b88be0",
  unknown: "var(--fg-muted)",
};

export function SleepTimeline({ from, to, timeline }: SleepTimelineProps) {
  const start = from ? new Date(from).getTime() : 0;
  const end = to ? new Date(to).getTime() : start + 1;
  const range = Math.max(1, end - start);

  return (
    <svg viewBox="0 0 240 42" role="img" aria-label="Sleep timeline" preserveAspectRatio="none">
      <line x1="0" x2="240" y1="21" y2="21" stroke="currentColor" opacity="0.18" strokeWidth="2" />
      {timeline.map((segment) => {
        const segmentStart = new Date(segment.startAt).getTime();
        const segmentEnd = new Date(segment.endAt).getTime();
        const x = ((segmentStart - start) / range) * 240;
        const width = Math.max(1, ((segmentEnd - segmentStart) / range) * 240);
        return (
          <rect
            key={`${segment.stage}-${segment.startAt}-${segment.endAt}`}
            x={x}
            y="9"
            width={width}
            height="24"
            rx="2"
            fill={stageClass[segment.stage] ?? stageClass.unknown}
          />
        );
      })}
    </svg>
  );
}
