import { Button } from "@aqt/ui/components/button";
import { Field, FieldGroup, FieldLabel } from "@aqt/ui/components/field";
import { Input } from "@aqt/ui/components/input";
import { Option, Schema } from "effect";
import { useId, useState, useEffect } from "react";

import { hourMs, type LimitSpan } from "../limits-model";
import type { LimitSelection } from "./LimitChart";

const decodeField = Schema.decodeUnknownOption(Schema.String);

const localTime = (ms: number) => {
  const date = new Date(ms);
  return new Date(ms - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

export const DrainRange = ({
  span,
  nowMs,
  selection,
  onSelect,
}: {
  readonly span: LimitSpan;
  readonly nowMs: number;
  readonly selection: LimitSelection | null;
  readonly onSelect: (selection: LimitSelection) => void;
}) => {
  const id = useId();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [selection?.fromMs, selection?.toMs]);
  const end = Math.min(span.toMs, nowMs);
  const clamp = (ms: number) => Math.min(end, Math.max(span.fromMs, ms));
  return (
    <details className="mt-3 text-xs">
      <summary className="w-fit cursor-pointer rounded-sm text-muted-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
        Choose a time range
      </summary>
      <form
        key={`${selection?.fromMs}:${selection?.toMs}`}
        className="mt-3"
        onSubmit={(event) => {
          event.preventDefault();
          const fields = new FormData(event.currentTarget);
          const from = fields.get("from");
          const to = fields.get("to");
          const fromMs = Date.parse(Option.getOrElse(decodeField(from), () => ""));
          const toMs = Date.parse(Option.getOrElse(decodeField(to), () => ""));
          if (
            !Number.isFinite(fromMs) ||
            !Number.isFinite(toMs) ||
            fromMs >= toMs ||
            fromMs < span.fromMs ||
            toMs > end
          ) {
            setError("Choose an end after the start, within the displayed history.");
            return;
          }
          setError(null);
          onSelect({ fromMs, toMs });
        }}
      >
        <FieldGroup className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field className="min-w-0 flex-1">
            <FieldLabel htmlFor={`${id}-from`}>From</FieldLabel>
            <Input
              id={`${id}-from`}
              name="from"
              type="datetime-local"
              required
              min={localTime(span.fromMs)}
              max={localTime(end)}
              defaultValue={localTime(clamp(selection?.fromMs ?? end - hourMs))}
            />
          </Field>
          <Field className="min-w-0 flex-1">
            <FieldLabel htmlFor={`${id}-to`}>To</FieldLabel>
            <Input
              id={`${id}-to`}
              name="to"
              type="datetime-local"
              required
              min={localTime(span.fromMs)}
              max={localTime(end)}
              defaultValue={localTime(clamp(selection?.toMs ?? end))}
            />
          </Field>
          <Button type="submit" size="sm" variant="secondary">
            Inspect requests
          </Button>
        </FieldGroup>
        {error !== null && (
          <p role="alert" className="mt-2 text-destructive">
            {error}
          </p>
        )}
      </form>
    </details>
  );
};
