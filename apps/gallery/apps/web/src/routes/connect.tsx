import { env } from "@aqt/gallery-env/web";
import { Badge } from "@aqt/gallery-ui/components/badge";
import { Button } from "@aqt/gallery-ui/components/button";
import { Input } from "@aqt/gallery-ui/components/input";
import { Label } from "@aqt/gallery-ui/components/label";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Check, Copy, KeyRound, Plus, Trash2, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { CosmosShell } from "@/components/gallery/cosmos-shell";
import { getUser } from "@/functions/get-user";
import { useTRPC } from "@/utils/trpc";

export const Route = createFileRoute("/connect")({
  component: RouteComponent,
  beforeLoad: async () => {
    const session = await getUser();
    return { session };
  },
  loader: async ({ context }) => {
    if (!context.session) {
      throw redirect({ to: "/login" });
    }
  },
});

function RouteComponent() {
  const [search, setSearch] = useState("");
  return (
    <CosmosShell active="connect" search={search} onSearch={setSearch}>
      <ConnectBody />
    </CosmosShell>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-xs font-medium text-muted-foreground">{children}</p>;
}

const ENDPOINT = `${env.VITE_SERVER_URL}/mcp`;

async function copy(text: string, label = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(label);
  } catch {
    toast.error("Couldn't copy to clipboard");
  }
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label="Copy"
      onClick={async () => {
        await copy(text, label);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? <Check className="text-foreground" /> : <Copy />}
    </Button>
  );
}

function CodeBlock({ text }: { text: string }) {
  return (
    <div className="flex items-start justify-between gap-2 rounded-xl bg-card px-4 py-3">
      <pre className="min-w-0 flex-1 overflow-x-auto font-mono text-[13px] break-all whitespace-pre-wrap text-foreground">
        {text}
      </pre>
      <CopyButton text={text} />
    </div>
  );
}

function ConnectBody() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const tokens = useQuery(trpc.apiTokens.list.queryOptions());
  const createToken = useMutation(trpc.apiTokens.create.mutationOptions());
  const revokeToken = useMutation(trpc.apiTokens.revoke.mutationOptions());

  const [name, setName] = useState("");
  const [expiresInDays, setExpiresInDays] = useState(90);
  // The plaintext token is returned exactly once on creation; we hold it in
  // memory only until the user navigates away.
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null);

  const busy = createToken.isPending || revokeToken.isPending;
  const tokenForSnippets = fresh?.token ?? "YOUR_TOKEN";

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const result = await createToken.mutateAsync({
        name: trimmed,
        expiresInDays,
      });
      await queryClient.invalidateQueries({
        queryKey: trpc.apiTokens.list.queryKey(),
      });
      setName("");
      if (result.token) {
        setFresh({ name: result.name ?? trimmed, token: result.token });
      }
    } catch {
      // The global mutation handler shows the error toast; catch here so the
      // rejection doesn't escape as an unhandled promise and the success-only
      // steps above don't run on failure.
    }
  };

  const revoke = async (id: string, label: string) => {
    if (!window.confirm(`Revoke "${label}"? Any agent using it loses access.`)) {
      return;
    }
    try {
      await revokeToken.mutateAsync({ id });
      await queryClient.invalidateQueries({
        queryKey: trpc.apiTokens.list.queryKey(),
      });
      toast.success("Token revoked");
    } catch {
      // Surfaced by the global mutation handler; swallow so it isn't unhandled.
    }
  };

  const cliCommand = `claude mcp add --transport http aqt-gallery ${ENDPOINT} \\\n  --header "Authorization: Bearer ${tokenForSnippets}"`;
  const jsonConfig = `{
  "mcpServers": {
    "aqt-gallery": {
      "type": "http",
      "url": "${ENDPOINT}",
      "headers": { "Authorization": "Bearer ${tokenForSnippets}" }
    }
  }
}`;

  return (
    <div className="mx-auto flex w-full max-w-[820px] flex-col gap-8 pt-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-[-0.03em]">Connect an agent</h1>
        <p className="mt-3 max-w-prose text-sm text-muted-foreground">
          Give an AI agent (Claude, or any MCP client) access to your gallery so it can import
          artworks, fill in their details, and build exhibitions for you, all from a chat. It
          connects over the Model Context Protocol using a personal access token.
        </p>
      </div>

      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <KeyRound className="size-4 text-muted-foreground" />
          <SectionLabel>1 · Create an access token</SectionLabel>
        </div>

        <div className="flex items-end gap-2">
          <div className="flex flex-1 flex-col gap-1.5">
            <Label htmlFor="token-name">Token name</Label>
            <Input
              id="token-name"
              placeholder="e.g. Claude on my laptop"
              value={name}
              maxLength={100}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void create();
              }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="token-expiry">Expires</Label>
            <select
              id="token-expiry"
              value={expiresInDays}
              disabled={busy}
              onChange={(e) => setExpiresInDays(Number(e.target.value))}
              className="h-9 rounded-lg border border-input bg-transparent px-3 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/20"
            >
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
              <option value={365}>1 year</option>
            </select>
          </div>
          <Button
            type="button"
            disabled={busy || name.trim().length === 0}
            onClick={() => void create()}
          >
            <Plus />
            Create token
          </Button>
        </div>

        {fresh ? (
          <div className="flex flex-col gap-3 rounded-2xl bg-secondary p-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <TriangleAlert className="size-4" />
              Copy this token now. It will not be shown again.
            </div>
            <CodeBlock text={fresh.token} />
          </div>
        ) : null}

        {tokens.data && tokens.data.length > 0 ? (
          <ul className="flex flex-col rounded-2xl bg-card p-2">
            {tokens.data.map((t) => (
              <li
                key={t.id}
                className="flex items-center gap-3 rounded-xl px-3 py-2 text-sm transition-colors hover:bg-secondary/60"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{t.name}</p>
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {t.prefix}…{" · "}
                    {t.lastUsedAt
                      ? `last used ${new Date(t.lastUsedAt).toLocaleDateString()}`
                      : "never used"}
                    {t.expiresAt
                      ? ` · ${
                          new Date(t.expiresAt).getTime() <= Date.now()
                            ? "expired"
                            : `expires ${new Date(t.expiresAt).toLocaleDateString()}`
                        }`
                      : " · no expiry"}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Revoke ${t.name}`}
                  className="hover:text-destructive"
                  disabled={busy}
                  onClick={() => void revoke(t.id, t.name)}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        ) : tokens.isSuccess ? (
          <p className="text-sm text-muted-foreground">
            No tokens yet. Create one above to connect an agent.
          </p>
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <SectionLabel>2 · Point your agent at the server</SectionLabel>
        <p className="text-sm text-muted-foreground">The endpoint your agent connects to:</p>
        <CodeBlock text={ENDPOINT} />

        <div className="mt-2 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Claude Code</span>
            <Badge variant="secondary">CLI</Badge>
          </div>
          <CodeBlock text={cliCommand} />
        </div>

        <div className="mt-2 flex flex-col gap-2">
          <span className="text-sm font-medium">Other MCP clients (config file)</span>
          <CodeBlock text={jsonConfig} />
        </div>

        <p className="mt-1 text-sm text-muted-foreground">
          {fresh
            ? "The snippets above include your new token."
            : "Replace YOUR_TOKEN with the token you created above."}{" "}
          Then ask your agent: “import these paintings and build me an exhibition”.
        </p>
      </section>
    </div>
  );
}
