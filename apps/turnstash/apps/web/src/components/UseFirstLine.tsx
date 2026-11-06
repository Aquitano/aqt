import { providerLabels, type ProviderLimits } from "@aqt/turnstash-api";
import { cn } from "cn";

import { weekdayTime } from "../format";
import { useFirstOf } from "../limits-model";
import { ProviderIcon } from "./ProviderIcon";

const percent = (value: number) => `${Math.round(value)}%`;

export const UseFirstLine = ({
  providers,
  className,
}: {
  readonly providers: ReadonlyArray<ProviderLimits>;
  readonly className?: string;
}) => {
  const advice = useFirstOf(providers);
  if (advice === null) return null;
  return (
    <p className={cn("flex flex-wrap items-center gap-x-1.5", className)}>
      <ProviderIcon provider={advice.provider} className="size-3.5" />
      <span className="font-medium">Use {providerLabels[advice.provider]} first.</span>
      <span className="text-muted-foreground">
        {percent(advice.remaining)} left, resets {weekdayTime(advice.resetsAtMs)}, before{" "}
        {providerLabels[advice.thenProvider]} on {weekdayTime(advice.thenResetsAtMs)}.
      </span>
    </p>
  );
};
