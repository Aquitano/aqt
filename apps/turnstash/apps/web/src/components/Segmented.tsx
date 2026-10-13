import { ToggleGroup, ToggleGroupItem } from "@aqt/ui/components/toggle-group";

export interface SegmentedOption<V extends string> {
  readonly value: V;
  readonly label: string;
}

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
  // The period options scroll sideways on phones; the padding keeps focus rings inside the clip.
  <ToggleGroup
    aria-label={label}
    variant="outline"
    size="sm"
    spacing={0}
    className="-m-1 max-w-full overflow-x-auto p-1"
    value={[value]}
    onValueChange={([next]) => {
      const option = options.find((candidate) => candidate.value === next);
      if (option !== undefined) onChange(option.value);
    }}
  >
    {options.map((option) => (
      <ToggleGroupItem
        key={option.value}
        value={option.value}
        className="max-sm:px-2 max-sm:text-xs"
      >
        {option.label}
      </ToggleGroupItem>
    ))}
  </ToggleGroup>
);
