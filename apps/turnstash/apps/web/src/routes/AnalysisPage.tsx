import type { AllocationRow, Analysis } from "@aqt/turnstash-api";
import { TableBody, TableHeader, TableRow } from "@aqt/ui/components/table";
import { useQuery } from "@tanstack/react-query";

import { Async } from "../components/Async";
import { CacheBreaks } from "../components/CacheBreaks";
import { DataTable, Td, Th } from "../components/DataTable";
import { ModelBehaviour } from "../components/ModelBehaviour";
import { Page } from "../components/Page";
import { Section, SectionEmpty, SectionGroup } from "../components/Section";
import { ShareCell, shareOf } from "../components/ShareCell";
import { useCollapse } from "../components/Tables";
import { FilterBar, useFilters } from "../filters";
import { int, usd } from "../format";
import { analysisQuery, cacheBreaksQuery } from "../queries";

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
        <SectionEmpty>Nothing observed in this period.</SectionEmpty>
      ) : (
        <DataTable>
          <TableHeader>
            <TableRow>
              <Th>Name</Th>
              <Th numeric>Turns</Th>
              <Th numeric>Estimated cost</Th>
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
    <Section
      title="By task"
      note={`${usd(analysis.attributedCostUsd)} of ${usd(total)} attributed to turns`}
      description="Each turn is classified by rules from its prompt, tools and edits. Cost not tied to a turn is listed separately."
    >
      <DataTable>
        <TableHeader>
          <TableRow>
            <Th>Task</Th>
            <Th numeric>Turns</Th>
            <Th numeric secondary>
              Edit turns
            </Th>
            <Th numeric secondary>
              Retries
            </Th>
            <Th numeric>Cost</Th>
          </TableRow>
        </TableHeader>
        <TableBody>
          {analysis.byCategory.map((row) => (
            <TableRow key={row.category}>
              <ShareCell label={row.category} share={shareOf(row.costUsd, total)} />
              <Td numeric>{int(row.turns)}</Td>
              <Td numeric secondary>
                {int(row.editTurns)}
              </Td>
              <Td numeric secondary>
                {int(row.retries)}
              </Td>
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
              <Td numeric secondary />
              <Td numeric secondary />
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
  const breaks = useQuery(cacheBreaksQuery(filters.stats));

  return (
    <Page>
      <FilterBar
        title="Analysis"
        note="Where turns spent money. Tasks are classified by rules; tool, command, skill and MCP figures are estimates."
      />
      <Async query={analysis}>
        {(data) => (
          <>
            <CategoryTable analysis={data} />
            <ModelBehaviour rows={data.byModel} />
            <Async query={breaks}>{(report) => <CacheBreaks report={report} />}</Async>
            <SectionGroup
              title="Estimated allocation"
              description="A turn's cost is split evenly across the tools, commands, skills or MCP servers it used, so these rows are estimates, not measured spend."
            >
              <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
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
            </SectionGroup>
          </>
        )}
      </Async>
    </Page>
  );
};
