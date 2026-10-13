import { providerLabels } from "@aqt/turnstash-api";
import type { MachineDetail } from "@aqt/turnstash-api";
import { Badge } from "@aqt/ui/components/badge";
import { TableBody, TableHeader, TableRow } from "@aqt/ui/components/table";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";

import { Async } from "../components/Async";
import { DataTable, PrimaryTd, Td, Th } from "../components/DataTable";
import { Page } from "../components/Page";
import { Section } from "../components/Section";
import { StatsView } from "../components/StatsView";
import { FilterBar, useFilters } from "../filters";
import { dateTime, int } from "../format";
import { machineQuery } from "../queries";
import { usePreviousOverall } from "../trend";

const Streams = ({ detail }: { readonly detail: MachineDetail }) => (
  <Section
    title="Sources"
    note={
      detail.streamCount > detail.streams.length
        ? `${int(detail.streamCount)} streams synced, the ${detail.streams.length} most recent shown`
        : `${int(detail.streamCount)} streams synced from this machine`
    }
  >
    <DataTable>
      <TableHeader>
        <TableRow>
          <Th>Stream</Th>
          <Th>Provider</Th>
          <Th>Last seen</Th>
          <Th numeric>Records</Th>
        </TableRow>
      </TableHeader>
      <TableBody>
        {detail.streams.map((stream) => (
          <TableRow key={`${stream.provider}:${stream.streamId}`}>
            <PrimaryTd className="font-mono text-xs" title={stream.streamId}>
              {stream.streamId}
            </PrimaryTd>
            <Td>
              <Badge variant="secondary">{providerLabels[stream.provider]}</Badge>
            </Td>
            <Td>{dateTime(stream.lastSeenAt)}</Td>
            <Td numeric>{int(stream.records)}</Td>
          </TableRow>
        ))}
      </TableBody>
    </DataTable>
  </Section>
);

export const MachinePage = () => {
  const { id } = useParams({ from: "/machines/$id" });
  const filters = useFilters();
  const detail = useQuery(machineQuery(id, filters.range, filters.timeZone));
  const previous = usePreviousOverall(filters.range, { machineId: id });

  return (
    <Page>
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
    </Page>
  );
};
