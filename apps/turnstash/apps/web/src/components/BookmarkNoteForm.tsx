import { Button } from "@aqt/ui/components/button";
import { Input } from "@aqt/ui/components/input";
import { Spinner } from "@aqt/ui/components/spinner";

export const BookmarkNoteForm = ({
  note,
  onNoteChange,
  onSubmit,
  onCancel,
  pending,
  submitLabel,
  placeholder,
}: {
  readonly note: string;
  readonly onNoteChange: (note: string) => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
  readonly pending: boolean;
  readonly submitLabel: string;
  readonly placeholder?: string;
}) => (
  <form
    className="flex flex-wrap items-center gap-2"
    onSubmit={(event) => {
      event.preventDefault();
      onSubmit();
    }}
  >
    <Input
      className="h-8 w-auto min-w-48 flex-1"
      aria-label="Bookmark note"
      placeholder={placeholder}
      maxLength={1000}
      value={note}
      onChange={(event) => onNoteChange(event.target.value)}
      autoFocus
    />
    <Button size="sm" variant="outline" type="submit" disabled={pending}>
      {pending && <Spinner data-icon="inline-start" />}
      {submitLabel}
    </Button>
    <Button size="sm" variant="ghost" type="button" onClick={onCancel}>
      Cancel
    </Button>
  </form>
);
