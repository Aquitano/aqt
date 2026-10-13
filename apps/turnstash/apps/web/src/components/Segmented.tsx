import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@aqt/ui/components/select";
import { ToggleGroup, ToggleGroupItem } from "@aqt/ui/components/toggle-group";

export interface SegmentedOption<V extends string> {
  readonly value: V;
  readonly label: string;
}

// Phones get a select, as in shadcn's dashboard, because six periods in a row run off the screen.
export const Segmented = <V extends string>({
  label,
  options,
  value,
  onChange,
}: {
  readonly label: string;
  readonly options: ReadonlyArray<SegmentedOption<V>>;
  readonly value: V;
  readonly onChange: (value: V) => void;
}) => (
  <>
    <ToggleGroup
      aria-label={label}
      variant="outline"
      size="sm"
      spacing={0}
      className="max-sm:hidden"
      value={[value]}
      onValueChange={([next]) => {
        const option = options.find((candidate) => candidate.value === next);
        if (option !== undefined) onChange(option.value);
      }}
    >
      {options.map((option) => (
        <ToggleGroupItem key={option.value} value={option.value}>
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
    <Select
      items={options}
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
    >
      <SelectTrigger size="sm" aria-label={label} className="sm:hidden">
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
  </>
);
