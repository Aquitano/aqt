import { TokenScope } from "@aqt/turnstash-api";
import { Badge, Banner, Button, ClipboardText, Input } from "@cloudflare/kumo";
import { TrashIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { useState } from "react";
import type { ChangeEvent } from "react";

import { api } from "../api";
import { Async, RequestFailure } from "../components/Async";
import { Card } from "../components/Card";
import { dateTime, relativeTime } from "../format";
import { queryKeys, tokensQuery } from "../queries";

export const TokensSettings = () => {
  const queryClient = useQueryClient();
  const tokens = useQuery(tokensQuery());
  const refresh = () => void queryClient.invalidateQueries({ queryKey: queryKeys.tokens });

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
        <div className="filters">
          <Input
            size="sm"
            label="Name"
            placeholder="mcp-reader"
            value={name}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setName(event.target.value)}
          />
          <div className="row">
            {TokenScope.literals.map((scope) => (
              <Button
                key={scope}
                size="xs"
                variant={scopes.includes(scope) ? "primary" : "secondary"}
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
            variant="primary"
            loading={create.isPending}
            disabled={name.trim() === "" || scopes.length === 0}
            onClick={() => create.mutate()}
          >
            Create
          </Button>
        </div>

        {create.isError && <RequestFailure error={create.error} />}

        {create.data !== undefined && (
          <div className="stack" style={{ marginTop: 12 }}>
            <Banner
              variant="alert"
              title="Copy this secret now"
              description="The archive stores only its hash; it cannot be shown again."
            />
            <ClipboardText text={create.data.secret} />
          </div>
        )}
      </Card>

      <Async query={tokens}>
        {(rows) => (
          <Card title="Tokens" note={`${rows.length} issued`}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Scopes</th>
                  <th>Created</th>
                  <th>Last used</th>
                  <th className="num">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((token) => (
                  <tr key={token.id}>
                    <td className="primary">{token.name}</td>
                    <td>
                      <div className="row">
                        {token.scopes.map((scope) => (
                          <Badge key={scope} variant="neutral">
                            {scope}
                          </Badge>
                        ))}
                      </div>
                    </td>
                    <td>{dateTime(token.createdAt)}</td>
                    <td>{relativeTime(token.lastUsedAt)}</td>
                    <td className="num">
                      <Button
                        size="xs"
                        variant="secondary-destructive"
                        icon={<TrashIcon />}
                        aria-label={`Delete ${token.name}`}
                        loading={remove.isPending && remove.variables === token.id}
                        onClick={() => remove.mutate(token.id)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {remove.isError && <RequestFailure error={remove.error} />}
          </Card>
        )}
      </Async>
    </>
  );
};
