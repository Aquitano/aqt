import { providerIds, providerLabels } from "@aqt/turnstash-api";
import type {
  ProviderId,
  SubscriptionPlan,
  SubscriptionPlanChange,
  SubscriptionPlanInput,
  SubscriptionPlanPatch,
} from "@aqt/turnstash-api";
import { Badge } from "@aqt/ui/components/badge";
import { Button } from "@aqt/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@aqt/ui/components/dialog";
import { Field, FieldLabel } from "@aqt/ui/components/field";
import { Input } from "@aqt/ui/components/input";
import { Spinner } from "@aqt/ui/components/spinner";
import { TableBody, TableHeader, TableRow } from "@aqt/ui/components/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import { Effect } from "effect";
import { PencilIcon, Trash2Icon } from "lucide-react";
import { useId, useState } from "react";
import type { ComponentProps, ReactElement, ReactNode } from "react";

import { api } from "../api";
import { Async, RequestFailure } from "../components/Async";
import { DataTable, PrimaryTd, Td, Th } from "../components/DataTable";
import { LabeledSelect } from "../components/LabeledSelect";
import { Section } from "../components/Section";
import { money, usd } from "../format";
import { addDays, ymd } from "../period";
import { currencies, planPresets } from "../plans";
import type { PlanPreset } from "../plans";
import { providerOptions } from "../providers";
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

