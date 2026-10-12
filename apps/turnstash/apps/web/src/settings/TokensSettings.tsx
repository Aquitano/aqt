import { TokenScope } from "@aqt/turnstash-api";
import { Alert, AlertDescription, AlertTitle } from "@aqt/ui/components/alert";
import { Badge } from "@aqt/ui/components/badge";
import { Button } from "@aqt/ui/components/button";
import { Field, FieldLabel } from "@aqt/ui/components/field";
import { Input } from "@aqt/ui/components/input";
import { Spinner } from "@aqt/ui/components/spinner";
import { TableBody, TableHeader, TableRow } from "@aqt/ui/components/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { Trash2Icon, TriangleAlertIcon } from "lucide-react";
import { useId, useState } from "react";

import { api } from "../api";
import { Async, RequestFailure } from "../components/Async";
import { Card } from "../components/Card";
import { CopyField } from "../components/CopyField";
import { DataTable, PrimaryTd, Td, Th } from "../components/DataTable";
import { dateTime, relativeTime } from "../format";
import { queryKeys, tokensQuery } from "../queries";

export const TokensSettings = () => {
  const queryClient = useQueryClient();
  const tokens = useQuery(tokensQuery());
  const refresh = () => void queryClient.invalidateQueries({ queryKey: queryKeys.tokens });
  const nameId = useId();

  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ReadonlyArray<TokenScope>>(["read"]);

  const create = useMutation({
    mutationFn: () =>
      Effect.runPromise(api.admin.createToken({ payload: { name: name.trim(), scopes } })),
    onSuccess: () => {
      setName("");
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => Effect.runPromise(api.admin.deleteToken({ params: { id } })),
    onSuccess: refresh,
  });

  return (
    <>
      <Card title="Create a read token">
        <div className="flex flex-col gap-3 pt-1.5">
          <div className="flex flex-wrap items-end gap-2">
            <Field className="w-48 gap-2">
              <FieldLabel htmlFor={nameId}>Name</FieldLabel>
              <Input
                id={nameId}
                className="h-8 md:text-[13px]"
                placeholder="mcp-reader"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <div className="flex h-8 items-center gap-1">
              {TokenScope.literals.map((scope) => (
                <Button
                  key={scope}
                  size="xs"
                  variant={scopes.includes(scope) ? "default" : "outline"}
                  onClick={() =>
                    setScopes(
                      scopes.includes(scope)
                        ? scopes.filter((held) => held !== scope)
                        : [...scopes, scope],
                    )
                  }
                >
                  {scope}
                </Button>
              ))}
            </div>
            <Button
              size="sm"
              disabled={create.isPending || name.trim() === "" || scopes.length === 0}
              onClick={() => create.mutate()}
            >
              {create.isPending && <Spinner data-icon="inline-start" />}
              Create
            </Button>
          </div>

          {create.isError && <RequestFailure error={create.error} />}

          {create.data !== undefined && (
            <>
              <Alert variant="warning">
                <TriangleAlertIcon />
                <AlertTitle>Copy this secret now</AlertTitle>
                <AlertDescription>
                  The archive stores only its hash; it cannot be shown again.
                </AlertDescription>
              </Alert>
              <CopyField label="Token secret" text={create.data.secret} />
            </>
          )}
        </div>
      </Card>

      <Async query={tokens}>
        {(rows) => (
          <Card title="Tokens" note={`${rows.length} issued`}>
            <DataTable>
              <TableHeader>
                <TableRow>
                  <Th>Name</Th>
                  <Th>Scopes</Th>
                  <Th>Created</Th>
                  <Th>Last used</Th>
                  <Th numeric>Actions</Th>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((token) => {
                  const deleting = remove.isPending && remove.variables === token.id;
                  return (
                    <TableRow key={token.id}>
                      <PrimaryTd>{token.name}</PrimaryTd>
                      <Td>
                        <div className="flex flex-wrap items-center gap-1">
                          {token.scopes.map((scope) => (
                            <Badge key={scope} variant="secondary">
                              {scope}
                            </Badge>
                          ))}
                        </div>
                      </Td>
                      <Td>{dateTime(token.createdAt)}</Td>
                      <Td>{relativeTime(token.lastUsedAt)}</Td>
                      <Td numeric>
                        <Button
                          size="icon-xs"
                          variant="destructive"
                          aria-label={`Delete ${token.name}`}
                          disabled={deleting}
                          onClick={() => remove.mutate(token.id)}
                        >
                          {deleting ? <Spinner /> : <Trash2Icon />}
                        </Button>
                      </Td>
                    </TableRow>
                  );
                })}
              </TableBody>
            </DataTable>
            {remove.isError && <RequestFailure error={remove.error} />}
          </Card>
        )}
      </Async>
    </>
  );
};
