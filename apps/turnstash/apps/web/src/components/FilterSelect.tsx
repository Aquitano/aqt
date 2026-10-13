import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@aqt/ui/components/select";
import { cn } from "cn";

export interface FilterOption {
  readonly value: string;
  readonly label: string;
}

const anyValue = "__any__";

/**
 * A leading "any" option clears the filter without a separate reset control.
 */
export const FilterSelect = ({
  label,
  anyLabel,
  value,
  options,
  onChange,
  className,
}: {
  readonly label: string;
  readonly anyLabel: string;
  readonly value: string | null;
  readonly options: ReadonlyArray<FilterOption>;
  readonly onChange: (value: string | null) => void;
  readonly className?: string;
}) => {
  const items = [{ label: anyLabel, value: anyValue }, ...options];
  return (
    <Select
      items={items}
      value={value ?? anyValue}
      onValueChange={(next) => onChange(next === null || next === anyValue ? null : next)}
    >
      <SelectTrigger size="sm" aria-label={label} className={cn("w-40", className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};
