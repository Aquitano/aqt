import { Select } from "@cloudflare/kumo";

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
}: {
  readonly label: string;
  readonly anyLabel: string;
  readonly value: string | null;
  readonly options: ReadonlyArray<FilterOption>;
  readonly onChange: (value: string | null) => void;
}) => (
  <Select<string>
    aria-label={label}
    className="fixed-select"
    size="sm"
    value={value ?? anyValue}
    onValueChange={(next) => onChange(next === anyValue ? null : next)}
    items={[
      { label: anyLabel, value: anyValue },
      ...options.map((option) => ({ label: option.label, value: option.value })),
    ]}
  />
);
