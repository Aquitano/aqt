import { TokenScope } from "@aqt/turnstash-api";
import { Alert, AlertDescription, AlertTitle } from "@aqt/ui/components/alert";
import { Badge } from "@aqt/ui/components/badge";
import { Button } from "@aqt/ui/components/button";
import { Field, FieldLabel } from "@aqt/ui/components/field";
import { Input } from "@aqt/ui/components/input";
import { Spinner } from "@aqt/ui/components/spinner";
import { TableBody, TableHeader, TableRow } from "@aqt/ui/components/table";
import { ToggleGroup, ToggleGroupItem } from "@aqt/ui/components/toggle-group";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { Trash2Icon, TriangleAlertIcon } from "lucide-react";
import { useId, useState } from "react";

import { api } from "../api";
import { Async, RequestFailure } from "../components/Async";
import { CopyField } from "../components/CopyField";
import { DataTable, PrimaryTd, Td, Th } from "../components/DataTable";
import { Section } from "../components/Section";
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
      <Section title="Create a read token">
        <div className="flex flex-col gap-3 pt-1.5">
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate();
            }}
          >
            <Field className="w-48">
              <FieldLabel htmlFor={nameId}>Name</FieldLabel>
              <Input
                id={nameId}
                className="h-8"
                placeholder="mcp-reader"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <ToggleGroup
              multiple
              aria-label="Scopes"
              variant="outline"
              size="sm"
              spacing={0}
              value={scopes}
              onValueChange={(next) =>
                setScopes(TokenScope.literals.filter((scope) => next.includes(scope)))
              }
            >
              {TokenScope.literals.map((scope) => (
                <ToggleGroupItem key={scope} value={scope}>
                  {scope}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <Button
              size="sm"
              type="submit"
              disabled={create.isPending || name.trim() === "" || scopes.length === 0}
            >
              {create.isPending && <Spinner data-icon="inline-start" />}
              Create
            </Button>
          </form>

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
      </Section>

      <Async query={tokens}>
        {(rows) => (
          <Section title="Tokens" note={`${rows.length} issued`}>
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
          </Section>
        )}
      </Async>
    </>
  );
};
