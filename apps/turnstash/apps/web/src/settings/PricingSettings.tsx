import { Badge } from "@aqt/ui/components/badge";
import { Button } from "@aqt/ui/components/button";
import { Spinner } from "@aqt/ui/components/spinner";
import { TableBody, TableHeader, TableRow } from "@aqt/ui/components/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { RefreshCwIcon } from "lucide-react";

import { api } from "../api";
import { Async, RequestFailure } from "../components/Async";
import { Card } from "../components/Card";
import { DataTable, PrimaryTd, Td, Th } from "../components/DataTable";
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
          action={
            <Button
              size="sm"
              variant="outline"
              disabled={refresh.isPending}
              onClick={() => refresh.mutate()}
            >
              {refresh.isPending ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <RefreshCwIcon data-icon="inline-start" />
              )}
              Refresh from LiteLLM
            </Button>
          }
        >
          {refresh.isError && <RequestFailure error={refresh.error} />}
          {revalue.isError && <RequestFailure error={revalue.error} />}
          <DataTable>
            <TableHeader>
              <TableRow>
                <Th>Version</Th>
                <Th>Source</Th>
                <Th>Fetched</Th>
                <Th numeric>Entries</Th>
                <Th numeric>Rules</Th>
                <Th numeric>Actions</Th>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((catalog) => {
                const activating = revalue.isPending && revalue.variables === catalog.version;
                return (
                  <TableRow key={catalog.version}>
                    <PrimaryTd>
                      {catalog.version} {catalog.active && <Badge variant="success">active</Badge>}
                      {catalog.pending && <Badge variant="warning">applying</Badge>}
                    </PrimaryTd>
                    <Td>{catalog.source}</Td>
                    <Td>{dateTime(catalog.fetchedAt)}</Td>
                    <Td numeric>{int(catalog.entries)}</Td>
                    <Td numeric>{int(catalog.rules)}</Td>
                    <Td numeric>
                      {!catalog.active && !catalog.pending && (
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={activating}
                          onClick={() => revalue.mutate(catalog.version)}
                        >
                          {activating && <Spinner data-icon="inline-start" />}
                          Activate
                        </Button>
                      )}
                    </Td>
                  </TableRow>
                );
              })}
            </TableBody>
          </DataTable>
          {revalue.data?.queued === true && (
            <p className="pt-2 text-xs text-muted-foreground">
              The catalog is being applied. Totals switch once every request is priced.
            </p>
          )}
        </Card>
      )}
    </Async>
  );
};
