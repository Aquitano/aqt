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

export const quietControl =
  "rounded-lg border-transparent bg-muted/70 hover:bg-muted dark:bg-muted/70 dark:hover:bg-muted";

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
      size="sm"
      spacing={0}
      className="gap-0.5 rounded-lg bg-muted/70 p-0.5 max-sm:hidden"
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
          className="h-7 min-w-0 rounded-md! px-2.5! text-[13px] font-normal text-muted-foreground hover:bg-transparent hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
        >
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
      <SelectTrigger size="sm" aria-label={label} className={`sm:hidden ${quietControl}`}>
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
