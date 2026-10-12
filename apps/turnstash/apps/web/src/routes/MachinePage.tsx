import { providerLabels } from "@aqt/turnstash-api";
import type { MachineDetail } from "@aqt/turnstash-api";
import { Badge } from "@cloudflare/kumo";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";

import { Async } from "../components/Async";
import { Card } from "../components/Card";
import { StatsView } from "../components/StatsView";
import { FilterBar, useFilters } from "../filters";
import { dateTime, int } from "../format";
import { machineQuery } from "../queries";
import { usePreviousOverall } from "../trend";

const Streams = ({ detail }: { readonly detail: MachineDetail }) => (
  <Card
    title="Sources"
    note={
      detail.streamCount > detail.streams.length
        ? `${int(detail.streamCount)} streams synced, the ${detail.streams.length} most recent shown`
        : `${int(detail.streamCount)} streams synced from this machine`
    }
  >
    <table className="data-table">
      <thead>
        <tr>
          <th>Stream</th>
          <th>Provider</th>
          <th>Last seen</th>
          <th className="num">Records</th>
        </tr>
      </thead>
      <tbody>
        {detail.streams.map((stream) => (
          <tr key={`${stream.provider}:${stream.streamId}`}>
            <td className="primary mono" title={stream.streamId}>
              {stream.streamId}
            </td>
            <td>
              <Badge variant="neutral">{providerLabels[stream.provider]}</Badge>
            </td>
            <td>{dateTime(stream.lastSeenAt)}</td>
            <td className="num">{int(stream.records)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </Card>
);

export const MachinePage = () => {
  const { id } = useParams({ from: "/machines/$id" });
  const filters = useFilters();
  const detail = useQuery(machineQuery(id, filters.range, filters.timeZone));
  const previous = usePreviousOverall(filters.range, { machineId: id });

  return (
    <main className="main">
      <FilterBar
        title={detail.data?.machine.name ?? "Machine"}
        note={
          detail.data === undefined
            ? undefined
            : `${detail.data.machine.os} ${detail.data.machine.arch}`
        }
        showProvider={false}
        showMachine={false}
      />
      <Async query={detail}>
        {(data) => (
          <>
            <StatsView stats={data.stats} previous={previous} calendar={null} hideMachines />
            <Streams detail={data} />
          </>
        )}
      </Async>
    </main>
  );
};
