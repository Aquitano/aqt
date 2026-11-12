import { Badge } from "@aqt/ui/components/badge";
import { Button } from "@aqt/ui/components/button";
import { Spinner } from "@aqt/ui/components/spinner";
import { XIcon } from "lucide-react";

export interface ActiveFilter {
  readonly key: string;
  readonly label: string;
  readonly onClear: () => void;
}

export const FilterChips = ({
  filters,
  onClearAll,
}: {
  readonly filters: ReadonlyArray<ActiveFilter>;
  readonly onClearAll: () => void;
}) =>
  filters.length === 0 ? null : (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {filters.map((filter) => (
        <Badge key={filter.key} variant="secondary" className="h-6 max-w-full gap-1 pr-0.5">
          <span className="truncate">{filter.label}</span>
          <button
            type="button"
            aria-label={`Remove filter ${filter.label}`}
            className="grid size-5 shrink-0 cursor-pointer place-items-center rounded-full outline-none hover:bg-foreground/10 focus-visible:ring-[3px] focus-visible:ring-ring/50"
            onClick={filter.onClear}
          >
            <XIcon className="size-3" />
          </button>
        </Badge>
      ))}
      {filters.length > 1 && (
        <Button size="xs" variant="ghost" onClick={onClearAll}>
          Clear all
        </Button>
      )}
    </div>
  );

export const LoadMore = ({
  shown,
  noun,
  loading,
  failed,
  onLoad,
  label,
}: {
  readonly shown: number;
  readonly noun: string;
  readonly loading: boolean;
  readonly failed: boolean;
  readonly onLoad: () => void;
  readonly label: string;
}) => (
  <div className="flex flex-col items-center gap-2 border-t pt-4 text-xs text-muted-foreground">
    <span>
      Showing {shown} {noun}, more available
    </span>
    <Button size="sm" variant="outline" disabled={loading} onClick={onLoad}>
      {loading && <Spinner data-icon="inline-start" />}
      {failed ? `Retry loading ${noun}` : label}
    </Button>
  </div>
);
