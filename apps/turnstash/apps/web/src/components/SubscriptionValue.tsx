import { providerLabels } from "@aqt/turnstash-api";
import type { PlanCost, SubscriptionValue } from "@aqt/turnstash-api";

import { moneyList, usd } from "../format";
import { Card } from "./Card";
import { ShareCell, shareOf } from "./ShareCell";

const signedUsd = (value: number) => (value < 0 ? `-${usd(-value)}` : usd(value));

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
    <Card title="Subscription value" note="API-equivalent spend against plan cost for this period">
      <table className="data-table">
        <thead>
          <tr>
            <th>Provider</th>
            <th className="num">Plan cost</th>
            <th className="num">API-equivalent</th>
            <th className="num">Value</th>
            <th className="num">Saved</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const planUsd = usdOnly(row.planCosts);
            return (
              <tr key={row.provider}>
                <ShareCell
                  label={providerLabels[row.provider]}
                  sub={row.plans.join(", ")}
                  share={shareOf(row.apiUsd, totalApi)}
                />
                <td className="num">{moneyList(row.planCosts)}</td>
                <td className="num">{usd(row.apiUsd)}</td>
                {planUsd === null ? (
                  <td className="num muted" colSpan={2}>
                    plan not billed in USD
                  </td>
                ) : (
                  <>
                    <td className="num">
                      {planUsd > 0 ? `${(row.apiUsd / planUsd).toFixed(1)}x` : ""}
                    </td>
                    <td className="num">{signedUsd(row.apiUsd - planUsd)}</td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
};
