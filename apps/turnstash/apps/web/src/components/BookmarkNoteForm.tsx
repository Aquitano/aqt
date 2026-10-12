import { Button, Input } from "@cloudflare/kumo";

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
    className="bookmark-form"
    onSubmit={(event) => {
      event.preventDefault();
      onSubmit();
    }}
  >
    <Input
      size="sm"
      aria-label="Bookmark note"
      placeholder={placeholder}
      maxLength={1000}
      value={note}
      onChange={(event) => onNoteChange(event.target.value)}
      autoFocus
    />
    <Button size="sm" type="submit" loading={pending}>
      {submitLabel}
    </Button>
    <Button size="sm" variant="ghost" onClick={onCancel}>
      Cancel
    </Button>
  </form>
);
