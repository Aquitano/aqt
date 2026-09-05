import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { apiKeysQuery } from "@/lib/queries";
import { rejectFailures } from "@/lib/server-error";
import * as apiKeyFns from "@/server/fns/api-keys";

/** Create, list and revoke bearer keys for the CLI and the JSON API. */
export function ApiKeysDialog() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<{ name: string; key: string } | null>(null);
  const keys = useQuery({ ...apiKeysQuery(), enabled: open });

  const create = useMutation({
    mutationFn: (name: string) => rejectFailures(apiKeyFns.create({ data: { name } })),
    onSuccess: (created) => {
      setFresh({ name: created.name, key: created.key });
      setName("");
      queryClient.invalidateQueries(apiKeysQuery());
    },
    onError: () => toast.error("Could not create that key"),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => rejectFailures(apiKeyFns.revoke({ data: { id } })),
    onSuccess: () => queryClient.invalidateQueries(apiKeysQuery()),
    onError: () => toast.error("Could not revoke that key"),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setFresh(null);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="API keys">
          <KeyRound />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>API keys</DialogTitle>
          <DialogDescription>
            Keys let the album CLI and other tools act as you. A key is shown once.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) create.mutate(name.trim());
          }}
        >
          <Input
            aria-label="Key name"
            placeholder="laptop"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Button type="submit" disabled={name.trim().length === 0 || create.isPending}>
            Create
          </Button>
        </form>

        {fresh ? <FreshKey name={fresh.name} value={fresh.key} /> : null}

        <ul className="divide-border divide-y text-sm">
          {keys.data?.map((key) => (
            <li key={key.id} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{key.name}</p>
                <p className="text-muted-foreground font-mono text-xs">
                  {key.prefix}… · {formatUsed(key.lastUsedAt)}
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Revoke ${key.name}`}
                onClick={() => revoke.mutate(key.id)}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
          {keys.data?.length === 0 ? (
            <li className="text-muted-foreground py-2">No keys yet.</li>
          ) : null}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

function FreshKey({ name, value }: { name: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="bg-muted rounded-md p-3 text-sm">
      <p className="mb-1">
        Key for <span className="font-medium">{name}</span>. Copy it now; it will not be shown
        again.
      </p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate font-mono text-xs" data-testid="fresh-api-key">
          {value}
        </code>
        <Button variant="outline" size="sm" onClick={copy}>
          {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="text-muted-foreground mt-2 text-xs">
        Then run{" "}
        <code>
          album login --url {typeof window === "undefined" ? "" : window.location.origin} --key …
        </code>
      </p>
    </div>
  );
}

function formatUsed(at: number | null) {
  return at ? `used ${new Date(at).toLocaleDateString()}` : "never used";
}
