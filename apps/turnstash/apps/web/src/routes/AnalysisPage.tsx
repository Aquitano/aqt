import type { AllocationRow, Analysis } from "@aqt/turnstash-api";
import { TableBody, TableHeader, TableRow } from "@aqt/ui/components/table";
import { useQuery } from "@tanstack/react-query";

import { Async } from "../components/Async";
import { DataTable, Td, Th } from "../components/DataTable";
import { ModelBehaviour } from "../components/ModelBehaviour";
import { Page } from "../components/Page";
import { Section } from "../components/Section";
import { ShareCell, shareOf } from "../components/ShareCell";
import { useCollapse } from "../components/Tables";
import { FilterBar, useFilters } from "../filters";
import { int, usd } from "../format";
import { analysisQuery } from "../queries";

const AllocationTable = ({
  title,
  rows,
  note,
}: {
  readonly title: string;
  readonly rows: ReadonlyArray<AllocationRow>;
  readonly note: string;
}) => {
  const total = rows.reduce((sum, row) => sum + row.estimatedCostUsd, 0);
  const collapse = useCollapse(rows);
  return (
    <Section title={title} note={note}>
      {rows.length === 0 ? (
        <p className="py-2 text-xs text-muted-foreground">Nothing observed in this period.</p>
      ) : (
        <DataTable>
          <TableHeader>
            <TableRow>
              <Th>Name</Th>
              <Th numeric>Turns</Th>
              <Th numeric>Est. cost</Th>
            </TableRow>
          </TableHeader>
          <TableBody>
            {collapse.shown.map((row) => (
              <TableRow key={row.name}>
                <ShareCell label={row.name} share={shareOf(row.estimatedCostUsd, total)} />
                <Td numeric>{int(row.turns)}</Td>
                <Td numeric>{usd(row.estimatedCostUsd)}</Td>
              </TableRow>
            ))}
          </TableBody>
        </DataTable>
      )}
      {collapse.toggle}
    </Section>
  );
};

const CategoryTable = ({ analysis }: { readonly analysis: Analysis }) => {
  const total = analysis.attributedCostUsd + analysis.unattributedCostUsd;
  return (
    <Section title="By task" note={`${usd(analysis.attributedCostUsd)} attributed to turns`}>
      <DataTable>
        <TableHeader>
          <TableRow>
            <Th>Task</Th>
            <Th numeric>Turns</Th>
            <Th numeric>Edit turns</Th>
            <Th numeric>Retries</Th>
            <Th numeric>Cost</Th>
          </TableRow>
        </TableHeader>
        <TableBody>
          {analysis.byCategory.map((row) => (
            <TableRow key={row.category}>
              <ShareCell label={row.category} share={shareOf(row.costUsd, total)} />
              <Td numeric>{int(row.turns)}</Td>
              <Td numeric>{int(row.editTurns)}</Td>
              <Td numeric>{int(row.retries)}</Td>
              <Td numeric>{usd(row.costUsd)}</Td>
            </TableRow>
          ))}
          {analysis.unattributedCostUsd > 0 && (
            <TableRow>
              <ShareCell
                label="not attributed to a turn"
                share={shareOf(analysis.unattributedCostUsd, total)}
              />
              <Td numeric />
              <Td numeric />
              <Td numeric />
              <Td numeric>{usd(analysis.unattributedCostUsd)}</Td>
            </TableRow>
          )}
        </TableBody>
      </DataTable>
    </Section>
  );
};

export const AnalysisPage = () => {
  const filters = useFilters();
  const analysis = useQuery(analysisQuery(filters.stats));

  return (
    <Page>
      <FilterBar title="Analysis" note="turns are classified by rules, allocations are estimates" />
      <Async query={analysis}>
        {(data) => (
          <>
            <CategoryTable analysis={data} />
            <ModelBehaviour rows={data.byModel} />
            <div className="grid grid-cols-1 gap-x-10 gap-y-9 lg:grid-cols-2">
              <AllocationTable
                title="By tool"
                rows={data.byTool}
                note="turn cost split evenly across its tools"
              />
              <AllocationTable
                title="By shell command"
                rows={data.byCommand}
                note="turn cost split evenly across its commands"
              />
              <AllocationTable
                title="By skill"
                rows={data.bySkill}
                note="turn cost split evenly across its skills"
              />
              <AllocationTable
                title="By MCP server"
                rows={data.byMcpServer}
                note="turn cost split evenly across its servers"
              />
            </div>
          </>
        )}
      </Async>
    </Page>
  );
};
