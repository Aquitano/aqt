import { providerIds, providerLabels } from "@aqt/turnstash-api";
import type {
  ProviderId,
  SubscriptionPlan,
  SubscriptionPlanChange,
  SubscriptionPlanInput,
  SubscriptionPlanPatch,
} from "@aqt/turnstash-api";
import { Badge, Button, Dialog, Input, Select } from "@cloudflare/kumo";
import { PencilSimpleIcon, TrashIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { useState } from "react";
import type { ChangeEvent, ReactElement, ReactNode } from "react";

import { api } from "../api";
import { Async, RequestFailure } from "../components/Async";
import { Card } from "../components/Card";
import { money, usd } from "../format";
import { addDays, ymd } from "../period";
import { currencies, planPresets } from "../plans";
import type { PlanPreset } from "../plans";
import { isProvider, providerOptions } from "../providers";
import { plansQuery, queryKeys } from "../queries";

const customPlan = "custom";
const planDependentQueries = [
  queryKeys.plans,
  queryKeys.stats,
  queryKeys.project,
  queryKeys.machine,
];

interface PlanDraft {
  readonly name: string;
  readonly monthlyPrice: string;
  readonly currency: string;
}

const draftOf = (plan: SubscriptionPlan): PlanDraft => ({
  name: plan.name,
  monthlyPrice: String(plan.monthlyPrice),
  currency: plan.currency,
});

const parseDraft = (draft: PlanDraft) => {
  const name = draft.name.trim();
  const monthlyPrice = Number(draft.monthlyPrice);
  return name !== "" && Number.isFinite(monthlyPrice) && monthlyPrice >= 0
    ? { name, monthlyPrice, currency: draft.currency }
    : null;
};

const PresetSelect = ({
  presets,
  provider,
  draft,
  onChange,
}: {
  readonly presets: ReadonlyArray<PlanPreset>;
  readonly provider: ProviderId;
  readonly draft: PlanDraft;
  readonly onChange: (draft: PlanDraft, preset: PlanPreset | null) => void;
}) => {
  const matching = presets.find(
    (preset) =>
      preset.provider === provider &&
      preset.name === draft.name.trim() &&
      preset.monthlyPrice === Number(draft.monthlyPrice),
  );
  return (
    <Select<string>
      label="Start from"
      size="sm"
      className="preset-select"
      value={matching?.id ?? customPlan}
      items={[
        { value: customPlan, label: "Custom plan" },
        ...presets.map((preset) => ({
          value: preset.id,
          label: `${preset.label} · ${usd(preset.monthlyPrice)}`,
        })),
      ]}
      onValueChange={(next) => {
        const chosen = presets.find((preset) => preset.id === next) ?? null;
        onChange(
          chosen === null
            ? { ...draft, name: "" }
            : { ...draft, name: chosen.name, monthlyPrice: String(chosen.monthlyPrice) },
          chosen,
        );
      }}
    />
  );
};

const PlanFields = ({
  draft,
  onChange,
}: {
  readonly draft: PlanDraft;
  readonly onChange: (draft: PlanDraft) => void;
}) => (
  <>
    <Input
      size="sm"
      label="Plan"
      placeholder="Max 20x"
      value={draft.name}
      onChange={(event: ChangeEvent<HTMLInputElement>) =>
        onChange({ ...draft, name: event.target.value })
      }
    />
    <Input
      size="sm"
      label="Monthly price"
      inputMode="decimal"
      className="price-field"
      value={draft.monthlyPrice}
      onChange={(event: ChangeEvent<HTMLInputElement>) =>
        onChange({ ...draft, monthlyPrice: event.target.value })
      }
    />
    <Select<string>
      label="Currency"
      size="sm"
      className="currency-select"
      value={draft.currency}
      items={[...new Set([...currencies, draft.currency])].map((currency) => ({
        value: currency,
        label: currency,
      }))}
      onValueChange={(next) => {
        if (next !== null) onChange({ ...draft, currency: next });
      }}
    />
  </>
);

const NewPeriod = ({
  currency,
  onSaved,
}: {
  readonly currency: string;
  readonly onSaved: () => void;
}) => {
  const [provider, setProvider] = useState<ProviderId>("claude");
  const [draft, setDraft] = useState<PlanDraft>({ name: "", monthlyPrice: "20", currency });
  const [startedOn, setStartedOn] = useState(ymd(new Date()));
  const [endedOn, setEndedOn] = useState("");

  const create = useMutation({
    mutationFn: (input: SubscriptionPlanInput) =>
      Effect.runPromise(api.admin.createPlan({ payload: input })),
    onSuccess: () => {
      setDraft({ ...draft, name: "" });
      setEndedOn("");
      onSaved();
    },
  });
  const plan = parseDraft(draft);

  return (
    <div className="stack">
      <div className="filters">
        <PresetSelect
          presets={planPresets}
          provider={provider}
          draft={draft}
          onChange={(next, preset) => {
            setDraft(next);
            if (preset !== null) setProvider(preset.provider);
          }}
        />
        <Select<string>
          label="Provider"
          size="sm"
          className="fixed-select"
          value={provider}
          items={providerOptions}
          onValueChange={(next) => {
            if (next !== null && isProvider(next)) setProvider(next);
          }}
        />
        <PlanFields draft={draft} onChange={setDraft} />
        <Input
          size="sm"
          label="Started on"
          type="date"
          value={startedOn}
          onChange={(event: ChangeEvent<HTMLInputElement>) => setStartedOn(event.target.value)}
        />
        <Input
          size="sm"
          label="Ended on"
          type="date"
          value={endedOn}
          onChange={(event: ChangeEvent<HTMLInputElement>) => setEndedOn(event.target.value)}
        />
        <Button
          size="sm"
          variant="primary"
          loading={create.isPending}
          disabled={plan === null || startedOn === ""}
          onClick={() => {
            if (plan !== null)
              create.mutate({
                provider,
                ...plan,
                startedOn,
                endedOn: endedOn === "" ? null : endedOn,
              });
          }}
        >
          Add period
        </Button>
      </div>
      {create.isError && <RequestFailure error={create.error} />}
    </div>
  );
};

// The form mounts when the dialog opens, so every opening starts from the period as saved.
const PlanDialog = ({
  title,
  trigger,
  label,
  onSaved,
  children,
}: {
  readonly title: string;
  readonly trigger: ReactElement;
  readonly label?: string;
  readonly onSaved: () => void;
  readonly children: (done: () => void) => ReactNode;
}) => {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger render={trigger}>{label}</Dialog.Trigger>
      <Dialog size="lg" className="p-6">
        <div className="card-head">
          <Dialog.Title className="card-title">{title}</Dialog.Title>
        </div>
        {children(() => {
          setOpen(false);
          onSaved();
        })}
      </Dialog>
    </Dialog.Root>
  );
};

