import type { AllocationRow, Analysis } from "@aqt/turnstash-api";
import { useQuery } from "@tanstack/react-query";

import { Async } from "../components/Async";
import { Card } from "../components/Card";
import { ShareCell, shareOf } from "../components/ShareCell";
import { useCollapse } from "../components/Tables";
import { FilterBar, useFilters } from "../filters";
import { int, pct, usd } from "../format";
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
    <Card title={title} note={note}>
      {rows.length === 0 ? (
        <span className="card-note">Nothing observed in this period.</span>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th className="num">Turns</th>
              <th className="num">Est. cost</th>
            </tr>
          </thead>
          <tbody>
            {collapse.shown.map((row) => (
              <tr key={row.name}>
                <ShareCell label={row.name} share={shareOf(row.estimatedCostUsd, total)} />
                <td className="num">{int(row.turns)}</td>
                <td className="num">{usd(row.estimatedCostUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {collapse.toggle}
    </Card>
  );
};

const CategoryTable = ({ analysis }: { readonly analysis: Analysis }) => {
  const total = analysis.attributedCostUsd + analysis.unattributedCostUsd;
  return (
    <Card title="By task" note={`${usd(analysis.attributedCostUsd)} attributed to turns`}>
      <table className="data-table">
        <thead>
          <tr>
            <th>Task</th>
            <th className="num">Turns</th>
            <th className="num">Edit turns</th>
            <th className="num">Retries</th>
            <th className="num">Cost</th>
          </tr>
        </thead>
        <tbody>
          {analysis.byCategory.map((row) => (
            <tr key={row.category}>
              <ShareCell label={row.category} share={shareOf(row.costUsd, total)} />
              <td className="num">{int(row.turns)}</td>
              <td className="num">{int(row.editTurns)}</td>
              <td className="num">{int(row.retries)}</td>
              <td className="num">{usd(row.costUsd)}</td>
            </tr>
          ))}
          {analysis.unattributedCostUsd > 0 && (
            <tr>
              <ShareCell
                label="not attributed to a turn"
                share={shareOf(analysis.unattributedCostUsd, total)}
              />
              <td className="num"></td>
              <td className="num"></td>
              <td className="num"></td>
              <td className="num">{usd(analysis.unattributedCostUsd)}</td>
            </tr>
          )}
        </tbody>
      </table>
    </Card>
  );
};

const ModelTable = ({ analysis }: { readonly analysis: Analysis }) => {
  const total = analysis.byModel.reduce((sum, row) => sum + row.costUsd, 0);
  return (
    <Card title="By model" note="the model that answered the turn first">
      <table className="data-table">
        <thead>
          <tr>
            <th>Model</th>
            <th className="num">Turns</th>
            <th className="num">Edit turns</th>
            <th className="num">Retries per edit turn</th>
            <th className="num">Cost per turn</th>
            <th className="num">Cache hit</th>
            <th className="num">Cost</th>
          </tr>
        </thead>
        <tbody>
          {analysis.byModel.map((row) => (
            <tr key={row.modelId}>
              <ShareCell label={row.modelId} share={shareOf(row.costUsd, total)} />
              <td className="num">{int(row.turns)}</td>
              <td className="num">{int(row.editTurns)}</td>
              <td className="num">
                {row.editTurns === 0 ? "" : (row.retries / row.editTurns).toFixed(2)}
              </td>
              <td className="num">{row.turns === 0 ? "" : usd(row.costUsd / row.turns)}</td>
              <td className="num">{row.cacheHitRate === null ? "" : pct(row.cacheHitRate)}</td>
              <td className="num">{usd(row.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
};

export const AnalysisPage = () => {
  const filters = useFilters();
  const analysis = useQuery(analysisQuery(filters.stats));

  return (
    <main className="main">
      <FilterBar title="Analysis" note="turns are classified by rules, allocations are estimates" />
      <Async query={analysis}>
        {(data) => (
          <>
            <CategoryTable analysis={data} />
            <ModelTable analysis={data} />
            <div className="tables-grid">
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
    </main>
  );
};
