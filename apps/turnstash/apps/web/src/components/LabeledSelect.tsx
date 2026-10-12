import { Field, FieldLabel } from "@aqt/ui/components/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@aqt/ui/components/select";
import { cn } from "cn";
import { useId } from "react";

export const LabeledSelect = <V extends string>({
  label,
  className,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly className?: string;
  readonly value: V;
  readonly options: ReadonlyArray<{ readonly value: V; readonly label: string }>;
  readonly onChange: (value: V) => void;
}) => {
  const id = useId();
  return (
    <Field className={cn("gap-2", className)}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select
        items={options}
        value={value}
        onValueChange={(next) => {
          if (next !== null) onChange(next);
        }}
      >
        <SelectTrigger id={id} size="sm" className="text-[13px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
};
