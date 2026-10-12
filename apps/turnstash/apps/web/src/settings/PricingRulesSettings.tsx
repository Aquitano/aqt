import { providerLabels } from "@aqt/turnstash-api";
import type {
  PricingRule,
  PricingRuleInput,
  PricingRuleView,
  UnpricedModelRow,
} from "@aqt/turnstash-api";
import { Button } from "@aqt/ui/components/button";
import { Input } from "@aqt/ui/components/input";
import { Spinner } from "@aqt/ui/components/spinner";
import { TableBody, TableHeader, TableRow } from "@aqt/ui/components/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { Trash2Icon } from "lucide-react";
import { useRef, useState } from "react";

import { api } from "../api";
import { Async, RequestFailure } from "../components/Async";
import { Card } from "../components/Card";
import { DataTable, PrimaryTd, Td, Th } from "../components/DataTable";
import { Segmented } from "../components/Segmented";
import { int, relativeTime } from "../format";
import { rulesQuery, unpricedModelsQuery } from "../queries";

type Kind = PricingRule["kind"];
type Reason = Extract<PricingRule, { kind: "unpriced" }>["reason"];

const kindOptions: ReadonlyArray<{ readonly value: Kind; readonly label: string }> = [
  { value: "alias", label: "Price as another model" },
  { value: "rate", label: "Custom rates" },
  { value: "unpriced", label: "Not billed per token" },
];
const reasonOptions: ReadonlyArray<{ readonly value: Reason; readonly label: string }> = [
  { value: "subscription", label: "Subscription" },
  { value: "free", label: "Free tier" },
  { value: "local", label: "Runs locally" },
];

const optionalRate = (value: string): number | undefined =>
  value.trim() === "" ? undefined : Number(value);
const validRate = (value: number | undefined): boolean =>
  value === undefined || (Number.isFinite(value) && value >= 0);

const NewRule = ({
  model,
  onModelChange,
  onSaved,
}: {
  readonly model: string;
  readonly onModelChange: (model: string) => void;
  readonly onSaved: () => void;
}) => {
  const [kind, setKind] = useState<Kind>("alias");
  const [target, setTarget] = useState("");
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [cacheWrite, setCacheWrite] = useState("");
  const [cacheRead, setCacheRead] = useState("");
  const [reason, setReason] = useState<Reason>("subscription");

  const save = useMutation({
    mutationFn: (rule: PricingRuleInput) =>
      Effect.runPromise(api.admin.upsertRule({ payload: rule })),
    onSuccess: () => {
      onModelChange("");
      setTarget("");
      onSaved();
    },
  });

  const rule = (): PricingRule | null => {
    switch (kind) {
      case "alias":
        return target.trim() === "" ? null : { kind, target: target.trim() };
      case "rate": {
        const rates = [
          optionalRate(input),
          optionalRate(output),
          optionalRate(cacheWrite),
          optionalRate(cacheRead),
        ];
        const [inputPerMillion, outputPerMillion, cacheWritePerMillion, cacheReadPerMillion] =
          rates;
        if (
          inputPerMillion === undefined ||
          outputPerMillion === undefined ||
          !rates.every(validRate)
        )
          return null;
        return {
          kind,
          inputPerMillion,
          outputPerMillion,
          ...(cacheWritePerMillion === undefined ? {} : { cacheWritePerMillion }),
          ...(cacheReadPerMillion === undefined ? {} : { cacheReadPerMillion }),
        };
      }
      case "unpriced":
        return { kind, reason };
    }
  };
  const ready = rule();
  const field = (
    label: string,
    value: string,
    set: (next: string) => void,
    placeholder?: string,
  ) => (
    <Input
      aria-label={label}
      inputMode="decimal"
      className="h-8 w-44 md:text-[13px]"
      placeholder={`${label}${placeholder === undefined ? "" : `, ${placeholder}`}`}
      value={value}
      onChange={(event) => set(event.target.value)}
    />
  );

  return (
    <div className="flex flex-col gap-3 pt-1.5">
      <div className="flex flex-wrap items-center gap-2 *:max-w-full">
        <Input
          aria-label="Model as it appears in logs"
          placeholder="model as it appears in logs"
          className="h-8 w-70 md:text-[13px]"
          value={model}
          onChange={(event) => onModelChange(event.target.value)}
        />
        <Segmented label="Rule kind" options={kindOptions} value={kind} onChange={setKind} />
        {kind === "alias" && (
          <Input
            aria-label="Price as"
            placeholder="price as, e.g. claude-opus-5"
            className="h-8 w-60 md:text-[13px]"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          />
        )}
        {kind === "rate" && (
          <>
            {field("Input $/M", input, setInput)}
            {field("Output $/M", output, setOutput)}
            {field("Cache write $/M", cacheWrite, setCacheWrite, "default 1.25x input")}
            {field("Cache read $/M", cacheRead, setCacheRead, "default 0.1x input")}
          </>
        )}
        {kind === "unpriced" && (
          <Segmented label="Reason" options={reasonOptions} value={reason} onChange={setReason} />
        )}
        <Button
          size="sm"
          disabled={save.isPending || model.trim() === "" || ready === null}
          onClick={() => {
            if (ready !== null) save.mutate({ model: model.trim(), rule: ready });
          }}
        >
          {save.isPending && <Spinner data-icon="inline-start" />}
          Save rule
        </Button>
      </div>
      {save.isError && <RequestFailure error={save.error} />}
    </div>
  );
};