const DialogActions = ({
  label,
  pending,
  error,
  onSubmit,
}: {
  readonly label: string;
  readonly pending: boolean;
  readonly error: Error | null;
  readonly onSubmit: (() => void) | null;
}) => (
  <>
    {error !== null && <RequestFailure error={error} />}
    <div className="row">
      <Button
        variant="primary"
        loading={pending}
        disabled={onSubmit === null}
        onClick={onSubmit ?? undefined}
      >
        {label}
      </Button>
      <Dialog.Close render={<Button />}>Cancel</Dialog.Close>
    </div>
  </>
);

const ChangePlanForm = ({
  plan,
  onSaved,
}: {
  readonly plan: SubscriptionPlan;
  readonly onSaved: () => void;
}) => {
  const firstDay = addDays(plan.startedOn, 1);
  const today = ymd(new Date());
  const [draft, setDraft] = useState(draftOf(plan));
  const [effectiveOn, setEffectiveOn] = useState(today > plan.startedOn ? today : firstDay);

  const change = useMutation({
    mutationFn: (input: SubscriptionPlanChange) =>
      Effect.runPromise(api.admin.changePlan({ params: { id: plan.id }, payload: input })),
    onSuccess: onSaved,
  });
  const next = parseDraft(draft);

  return (
    <div className="stack">
      <p className="muted">
        On {plan.name} at {money(plan.monthlyPrice, plan.currency)} a month since {plan.startedOn}.
      </p>
      <PresetSelect
        presets={planPresets.filter((preset) => preset.provider === plan.provider)}
        provider={plan.provider}
        draft={draft}
        onChange={setDraft}
      />
      <div className="filters">
        <PlanFields draft={draft} onChange={setDraft} />
      </div>
      <Input
        size="sm"
        label="Effective on"
        type="date"
        min={firstDay}
        value={effectiveOn}
        onChange={(event: ChangeEvent<HTMLInputElement>) => setEffectiveOn(event.target.value)}
      />
      {next !== null && effectiveOn >= firstDay && (
        <p className="muted">
          {plan.name} ends on {addDays(effectiveOn, -1)} and {next.name} starts on {effectiveOn}.
        </p>
      )}
      <DialogActions
        label="Change plan"
        pending={change.isPending}
        error={change.error}
        onSubmit={
          next === null || effectiveOn === "" ? null : () => change.mutate({ ...next, effectiveOn })
        }
      />
    </div>
  );
};

