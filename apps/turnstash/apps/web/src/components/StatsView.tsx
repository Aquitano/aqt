import type { Overall, PlanCost, ProviderId, Stats, StatsDaily } from "@aqt/turnstash-api";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@aqt/ui/components/empty";
import { cn } from "cn";
import { ChartColumnIcon } from "lucide-react";

import { ConversationsTable } from "./ConversationsTable";
import { DailyChart } from "./DailyChart";
import { Heatmap } from "./Heatmap";
import { Section, surface } from "./Section";
import { SpendFlow } from "./SpendFlow";
import { StatTiles } from "./StatTiles";
import { SubscriptionValueTable } from "./SubscriptionValue";
import { MachinesTable, ModelsTable, ProjectsTable, ProvidersTable } from "./Tables";

export const StatsView = ({
  stats,
  previous,
  calendar,
  hideProjects = false,
  hideMachines = false,
  showSubscriptions = false,
  expired,
}: {
  readonly stats: Stats;
  readonly previous: Overall | null;
  readonly calendar: StatsDaily | null;
  readonly hideProjects?: boolean;
  readonly hideMachines?: boolean;
  readonly showSubscriptions?: boolean;
  readonly expired?: ReadonlyMap<ProviderId, ReadonlyArray<PlanCost>>;
}) => {
  if (stats.overall.conversations === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ChartColumnIcon />
          </EmptyMedia>
          <EmptyTitle>Nothing recorded</EmptyTitle>
          <EmptyDescription>
            {stats.range === null
              ? "No machine has pushed logs to this archive yet. Enrol one and run:"
              : "No requests in this period. Widen the period or push fresh logs:"}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <code className="rounded-md bg-muted px-2 py-1 font-mono text-xs">turnstash sync</code>
        </EmptyContent>
      </Empty>
    );
  }

  return (
    <>
      <section className={cn(surface, "flex flex-col gap-5 p-4 sm:p-6")}>
        <StatTiles
          overall={stats.overall}
          previous={previous}
          daily={stats.daily}
          range={stats.range}
          subscriptions={stats.subscriptions}
        />
        <DailyChart daily={stats.daily} />
      </section>
      {showSubscriptions && stats.subscriptions.length > 0 && (
        <SubscriptionValueTable rows={stats.subscriptions} expired={expired} />
      )}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {!hideProjects && stats.byProject.length > 0 && <ProjectsTable rows={stats.byProject} />}
        {stats.byModel.length > 0 && <ModelsTable rows={stats.byModel} />}
      </div>
      {stats.topConversations.length > 0 && (
        <Section
          title="Most expensive conversations"
          note={`top ${stats.topConversations.length} in this period`}
        >
          <ConversationsTable rows={stats.topConversations} showShare />
        </Section>
      )}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {stats.byProvider.length > 0 && <ProvidersTable rows={stats.byProvider} />}
        {!hideMachines && stats.byMachine.length > 0 && (
          <MachinesTable
            rows={stats.byMachine}
            title="By machine"
            note={`${stats.byMachine.length} enrolled`}
            agent="column"
          />
        )}
      </div>
      {calendar !== null && <Heatmap daily={calendar.daily} dataStart={calendar.dataStart} />}
      <SpendFlow links={stats.flow} />
    </>
  );
};