const describe = (rule: PricingRule): string => {
  switch (rule.kind) {
    case "alias":
      return `priced as ${rule.target}`;
    case "rate": {
      const extras = [
        rule.cacheWritePerMillion === undefined
          ? null
          : `cache write $${rule.cacheWritePerMillion}`,
        rule.cacheReadPerMillion === undefined ? null : `cache read $${rule.cacheReadPerMillion}`,
      ].filter((part) => part !== null);
      return [
        `$${rule.inputPerMillion} in, $${rule.outputPerMillion} out per million`,
        ...extras,
      ].join(", ");
    }
    case "unpriced":
      return reasonOptions.find((option) => option.value === rule.reason)?.label ?? rule.reason;
  }
};

const RulesTable = ({
  rows,
  onDelete,
  deleting,
}: {
  readonly rows: ReadonlyArray<PricingRuleView>;
  readonly onDelete: (model: string) => void;
  readonly deleting: string | null;
}) => (
  <DataTable>
    <TableHeader>
      <TableRow>
        <Th>Model</Th>
        <Th>Rule</Th>
        <Th>Updated</Th>
        <Th numeric>Actions</Th>
      </TableRow>
    </TableHeader>
    <TableBody>
      {rows.map((row) => (
        <TableRow key={row.model}>
          <PrimaryTd>{row.model}</PrimaryTd>
          <Td>{describe(row.rule)}</Td>
          <Td>{relativeTime(row.updatedAt)}</Td>
          <Td numeric>
            <Button
              size="icon-xs"
              variant="destructive"
              aria-label={`Delete rule for ${row.model}`}
              disabled={deleting === row.model}
              onClick={() => onDelete(row.model)}
            >
              {deleting === row.model ? <Spinner /> : <Trash2Icon />}
            </Button>
          </Td>
        </TableRow>
      ))}
    </TableBody>
  </DataTable>
);

const UnpricedTable = ({
  rows,
  onPick,
}: {
  readonly rows: ReadonlyArray<UnpricedModelRow>;
  readonly onPick: (model: string) => void;
}) => (
  <DataTable>
    <TableHeader>
      <TableRow>
        <Th>Model</Th>
        <Th>Provider</Th>
        <Th>Reason</Th>
        <Th>Last seen</Th>
        <Th numeric>Requests</Th>
        <Th numeric>Actions</Th>
      </TableRow>
    </TableHeader>
    <TableBody>
      {rows.map((row) => (
        <TableRow key={`${row.provider}:${row.modelRaw}`}>
          <PrimaryTd>{row.modelRaw}</PrimaryTd>
          <Td>{providerLabels[row.provider]}</Td>
          <Td>{row.reason ?? "pending"}</Td>
          <Td>{relativeTime(row.lastSeenAt)}</Td>
          <Td numeric>{int(row.requests)}</Td>
          <Td numeric>
            <Button size="xs" variant="outline" onClick={() => onPick(row.modelRaw)}>
              Add rule
            </Button>
          </Td>
        </TableRow>
      ))}
    </TableBody>
  </DataTable>
);

export const PricingRulesSettings = () => {
  const queryClient = useQueryClient();
  const rules = useQuery(rulesQuery());
  const unpriced = useQuery(unpricedModelsQuery());
  const [model, setModel] = useState("");
  const form = useRef<HTMLDivElement>(null);
  const pick = (picked: string) => {
    setModel(picked);
    form.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    form.current?.querySelector("input")?.focus();
  };
  const refresh = () => void queryClient.invalidateQueries();
  const remove = useMutation({
    mutationFn: (target: string) =>
      Effect.runPromise(api.admin.deleteRule({ query: { model: target } })),
    onSuccess: refresh,
  });

  return (
    <>
      <div ref={form}>
        <Card
          title="Add a pricing rule"
          note="Each rule creates a new catalog version and reprices the archive."
        >
          <NewRule model={model} onModelChange={setModel} onSaved={refresh} />
        </Card>
      </div>
      <Async query={rules}>
        {(rows) => (
          <Card title="Pricing rules" note={`${rows.length} rules`}>
            {rows.length === 0 ? (
              <p className="pt-1.5 text-xs text-muted-foreground">
                No rules yet. Built-in aliases and LiteLLM rates apply.
              </p>
            ) : (
              <RulesTable
                rows={rows}
                onDelete={remove.mutate}
                deleting={remove.isPending ? remove.variables : null}
              />
            )}
            {remove.isError && <RequestFailure error={remove.error} />}
          </Card>
        )}
      </Async>
      <Async query={unpriced}>
        {(rows) => (
          <Card title="Unpriced models" note={`${rows.length} models without a rate`}>
            {rows.length === 0 ? (
              <p className="pt-1.5 text-xs text-muted-foreground">Every request has a price.</p>
            ) : (
              <UnpricedTable rows={rows} onPick={pick} />
            )}
          </Card>
        )}
      </Async>
    </>
  );
};