const EndPlanForm = ({
  plan,
  onSaved,
}: {
  readonly plan: SubscriptionPlan;
  readonly onSaved: () => void;
}) => {
  const [endedOn, setEndedOn] = useState(ymd(new Date()));
  const end = useMutation({
    mutationFn: (day: string) =>
      Effect.runPromise(
        api.admin.updatePlan({ params: { id: plan.id }, payload: { endedOn: day } }),
      ),
    onSuccess: onSaved,
  });

  return (
    <div className="stack">
      <p className="muted">The end date is the last day {plan.name} covered.</p>
      <Input
        size="sm"
        label="Ended on"
        type="date"
        min={plan.startedOn}
        value={endedOn}
        onChange={(event: ChangeEvent<HTMLInputElement>) => setEndedOn(event.target.value)}
      />
      <DialogActions
        label="End subscription"
        pending={end.isPending}
        error={end.error}
        onSubmit={endedOn === "" ? null : () => end.mutate(endedOn)}
      />
    </div>
  );
};

const EditPeriodForm = ({
  plan,
  onSaved,
}: {
  readonly plan: SubscriptionPlan;
  readonly onSaved: () => void;
}) => {
  const [draft, setDraft] = useState(draftOf(plan));
  const [startedOn, setStartedOn] = useState(plan.startedOn);
  const [endedOn, setEndedOn] = useState(plan.endedOn ?? "");
  const save = useMutation({
    mutationFn: (patch: SubscriptionPlanPatch) =>
      Effect.runPromise(api.admin.updatePlan({ params: { id: plan.id }, payload: patch })),
    onSuccess: onSaved,
  });
  const next = parseDraft(draft);

  return (
    <div className="stack">
      <div className="filters">
        <PlanFields draft={draft} onChange={setDraft} />
      </div>
      <div className="filters">
        <Input
          size="sm"
          label="Started on"
          type="date"
          value={startedOn}
          onChange={(event: ChangeEvent<HTMLInputElement>) => setStartedOn(event.target.value)}
        />
        <Input
          size="sm"
          label="Ended on"
          type="date"
          value={endedOn}
          onChange={(event: ChangeEvent<HTMLInputElement>) => setEndedOn(event.target.value)}
        />
      </div>
      <p className="muted">Leave Ended on empty while you still pay for the plan.</p>
      <DialogActions
        label="Save period"
        pending={save.isPending}
        error={save.error}
        onSubmit={
          next === null || startedOn === ""
            ? null
            : () => save.mutate({ ...next, startedOn, endedOn: endedOn === "" ? null : endedOn })
        }
      />
    </div>
  );
};

type TimelineRow =
  | { readonly kind: "period"; readonly plan: SubscriptionPlan; readonly overlaps: boolean }
  | { readonly kind: "gap"; readonly from: string; readonly to: string };

const openEnd = "9999-12-31";

// The server refuses new overlaps, but periods saved before that check can still overlap, so the timeline
// flags any period that starts before an earlier one ends.
const timeline = (periods: ReadonlyArray<SubscriptionPlan>): ReadonlyArray<TimelineRow> => {
  const sorted = [...periods].sort((a, b) => a.startedOn.localeCompare(b.startedOn));
  return sorted.flatMap((plan, index): ReadonlyArray<TimelineRow> => {
    const reach = sorted
      .slice(0, index)
      .map((earlier) => earlier.endedOn ?? openEnd)
      .sort()
      .at(-1);
    const period: TimelineRow = {
      kind: "period",
      plan,
      overlaps: reach !== undefined && reach >= plan.startedOn,
    };
    if (reach === undefined || period.overlaps) return [period];
    const from = addDays(reach, 1);
    return from < plan.startedOn
      ? [{ kind: "gap", from, to: addDays(plan.startedOn, -1) }, period]
      : [period];
  });
};

