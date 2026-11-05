import { providerLabels, type ProviderLimits } from "@aqt/turnstash-api";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";

import { weekdayTime } from "../format";
import { openWindowOf } from "../limits-model";
import { UseFirstLine } from "../routes/LimitsPage";
import { ProviderIcon } from "./ProviderIcon";
import { surface } from "./Section";

const Meter = ({ limits }: { readonly limits: ProviderLimits }) => {
  const series = limits.series[0];
  const open = series === undefined ? null : openWindowOf(series);
  const left = open === null ? 100 : 100 - open.usedPercent;
  return (
    <Link
      to="/limits"
      className="flex min-w-44 flex-1 flex-col gap-1.5 rounded-lg outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <span className="flex items-baseline justify-between gap-3">
        <span className="inline-flex items-center gap-1.5 font-medium">
          <ProviderIcon provider={limits.provider} className="size-3.5" />
          {providerLabels[limits.provider]}
        </span>
        <span className="font-medium">{Math.round(left)}% left</span>
      </span>
      <span className="block h-1 overflow-hidden rounded-full bg-muted">
        <span
          className="block h-full rounded-full"
          style={{ width: `${left}%`, background: `var(--provider-${limits.provider})` }}
        />
      </span>
      <span className="text-xs text-muted-foreground">
        {open === null
          ? "Next window starts on first use"
          : `Resets ${weekdayTime(Date.parse(open.resetsAt))}`}
      </span>
    </Link>
  );
};

export const LimitsStrip = ({
  providers,
}: {
  readonly providers: ReadonlyArray<ProviderLimits>;
}) => {
  const withReadings = providers.filter((limits) => limits.series.length > 0);
  if (withReadings.length === 0) return null;
  return (
    <section aria-label="Plan limits" className={cn(surface, "flex flex-col gap-3 p-4 sm:px-6")}>
      <div className="flex flex-wrap gap-x-8 gap-y-4">
        {withReadings.map((limits) => (
          <Meter key={limits.provider} limits={limits} />
        ))}
      </div>
      <UseFirstLine providers={withReadings} className="text-[13px]" />
    </section>
  );
};
