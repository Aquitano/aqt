import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@aqt/ui/components/collapsible";
import { Predicate } from "effect";
import { ChevronRightIcon } from "lucide-react";

import { int, json } from "../format";
import { toolSummary, type ToolOutcome, type ToolStep } from "../transcript";
import { HighlightedText } from "./HighlightedText";
import { codeBlock } from "./MessagePartView";

const trigger =
  "flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-xs outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50";

const status = (outcome: ToolOutcome | undefined) => {
  if (outcome === undefined || !outcome.known)
    return { label: "status unknown", dot: "bg-muted-foreground/40" };
  return outcome.failed
    ? { label: "failed", dot: "bg-destructive" }
    : { label: "ok", dot: "bg-success" };
};

const ToolRow = ({
  step,
  outcome,
  query,
  defaultOpen,
}: {
  readonly step: ToolStep;
  readonly outcome: ToolOutcome | undefined;
  readonly query: string | undefined;
  readonly defaultOpen: boolean;
}) => {
  const { label, dot } = status(outcome);
  const input = step.call.input;
  return (
    <Collapsible defaultOpen={defaultOpen}>
      <CollapsibleTrigger className={`group/tool ${trigger}`}>
        <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground transition-transform group-data-panel-open/tool:rotate-90" />
        <span className={`size-1.5 shrink-0 rounded-full ${dot}`} title={label} />
        <span className="sr-only">{label}</span>
        <span className="shrink-0 font-medium">{step.call.name}</span>
        <span className="min-w-0 truncate font-mono text-muted-foreground">
          <HighlightedText text={toolSummary(input)} query={query} />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex min-w-0 flex-col gap-1.5 pt-1 pb-3 pl-7 text-xs text-muted-foreground">
        Input
        <pre className={codeBlock}>
          <HighlightedText text={Predicate.isString(input) ? input : json(input)} query={query} />
        </pre>
        Output
        <pre className={codeBlock}>
          <HighlightedText text={outcome?.output ?? "(no output recorded)"} query={query} />
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
};

const tally = (steps: ReadonlyArray<ToolStep>): string => {
  const counts = new Map<string, number>();
  for (const step of steps) counts.set(step.call.name, (counts.get(step.call.name) ?? 0) + 1);
  const ranked = [...counts].toSorted((a, b) => b[1] - a[1]);
  const shown = ranked.slice(0, 4).map(([name, count]) => `${name} ${count}`);
  return ranked.length > 4 ? `${shown.join(" · ")} · ${ranked.length - 4} more` : shown.join(" · ");
};

const targets = (step: ToolStep, key: string | undefined) =>
  key !== undefined && (step.messageKey === key || step.resultKey === key);

// Short runs show every call; longer ones fold behind a count so the agent's text stays readable.
const foldAbove = 3;

export const ToolRun = ({
  steps,
  outcomes,
  query,
  targetedKey,
}: {
  readonly steps: ReadonlyArray<ToolStep>;
  readonly outcomes: ReadonlyMap<string, ToolOutcome>;
  readonly query: string | undefined;
  readonly targetedKey: string | undefined;
}) => {
  const rows = steps.map((step) => (
    <ToolRow
      key={step.call.toolKey}
      step={step}
      outcome={outcomes.get(step.call.toolKey)}
      query={query}
      defaultOpen={targets(step, targetedKey)}
    />
  ));
  if (steps.length <= foldAbove) return <div className="flex flex-col">{rows}</div>;
  const failed = steps.filter((step) => outcomes.get(step.call.toolKey)?.failed === true).length;
  return (
    <Collapsible defaultOpen={steps.some((step) => targets(step, targetedKey))}>
      <CollapsibleTrigger className={`group/run ${trigger} text-muted-foreground`}>
        <ChevronRightIcon className="size-3 shrink-0 transition-transform group-data-panel-open/run:rotate-90" />
        <span className="shrink-0 font-medium text-foreground">{int(steps.length)} tool calls</span>
        <span className="min-w-0 truncate">{tally(steps)}</span>
        {failed > 0 && <span className="shrink-0 text-destructive">{int(failed)} failed</span>}
      </CollapsibleTrigger>
      <CollapsibleContent className="ml-3.5 flex flex-col border-l pl-2">{rows}</CollapsibleContent>
    </Collapsible>
  );
};
