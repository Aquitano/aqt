import { Tabs, TabsList, TabsTrigger } from "@aqt/ui/components/tabs";

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
  <Tabs
    className="max-w-full min-w-0"
    value={value}
    onValueChange={(next) => {
      const option = options.find((candidate) => candidate.value === next);
      if (option !== undefined) onChange(option.value);
    }}
  >
    <TabsList aria-label={label} className="h-8 max-w-full overflow-x-auto">
      {options.map((option) => (
        <TabsTrigger
          key={option.value}
          value={option.value}
          className="px-2.5 text-[13px] max-sm:px-1.5 max-sm:text-xs"
        >
          {option.label}
        </TabsTrigger>
      ))}
    </TabsList>
  </Tabs>
);
