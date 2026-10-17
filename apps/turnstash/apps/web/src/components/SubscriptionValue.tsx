import { providerLabels } from "@aqt/turnstash-api";
import type { PlanCost, SubscriptionValue } from "@aqt/turnstash-api";
import { TableBody, TableHeader, TableRow } from "@aqt/ui/components/table";

import { moneyList, usd } from "../format";
import { DataTable, Td, Th } from "./DataTable";
import { Section } from "./Section";
import { ShareCell, shareOf } from "./ShareCell";

// API rates are in USD and the archive keeps no exchange rates, so only a USD plan has a value to compare.
const usdOnly = (costs: ReadonlyArray<PlanCost>): number | null => {
  const [cost, ...others] = costs;
  return cost?.currency === "USD" && others.length === 0 ? cost.amount : null;
};

export const SubscriptionValueTable = ({
  rows,
}: {
  readonly rows: ReadonlyArray<SubscriptionValue>;
}) => {
  const totalApi = rows.reduce((sum, row) => sum + row.apiUsd, 0);
  return (
    <Section
      title="Subscription value"
      note="API-equivalent spend against plan cost for this period"
    >
      <DataTable>
        <TableHeader>
          <TableRow>
            <Th>Provider</Th>
            <Th numeric>Plan cost</Th>
            <Th numeric>API-equivalent</Th>
            <Th numeric>Value</Th>
            <Th numeric>Saved</Th>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const planUsd = usdOnly(row.planCosts);
            return (
              <TableRow key={row.provider}>
                <ShareCell
                  label={providerLabels[row.provider]}
                  sub={row.plans.join(", ")}
                  share={shareOf(row.apiUsd, totalApi)}
                />
                <Td numeric>{moneyList(row.planCosts)}</Td>
                <Td numeric>{usd(row.apiUsd)}</Td>
                {planUsd === null ? (
                  <Td numeric colSpan={2} className="text-xs text-muted-foreground">
                    plan not billed in USD
                  </Td>
                ) : (
                  <>
                    <Td numeric>{planUsd > 0 ? `${(row.apiUsd / planUsd).toFixed(1)}x` : ""}</Td>
                    <Td numeric>{usd(row.apiUsd - planUsd)}</Td>
                  </>
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </DataTable>
    </Section>
  );
};