const LabeledInput = ({
  label,
  className,
  ...props
}: Omit<ComponentProps<typeof Input>, "id"> & { readonly label: string }) => {
  const id = useId();
  return (
    <Field className={cn("w-32 gap-2", className)}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input id={id} className="h-8" {...props} />
    </Field>
  );
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
    <LabeledSelect
      label="Start from"
      className="w-72.5"
      value={matching?.id ?? customPlan}
      options={[
        { value: customPlan, label: "Custom plan" },
        ...presets.map((preset) => ({
          value: preset.id,
          label: `${preset.label} · ${usd(preset.monthlyPrice)}`,
        })),
      ]}
      onChange={(next) => {
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
    <LabeledInput
      label="Plan"
      placeholder="Max 20x"
      value={draft.name}
      onChange={(event) => onChange({ ...draft, name: event.target.value })}
    />
    <LabeledInput
      label="Monthly price"
      inputMode="decimal"
      className="w-27.5"
      value={draft.monthlyPrice}
      onChange={(event) => onChange({ ...draft, monthlyPrice: event.target.value })}
    />
    <LabeledSelect
      label="Currency"
      className="w-20"
      value={draft.currency}
      options={[...new Set([...currencies, draft.currency])].map((currency) => ({
        value: currency,
        label: currency,
      }))}
      onChange={(currency) => onChange({ ...draft, currency })}
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
    <div className="flex flex-col gap-3 pt-1.5">
      <div className="flex flex-wrap items-end gap-2">
        <PresetSelect
          presets={planPresets}
          provider={provider}
          draft={draft}
          onChange={(next, preset) => {
            setDraft(next);
            if (preset !== null) setProvider(preset.provider);
          }}
        />
        <LabeledSelect
          label="Provider"
          className="w-42.5"
          value={provider}
          options={providerOptions}
          onChange={setProvider}
        />
        <PlanFields draft={draft} onChange={setDraft} />
        <LabeledInput
          label="Started on"
          type="date"
          value={startedOn}
          onChange={(event) => setStartedOn(event.target.value)}
        />
        <LabeledInput
          label="Ended on"
          type="date"
          value={endedOn}
          onChange={(event) => setEndedOn(event.target.value)}
        />
        <Button
          size="sm"
          disabled={create.isPending || plan === null || startedOn === ""}
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
          {create.isPending && <Spinner data-icon="inline-start" />}
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
  readonly label: ReactNode;
  readonly onSaved: () => void;
  readonly children: (done: () => void) => ReactNode;
}) => {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger}>{label}</DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {children(() => {
          setOpen(false);
          onSaved();
        })}
      </DialogContent>
    </Dialog>
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
    <DialogFooter className="pt-2">
      <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
      <Button disabled={pending || onSubmit === null} onClick={onSubmit ?? undefined}>
        {pending && <Spinner data-icon="inline-start" />}
        {label}
      </Button>
    </DialogFooter>
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
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        On {plan.name} at {money(plan.monthlyPrice, plan.currency)} a month since {plan.startedOn}.
      </p>
      <PresetSelect
        presets={planPresets.filter((preset) => preset.provider === plan.provider)}
        provider={plan.provider}
        draft={draft}
        onChange={setDraft}
      />
      <div className="flex flex-wrap items-end gap-2">
        <PlanFields draft={draft} onChange={setDraft} />
      </div>
      <LabeledInput
        label="Effective on"
        type="date"
        min={firstDay}
        value={effectiveOn}
        onChange={(event) => setEffectiveOn(event.target.value)}
      />
      {next !== null && effectiveOn >= firstDay && (
        <p className="text-xs text-muted-foreground">
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
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        The end date is the last day {plan.name} covered.
      </p>
      <LabeledInput
        label="Ended on"
        type="date"
        min={plan.startedOn}
        value={endedOn}
        onChange={(event) => setEndedOn(event.target.value)}
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
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-2">
        <PlanFields draft={draft} onChange={setDraft} />
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <LabeledInput
          label="Started on"
          type="date"
          value={startedOn}
          onChange={(event) => setStartedOn(event.target.value)}
        />
        <LabeledInput
          label="Ended on"
          type="date"
          value={endedOn}
          onChange={(event) => setEndedOn(event.target.value)}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Leave Ended on empty while you still pay for the plan.
      </p>
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
  const sorted = periods.toSorted((a, b) => a.startedOn.localeCompare(b.startedOn));
  return sorted.flatMap((plan, index): ReadonlyArray<TimelineRow> => {
    const reach = sorted
      .slice(0, index)
      .map((earlier) => earlier.endedOn ?? openEnd)
      .toSorted()
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
    <Section
      title={providerLabels[provider]}
      note={
        current === undefined ? "no current plan" : `${current.name} since ${current.startedOn}`
      }
    >
      {/* Fixed columns so every provider's timeline lines up with the next one. */}
      <DataTable className="table-fixed">
        <TableHeader>
          <TableRow>
            <Th>Plan</Th>
            <Th className="w-[15%]">From</Th>
            <Th className="w-[15%]">To</Th>
            <Th numeric className="w-[12%]">
              Monthly
            </Th>
            <Th numeric className="w-52.5">
              Actions
            </Th>
          </TableRow>
        </TableHeader>
        <TableBody>
          {timeline(periods).map((row) => {
            if (row.kind === "gap")
              return (
                <TableRow key={`gap:${row.from}`} className="text-xs text-muted-foreground">
                  <Td>No plan for {dayCount(row.from, row.to)} days</Td>
                  <Td>{row.from}</Td>
                  <Td>{row.to}</Td>
                  <Td />
                  <Td />
                </TableRow>
              );
            const label = `${row.plan.name} from ${row.plan.startedOn}`;
            const deleting = remove.isPending && remove.variables === row.plan.id;
            return (
              <TableRow key={row.plan.id}>
                <PrimaryTd>
                  {row.plan.name}
                  {row.overlaps && (
                    <>
                      {" "}
                      <Badge variant="destructive">overlaps an earlier period</Badge>
                    </>
                  )}
                </PrimaryTd>
                <Td>{row.plan.startedOn}</Td>
                <Td>{row.plan.endedOn ?? "now"}</Td>
                <Td numeric>{money(row.plan.monthlyPrice, row.plan.currency)}</Td>
                <Td numeric>
                  <div className="flex items-center justify-end gap-1.5">
                    {row.plan.endedOn === null && (
                      <>
                        <PlanDialog
                          title={`Change ${providerLabels[provider]} plan`}
                          trigger={<Button size="xs" />}
                          label="Change plan"
                          onSaved={onSaved}
                        >
                          {(done) => <ChangePlanForm plan={row.plan} onSaved={done} />}
                        </PlanDialog>
                        <PlanDialog
                          title={`End ${row.plan.name}`}
                          trigger={<Button size="xs" variant="outline" />}
                          label="End"
                          onSaved={onSaved}
                        >
                          {(done) => <EndPlanForm plan={row.plan} onSaved={done} />}
                        </PlanDialog>
                      </>
                    )}
                    <PlanDialog
                      title={`Edit ${label}`}
                      trigger={
                        <Button size="icon-xs" variant="outline" aria-label={`Edit ${label}`} />
                      }
                      label={<PencilIcon />}
                      onSaved={onSaved}
                    >
                      {(done) => <EditPeriodForm plan={row.plan} onSaved={done} />}
                    </PlanDialog>
                    <Button
                      size="icon-xs"
                      variant="destructive"
                      aria-label={`Delete ${label}`}
                      disabled={deleting}
                      onClick={() => remove.mutate(row.plan.id)}
                    >
                      {deleting ? <Spinner /> : <Trash2Icon />}
                    </Button>
                  </div>
                </Td>
              </TableRow>
            );
          })}
        </TableBody>
      </DataTable>
      {remove.isError && <RequestFailure error={remove.error} />}
    </Section>
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
          <Section title="Add a subscription period">
            <NewPeriod currency={rows[0]?.currency ?? "USD"} onSaved={refresh} />
          </Section>
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
