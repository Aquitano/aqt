import { Button } from "@aqt/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@aqt/ui/components/dropdown-menu";
import { Input } from "@aqt/ui/components/input";
import { Label } from "@aqt/ui/components/label";
import { Textarea } from "@aqt/ui/components/textarea";
import { cn } from "@aqt/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowUpRight,
  ChevronDown,
  Ellipsis,
  ExternalLink,
  Maximize2,
  Pencil,
  Plus,
  Trash2,
  UserRound,
} from "lucide-react";
import type { ReactNode } from "react";

import type { ArtistRow } from "./artist-dialog";
import { StarRating } from "./star-rating";
import { TagInput } from "./tag-input";
import { ARTWORK_TYPES, type ArtworkType } from "./types";

export type ArtworkFormValues = {
  title: string;
  artist: string;
  artistId: string;
  artworkType: ArtworkType;
  year: string;
  medium: string;
  dimensions: string;
  seenAt: string;
  rating: number;
  review: string;
  thoughts: string;
  description: string;
  story: string;
  funFacts: string;
  sourceUrl: string;
  tags: string[];
};

export type CustomFieldRow = { id: string; label: string; value: string };

export type ArtworkImage = {
  url: string;
  width: number | null;
  height: number | null;
};

export function ArtworkEditor({
  image,
  form,
  onFormChange,
  customFields,
  onCustomFieldsChange,
  artists,
  onEditArtist,
  dirty,
  saving,
  onSave,
  onDiscard,
  onDelete,
}: {
  image: ArtworkImage | null;
  form: ArtworkFormValues;
  onFormChange: (patch: Partial<ArtworkFormValues>) => void;
  customFields: CustomFieldRow[];
  onCustomFieldsChange: (rows: CustomFieldRow[]) => void;
  artists: ArtistRow[];
  /** `null` opens the dialog in create mode. */
  onEditArtist: (artist: ArtistRow | null) => void;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onDelete: () => void;
}) {
  const linkedArtist = artists.find((entry) => entry.id === form.artistId) ?? null;
  const typeLabel =
    ARTWORK_TYPES.find((entry) => entry.value === form.artworkType)?.label ?? "Other";
  const eyebrow = [form.artist, form.year, typeLabel].filter(Boolean).join(" · ");
  const artistMeta = linkedArtist
    ? [
        linkedArtist.nationality,
        [linkedArtist.birthYear, linkedArtist.deathYear].filter(Boolean).join("–"),
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  const updateField = (index: number, patch: Partial<CustomFieldRow>) =>
    onCustomFieldsChange(
      customFields.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)),
    );

  return (
    <div className="mx-auto grid max-w-[1480px] gap-10 pt-3 lg:grid-cols-[minmax(0,1fr)_minmax(380px,460px)] lg:gap-16">
      <section className="lg:sticky lg:top-[84px] lg:flex lg:h-[calc(100svh-108px)] lg:flex-col lg:self-start">
        <div className="flex min-h-[46svh] items-center justify-center lg:min-h-0 lg:flex-1">
          {image ? (
            <img
              src={image.url}
              alt={form.title}
              className="max-h-[70svh] w-auto max-w-full rounded-md shadow-[0_40px_90px_-30px_rgba(0,0,0,0.85)] ring-1 ring-white/[0.06] lg:max-h-full"
            />
          ) : (
            <div className="grid aspect-[4/5] w-full max-w-sm place-items-center rounded-md bg-card text-sm text-muted-foreground">
              No image
            </div>
          )}
        </div>
        {image ? (
          <div className="mt-4 flex items-center justify-center gap-5 text-[12px] text-muted-foreground">
            {image.width && image.height ? (
              <span className="tabular-nums">
                {image.width} × {image.height} px
              </span>
            ) : null}
            <a
              href={image.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 transition-colors hover:text-foreground"
            >
              Full size
              <ArrowUpRight size={13} />
            </a>
          </div>
        ) : null}
      </section>

      <aside className="pb-24">
        <div className="flex items-center justify-between">
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2.5"
            nativeButton={false}
            render={<Link to="/explore" />}
          >
            <ArrowLeft />
            Explore
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon-sm" aria-label="More actions" />}
            >
              <Ellipsis />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-52">
              {form.sourceUrl ? (
                <DropdownMenuItem onClick={() => window.open(form.sourceUrl, "_blank", "noopener")}>
                  <ExternalLink />
                  Open source page
                </DropdownMenuItem>
              ) : null}
              {image ? (
                <DropdownMenuItem onClick={() => window.open(image.url, "_blank", "noopener")}>
                  <Maximize2 />
                  View full-size image
                </DropdownMenuItem>
              ) : null}
              {form.sourceUrl || image ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                <Trash2 />
                Delete artwork
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <p className="mt-6 min-h-4 text-[11px] tracking-[0.16em] text-muted-foreground uppercase">
          {eyebrow}
        </p>
        <textarea
          aria-label="Title"
          rows={1}
          value={form.title}
          placeholder="Untitled artwork"
          className="mt-2 [field-sizing:content] w-full resize-none bg-transparent text-[30px] leading-[1.15] font-semibold tracking-[-0.03em] outline-none placeholder:text-muted-foreground/40"
          onChange={(event) => onFormChange({ title: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.preventDefault();
          }}
        />

        <Section title="The work">
          <div className="grid grid-cols-2 gap-x-3 gap-y-4">
            <Field id="artist" label="Artist">
              <Input
                id="artist"
                value={form.artist}
                onChange={(event) => onFormChange({ artist: event.target.value })}
              />
            </Field>
            <Field id="year" label="Year">
              <Input
                id="year"
                value={form.year}
                placeholder="c. 1480"
                onChange={(event) => onFormChange({ year: event.target.value })}
              />
            </Field>
            <Field id="type" label="Type">
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      id="type"
                      variant="outline"
                      className="h-9 w-full justify-between rounded-lg border-input px-3 font-normal"
                    />
                  }
                >
                  {typeLabel}
                  <ChevronDown className="text-muted-foreground" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-(--anchor-width)">
                  <DropdownMenuRadioGroup
                    value={form.artworkType}
                    onValueChange={(value) => onFormChange({ artworkType: value as ArtworkType })}
                  >
                    {ARTWORK_TYPES.map((option) => (
                      <DropdownMenuRadioItem key={option.value} value={option.value}>
                        {option.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </Field>
            <Field id="medium" label="Medium">
              <Input
                id="medium"
                value={form.medium}
                placeholder="Oil on canvas"
                onChange={(event) => onFormChange({ medium: event.target.value })}
              />
            </Field>
            <Field id="dimensions" label="Dimensions">
              <Input
                id="dimensions"
                value={form.dimensions}
                placeholder="73.7 × 92.1 cm"
                onChange={(event) => onFormChange({ dimensions: event.target.value })}
              />
            </Field>
            <Field id="source" label="Source URL">
              <Input
                id="source"
                type="url"
                value={form.sourceUrl}
                placeholder="https://"
                onChange={(event) => onFormChange({ sourceUrl: event.target.value })}
              />
            </Field>
          </div>
          <Field label="Linked artist" hint="Bio and dates shown on the museum wall">
            <div className="flex items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
                  <UserRound />
                  {linkedArtist ? linkedArtist.name : "No linked artist"}
                  <ChevronDown className="text-muted-foreground" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-72 min-w-56">
                  <DropdownMenuRadioGroup
                    value={form.artistId || "none"}
                    onValueChange={(value) =>
                      onFormChange({
                        artistId: value === "none" ? "" : value,
                      })
                    }
                  >
                    <DropdownMenuRadioItem value="none">No linked artist</DropdownMenuRadioItem>
                    {artists.map((entry) => (
                      <DropdownMenuRadioItem key={entry.id} value={entry.id}>
                        {entry.name}
                        {entry.userId ? "" : " · built-in"}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => onEditArtist(null)}>
                    <Plus />
                    Create new artist…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              {linkedArtist?.userId ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Edit linked artist"
                  onClick={() => onEditArtist(linkedArtist)}
                >
                  <Pencil />
                </Button>
              ) : null}
              {artistMeta ? (
                <span className="text-[12.5px] text-muted-foreground">{artistMeta}</span>
              ) : null}
            </div>
          </Field>
        </Section>

        <Section title="Your visit">
          <div className="grid grid-cols-2 gap-x-3 gap-y-4">
            <Field id="seen" label="Seen on">
              <Input
                id="seen"
                type="date"
                value={form.seenAt}
                onChange={(event) => onFormChange({ seenAt: event.target.value })}
              />
            </Field>
            <Field label="Rating">
              <StarRating value={form.rating} onChange={(rating) => onFormChange({ rating })} />
            </Field>
          </div>
          <Field id="review" label="Review">
            <Textarea
              id="review"
              value={form.review}
              placeholder="How it held up in the room."
              onChange={(event) => onFormChange({ review: event.target.value })}
            />
          </Field>
          <Field id="thoughts" label="Thoughts">
            <Textarea
              id="thoughts"
              value={form.thoughts}
              placeholder="Loose notes, only for you."
              onChange={(event) => onFormChange({ thoughts: event.target.value })}
            />
          </Field>
        </Section>

        <Section title="On the wall" hint="What visitors read when they inspect the work in 3D">
          <Field id="description" label="Description">
            <Textarea
              id="description"
              value={form.description}
              onChange={(event) => onFormChange({ description: event.target.value })}
            />
          </Field>
          <Field id="story" label="Story">
            <Textarea
              id="story"
              value={form.story}
              placeholder="A short, engaging narrative shown beside the work."
              onChange={(event) => onFormChange({ story: event.target.value })}
            />
          </Field>
          <Field id="facts" label="Fun facts" hint="One per line">
            <Textarea
              id="facts"
              value={form.funFacts}
              placeholder={"Painted in a single sitting.\nIts blue pigment was newly imported."}
              onChange={(event) => onFormChange({ funFacts: event.target.value })}
            />
          </Field>
          <Field id="tags" label="Tags">
            <TagInput
              id="tags"
              value={form.tags}
              placeholder="Add a tag and press Enter"
              onChange={(tags) => onFormChange({ tags })}
            />
          </Field>
        </Section>

        <Section title="Custom fields">
          {customFields.length > 0 ? (
            <div className="flex flex-col gap-2">
              {customFields.map((row, index) => (
                <div
                  key={row.id}
                  className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] gap-2"
                >
                  <Input
                    aria-label="Custom field label"
                    value={row.label}
                    placeholder="Label"
                    onChange={(event) => updateField(index, { label: event.target.value })}
                  />
                  <Input
                    aria-label="Custom field value"
                    value={row.value}
                    placeholder="Value"
                    onChange={(event) => updateField(index, { value: event.target.value })}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Remove custom field"
                    onClick={() =>
                      onCustomFieldsChange(customFields.filter((_, rowIndex) => rowIndex !== index))
                    }
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() =>
              onCustomFieldsChange([
                ...customFields,
                { id: crypto.randomUUID(), label: "", value: "" },
              ])
            }
          >
            <Plus />
            Add field
          </Button>
        </Section>
      </aside>

      <div
        aria-hidden={!dirty}
        className={cn(
          "fixed bottom-6 left-1/2 z-40 -translate-x-1/2 transition-all duration-200 ease-out",
          dirty ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-3 opacity-0",
        )}
      >
        <div className="flex items-center gap-1 rounded-full border border-border bg-popover/90 py-1.5 pr-1.5 pl-4 shadow-[0_20px_50px_-20px_rgba(0,0,0,0.8)] backdrop-blur-xl">
          <span className="mr-2 flex items-center gap-2 text-[13px] whitespace-nowrap text-muted-foreground">
            <span className="size-1.5 rounded-full bg-amber-300" />
            <span className="hidden sm:inline">Unsaved changes</span>
          </span>
          <Button variant="ghost" size="sm" onClick={onDiscard} disabled={saving}>
            Discard
          </Button>
          <Button size="sm" onClick={onSave} disabled={saving}>
            {saving ? "Saving…" : "Save"}
            <span className="ml-0.5 text-[11px] opacity-60">⌘S</span>
          </Button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="mt-9 flex flex-col gap-4 border-t border-border pt-6">
      <div>
        <h2 className="text-[11px] tracking-[0.16em] text-muted-foreground uppercase">{title}</h2>
        {hint ? <p className="mt-1 text-[12.5px] text-muted-foreground/70">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id?: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id} className="text-muted-foreground">
        {label}
        {hint ? <span className="font-normal text-muted-foreground/60">{hint}</span> : null}
      </Label>
      {children}
    </div>
  );
}
