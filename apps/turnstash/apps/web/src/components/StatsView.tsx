import type { Overall, Stats, StatsDaily } from "@aqt/turnstash-api";
import { Empty } from "@cloudflare/kumo";
import { ChartBarIcon } from "@phosphor-icons/react";

import { Card } from "./Card";
import { ConversationsTable } from "./ConversationsTable";
import { DailyChart } from "./DailyChart";
import { Heatmap } from "./Heatmap";
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
}: {
  readonly stats: Stats;
  readonly previous: Overall | null;
  readonly calendar: StatsDaily | null;
  readonly hideProjects?: boolean;
  readonly hideMachines?: boolean;
  readonly showSubscriptions?: boolean;
}) => {
  if (stats.overall.conversations === 0) {
    return (
      <Empty
        size="lg"
        icon={<ChartBarIcon size={48} />}
        title="Nothing recorded"
        description={
          stats.range === null
            ? "No machine has pushed logs to this archive yet. Enrol one and run:"
            : "No requests in this period. Widen the period or push fresh logs:"
        }
        commandLine="turnstash sync"
      />
    );
  }

  return (
    <>
      <StatTiles
        overall={stats.overall}
        previous={previous}
        daily={stats.daily}
        range={stats.range}
        subscriptions={stats.subscriptions}
      />
      <DailyChart daily={stats.daily} />
      {showSubscriptions && stats.subscriptions.length > 0 && (
        <SubscriptionValueTable rows={stats.subscriptions} />
      )}
      <div className="tables-grid">
        {!hideProjects && stats.byProject.length > 0 && <ProjectsTable rows={stats.byProject} />}
        {stats.byModel.length > 0 && <ModelsTable rows={stats.byModel} />}
      </div>
      {stats.topConversations.length > 0 && (
        <Card
          title="Most expensive conversations"
          note={`top ${stats.topConversations.length} in this period`}
        >
          <ConversationsTable rows={stats.topConversations} showShare />
        </Card>
      )}
      <div className="tables-grid">
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
