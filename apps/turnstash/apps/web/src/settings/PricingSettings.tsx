import { Badge, Button } from "@cloudflare/kumo";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";

import { api } from "../api";
import { Async, RequestFailure } from "../components/Async";
import { Card } from "../components/Card";
import { dateTime, int } from "../format";
import { catalogsQuery } from "../queries";
import { PricingRulesSettings } from "./PricingRulesSettings";

export const PricingSettings = () => (
  <>
    <PricingRulesSettings />
    <PricingCatalogs />
  </>
);

const PricingCatalogs = () => {
  const queryClient = useQueryClient();
  const catalogs = useQuery(catalogsQuery());

  const refresh = useMutation({
    mutationFn: () => Effect.runPromise(api.admin.refreshPricing()),
    onSuccess: () => void queryClient.invalidateQueries(),
  });
  const revalue = useMutation({
    mutationFn: (catalogVersion: string) =>
      Effect.runPromise(api.admin.revalue({ payload: { catalogVersion } })),
    onSuccess: () => void queryClient.invalidateQueries(),
  });

  return (
    <Async query={catalogs}>
      {(rows) => (
        <Card
          title="Pricing catalogs"
          note={
            <Button
              size="sm"
              icon={<ArrowsClockwiseIcon />}
              loading={refresh.isPending}
              onClick={() => refresh.mutate()}
            >
              Refresh from LiteLLM
            </Button>
          }
        >
          {refresh.isError && <RequestFailure error={refresh.error} />}
          {revalue.isError && <RequestFailure error={revalue.error} />}
          <table className="data-table">
            <thead>
              <tr>
                <th>Version</th>
                <th>Source</th>
                <th>Fetched</th>
                <th className="num">Entries</th>
                <th className="num">Rules</th>
                <th className="num">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((catalog) => (
                <tr key={catalog.version}>
                  <td className="primary">
                    {catalog.version} {catalog.active && <Badge variant="success">active</Badge>}
                    {catalog.pending && <Badge variant="warning">applying</Badge>}
                  </td>
                  <td>{catalog.source}</td>
                  <td>{dateTime(catalog.fetchedAt)}</td>
                  <td className="num">{int(catalog.entries)}</td>
                  <td className="num">{int(catalog.rules)}</td>
                  <td className="num">
                    {!catalog.active && !catalog.pending && (
                      <Button
                        size="xs"
                        loading={revalue.isPending && revalue.variables === catalog.version}
                        onClick={() => revalue.mutate(catalog.version)}
                      >
                        Activate
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {revalue.data?.queued === true && (
            <span className="card-note">
              The catalog is being applied. Totals switch once every request is priced.
            </span>
          )}
        </Card>
      )}
    </Async>
  );
};
