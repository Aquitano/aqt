import { providerLabels } from "@aqt/turnstash-api";
import type {
  PricingRule,
  PricingRuleInput,
  PricingRuleView,
  UnpricedModelRow,
} from "@aqt/turnstash-api";
import { Button, Input, Tabs } from "@cloudflare/kumo";
import { TrashIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { useRef, useState } from "react";
import type { ChangeEvent } from "react";

import { api } from "../api";
import { Async, RequestFailure } from "../components/Async";
import { Card } from "../components/Card";
import { int, relativeTime } from "../format";
import { rulesQuery, unpricedModelsQuery } from "../queries";

type Kind = PricingRule["kind"];
type Reason = Extract<PricingRule, { kind: "unpriced" }>["reason"];

const kindOptions: ReadonlyArray<{ value: Kind; label: string }> = [
  { value: "alias", label: "Price as another model" },
  { value: "rate", label: "Custom rates" },
  { value: "unpriced", label: "Not billed per token" },
];
const reasonOptions: ReadonlyArray<{ value: Reason; label: string }> = [
  { value: "subscription", label: "Subscription" },
  { value: "free", label: "Free tier" },
  { value: "local", label: "Runs locally" },
];
const isKind = (value: string): value is Kind =>
  kindOptions.some((option) => option.value === value);
const isReason = (value: string): value is Reason =>
  reasonOptions.some((option) => option.value === value);

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
      size="sm"
      aria-label={label}
      inputMode="decimal"
      placeholder={`${label}${placeholder === undefined ? "" : `, ${placeholder}`}`}
      value={value}
      onChange={(event: ChangeEvent<HTMLInputElement>) => set(event.target.value)}
    />
  );

  return (
    <div className="stack">
      <div className="filters" style={{ alignItems: "center" }}>
        <Input
          size="sm"
          width={280}
          aria-label="Model as it appears in logs"
          placeholder="model as it appears in logs"
          value={model}
          onChange={(event: ChangeEvent<HTMLInputElement>) => onModelChange(event.target.value)}
        />
        <Tabs
          variant="segmented"
          size="sm"
          tabs={kindOptions.map((option) => ({ value: option.value, label: option.label }))}
          value={kind}
          onValueChange={(next) => {
            if (isKind(next)) setKind(next);
          }}
        />
        {kind === "alias" && (
          <Input
            size="sm"
            aria-label="Price as"
            placeholder="price as, e.g. claude-opus-5"
            value={target}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setTarget(event.target.value)}
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
          <Tabs
            variant="segmented"
            size="sm"
            tabs={reasonOptions.map((option) => ({ value: option.value, label: option.label }))}
            value={reason}
            onValueChange={(next) => {
              if (isReason(next)) setReason(next);
            }}
          />
        )}
        <Button
          size="sm"
          variant="primary"
          loading={save.isPending}
          disabled={model.trim() === "" || ready === null}
          onClick={() => {
            if (ready !== null) save.mutate({ model: model.trim(), rule: ready });
          }}
        >
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
  <table className="data-table">
    <thead>
      <tr>
        <th>Model</th>
        <th>Rule</th>
        <th>Updated</th>
        <th className="num">Actions</th>
      </tr>
    </thead>
    <tbody>
      {rows.map((row) => (
        <tr key={row.model}>
          <td className="primary">{row.model}</td>
          <td>{describe(row.rule)}</td>
          <td>{relativeTime(row.updatedAt)}</td>
          <td className="num">
            <Button
              size="xs"
              variant="secondary-destructive"
              icon={<TrashIcon />}
              aria-label={`Delete rule for ${row.model}`}
              loading={deleting === row.model}
              onClick={() => onDelete(row.model)}
            />
          </td>
        </tr>
      ))}
    </tbody>
  </table>
);

const UnpricedTable = ({
  rows,
  onPick,
}: {
  readonly rows: ReadonlyArray<UnpricedModelRow>;
  readonly onPick: (model: string) => void;
}) => (
  <table className="data-table">
    <thead>
      <tr>
        <th>Model</th>
        <th>Provider</th>
        <th>Reason</th>
        <th>Last seen</th>
        <th className="num">Requests</th>
        <th className="num">Actions</th>
      </tr>
    </thead>
    <tbody>
      {rows.map((row) => (
        <tr key={`${row.provider}:${row.modelRaw}`}>
          <td className="primary">{row.modelRaw}</td>
          <td>{providerLabels[row.provider]}</td>
          <td>{row.reason ?? "pending"}</td>
          <td>{relativeTime(row.lastSeenAt)}</td>
          <td className="num">{int(row.requests)}</td>
          <td className="num">
            <Button size="xs" onClick={() => onPick(row.modelRaw)}>
              Add rule
            </Button>
          </td>
        </tr>
      ))}
    </tbody>
  </table>
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
    mutationFn: (model: string) => Effect.runPromise(api.admin.deleteRule({ query: { model } })),
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
              <span className="card-note">
                No rules yet. Built-in aliases and LiteLLM rates apply.
              </span>
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
              <span className="card-note">Every request has a price.</span>
            ) : (
              <UnpricedTable rows={rows} onPick={pick} />
            )}
          </Card>
        )}
      </Async>
    </>
  );
};