const dayCount = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;

const ProviderTimeline = ({
  provider,
  periods,
  onSaved,
}: {
  readonly provider: ProviderId;
  readonly periods: ReadonlyArray<SubscriptionPlan>;
  readonly onSaved: () => void;
}) => {
  const remove = useMutation({
    mutationFn: (id: string) => Effect.runPromise(api.admin.deletePlan({ params: { id } })),
    onSuccess: onSaved,
  });
  const current = periods.find((plan) => plan.endedOn === null);

  return (
    <Card
      title={providerLabels[provider]}
      note={
        current === undefined ? "no current plan" : `${current.name} since ${current.startedOn}`
      }
    >
      <table className="data-table plans-table">
        <thead>
          <tr>
            <th>Plan</th>
            <th>From</th>
            <th>To</th>
            <th className="num">Monthly</th>
            <th className="num">Actions</th>
          </tr>
        </thead>
        <tbody>
          {timeline(periods).map((row) =>
            row.kind === "gap" ? (
              <tr key={`gap:${row.from}`} className="plan-gap">
                <td className="muted">No plan for {dayCount(row.from, row.to)} days</td>
                <td className="muted">{row.from}</td>
                <td className="muted">{row.to}</td>
                <td />
                <td />
              </tr>
            ) : (
              <tr key={row.plan.id}>
                <td className="primary">
                  {row.plan.name}
                  {row.overlaps && (
                    <>
                      {" "}
                      <Badge variant="red">overlaps an earlier period</Badge>
                    </>
                  )}
                </td>
                <td>{row.plan.startedOn}</td>
                <td>{row.plan.endedOn ?? "now"}</td>
                <td className="num">{money(row.plan.monthlyPrice, row.plan.currency)}</td>
                <td className="num">
                  <div className="row">
                    {row.plan.endedOn === null && (
                      <>
                        <PlanDialog
                          title={`Change ${providerLabels[provider]} plan`}
                          trigger={<Button size="xs" variant="primary" />}
                          label="Change plan"
                          onSaved={onSaved}
                        >
                          {(done) => <ChangePlanForm plan={row.plan} onSaved={done} />}
                        </PlanDialog>
                        <PlanDialog
                          title={`End ${row.plan.name}`}
                          trigger={<Button size="xs" />}
                          label="End"
                          onSaved={onSaved}
                        >
                          {(done) => <EndPlanForm plan={row.plan} onSaved={done} />}
                        </PlanDialog>
                      </>
                    )}
                    <PlanDialog
                      title={`Edit ${row.plan.name} from ${row.plan.startedOn}`}
                      trigger={
                        <Button
                          size="xs"
                          icon={<PencilSimpleIcon />}
                          aria-label={`Edit ${row.plan.name} from ${row.plan.startedOn}`}
                        />
                      }
                      onSaved={onSaved}
                    >
                      {(done) => <EditPeriodForm plan={row.plan} onSaved={done} />}
                    </PlanDialog>
                    <Button
                      size="xs"
                      variant="secondary-destructive"
                      icon={<TrashIcon />}
                      aria-label={`Delete ${row.plan.name} from ${row.plan.startedOn}`}
                      loading={remove.isPending && remove.variables === row.plan.id}
                      onClick={() => remove.mutate(row.plan.id)}
                    />
                  </div>
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
      {remove.isError && <RequestFailure error={remove.error} />}
    </Card>
  );
};

export const PlansSettings = () => {
  const queryClient = useQueryClient();
  const plans = useQuery(plansQuery());
  const refresh = () => {
    for (const queryKey of planDependentQueries) void queryClient.invalidateQueries({ queryKey });
  };

  return (
    <Async query={plans}>
      {(rows) => (
        <>
          <Card title="Add a subscription period">
            <NewPeriod currency={rows[0]?.currency ?? "USD"} onSaved={refresh} />
          </Card>
          {providerIds
            .filter((provider) => rows.some((plan) => plan.provider === provider))
            .map((provider) => (
              <ProviderTimeline
                key={provider}
                provider={provider}
                periods={rows.filter((plan) => plan.provider === provider)}
                onSaved={refresh}
              />
            ))}
        </>
      )}
    </Async>
  );
};
