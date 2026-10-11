import { Badge } from "@aqt/ui/components/badge";
import { Button } from "@aqt/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@aqt/ui/components/dialog";
import { Input } from "@aqt/ui/components/input";
import { Kbd } from "@aqt/ui/components/kbd";
import { ScrollArea } from "@aqt/ui/components/scroll-area";
import { Textarea } from "@aqt/ui/components/textarea";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ImageIcon, Link2, Loader2, TriangleAlert, Upload, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { isMacPlatform } from "@/hooks/use-hotkeys";

import { type ImportItem, type ImportStatus, MAX_QUEUE, useImportQueue } from "./use-import-queue";

export type ImportTarget = {
  /** Where new artworks land, surfaced in the dialog (e.g. a gallery name). */
  label: string;
  onImported: (artworkIds: string[]) => void | Promise<void>;
};

type ImportDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: ImportTarget | null;
};

export function ImportDialog({ open, onOpenChange, target }: ImportDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-2xl">
        <ImportWorkspace target={target} onOpenChange={onOpenChange} />
      </DialogContent>
    </Dialog>
  );
}

function ImportWorkspace({
  target,
  onOpenChange,
}: {
  target: ImportTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queue = useImportQueue();
  const queryClient = useQueryClient();
  const fileInputId = useId();
  const urlInputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [urlDraft, setUrlDraft] = useState("");
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const modKey = isMacPlatform() ? "⌘" : "Ctrl";

  // A drag that leaves the window may not fire a final `dragleave`; reset the
  // overlay on any window-level drag end so the highlight can't get stuck.
  useEffect(() => {
    const reset = () => {
      dragDepth.current = 0;
      setDragging(false);
    };
    window.addEventListener("dragend", reset);
    window.addEventListener("drop", reset);
    return () => {
      window.removeEventListener("dragend", reset);
      window.removeEventListener("drop", reset);
    };
  }, []);

  const pending = queue.counts.ready + queue.counts.error;
  const canImport = pending > 0 && !queue.isImporting;

  const commitUrlDraft = () => {
    const before = queue.counts.total;
    const added = queue.addUrlText(urlDraft);
    if (added > 0) {
      setUrlDraft("");
      toast.success(`Added ${added} URL${added === 1 ? "" : "s"}`);
      noteIfFull(before, added);
    } else if (urlDraft.trim()) {
      toast.error("Enter one http(s) image URL per line");
    }
  };

  const handleImport = async () => {
    if (!canImport) return;
    const result = await queue.runImport();
    if (result.imported > 0) {
      // Only refetch when something actually imported, so a fully-failed run
      // doesn't trigger an app-wide refetch.
      await queryClient.invalidateQueries();
      if (target) await target.onImported(result.importedArtworkIds);
      toast.success(
        target
          ? `Imported ${result.imported} · added to ${target.label}`
          : `Imported ${result.imported} into your archive`,
      );
    }
    if (result.cancelled) {
      toast("Import stopped — the remaining items are kept");
      return;
    }
    if (result.failed > 0) {
      toast.error(`${result.failed} couldn't be imported — check the highlighted items`);
    } else {
      queue.clear();
      onOpenChange(false);
    }
  };

  const noteIfFull = (before: number, added: number) => {
    if (added > 0 && before + added >= MAX_QUEUE) {
      toast(`Queue is full (max ${MAX_QUEUE}). Import these before adding more.`);
    }
  };

  const handlePaste = (event: React.ClipboardEvent) => {
    const data = event.clipboardData;
    if (data.files.length > 0) {
      event.preventDefault();
      const added = queue.addFiles(data.files);
      if (added > 0) toast.success(`Added ${added} image${added === 1 ? "" : "s"}`);
      return;
    }
    const intoUrlBox =
      event.target instanceof HTMLElement && event.target.closest("[data-url-input]");
    if (!intoUrlBox) {
      const added = queue.addUrlText(data.getData("text"));
      if (added > 0) {
        event.preventDefault();
        toast.success(`Added ${added} URL${added === 1 ? "" : "s"}`);
      }
    }
  };

  return (
    // This container only augments the dialog's real focusable controls with drag-drop, clipboard paste, and the ⌘↵ import shortcut
    <div
      className="flex max-h-[inherit] flex-col"
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          void handleImport();
        }
      }}
      onPaste={handlePaste}
      onDragEnter={(event) => {
        event.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        event.preventDefault();
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        const before = queue.counts.total;
        const added = queue.addFromDataTransfer(event.dataTransfer);
        if (added > 0) {
          toast.success(`Added ${added} item${added === 1 ? "" : "s"}`);
          noteIfFull(before, added);
        }
      }}
    >
      <DialogHeader className="px-5 pt-5 pb-4">
        <DialogTitle>Import artworks</DialogTitle>
        <DialogDescription>
          {target
            ? `New artworks land in your archive and are added to ${target.label}.`
            : "Drop files, paste, or add URLs — everything queues here before import."}
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-3 px-5">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          data-dragging={dragging}
          className="flex min-h-28 flex-col items-center justify-center gap-1.5 rounded-2xl border border-dashed border-border bg-card/60 px-4 text-center transition-colors outline-none hover:bg-card focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 data-[dragging=true]:border-ring data-[dragging=true]:bg-secondary"
        >
          <Upload className="size-5 text-muted-foreground" />
          <span className="text-sm font-medium">Drop images, paste, or browse</span>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            JPEG · PNG · WebP · GIF
            <span className="text-muted-foreground/60">·</span>
            <Kbd>{modKey}</Kbd>
            <Kbd>V</Kbd> to paste
          </span>
        </button>
        <input
          ref={fileInputRef}
          id={fileInputId}
          className="sr-only"
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          multiple
          onChange={(event) => {
            if (event.target.files) {
              const added = queue.addFiles(event.target.files);
              if (added > 0) toast.success(`Added ${added} image${added === 1 ? "" : "s"}`);
              event.target.value = "";
            }
          }}
        />

        <div className="flex items-end gap-2">
          <div className="flex flex-1 flex-col gap-1.5">
            <label
              htmlFor={urlInputId}
              className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
            >
              <Link2 className="size-3.5" /> Image URLs
            </label>
            <Textarea
              id={urlInputId}
              data-url-input=""
              // Cap manual resize so a tall textarea can't push the footer
              // out of the dialog; vertical-only since width is flex-controlled.
              className="max-h-[25svh] resize-y"
              rows={2}
              placeholder={"https://example.com/painting.jpg\nOne URL per line"}
              value={urlDraft}
              onChange={(event) => setUrlDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.stopPropagation();
                  event.preventDefault();
                  commitUrlDraft();
                }
              }}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={commitUrlDraft}
            disabled={parseHasUrl(urlDraft) === false}
          >
            Add URLs
          </Button>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-border/60 px-5 py-2.5">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-medium">Queue</span>
          <span className="text-muted-foreground">{queue.counts.total}</span>
          {queue.counts.done > 0 ? <Badge variant="success">{queue.counts.done} done</Badge> : null}
          {queue.counts.error > 0 ? (
            <Badge variant="destructive">{queue.counts.error} failed</Badge>
          ) : null}
        </div>
        {queue.counts.total > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={queue.clear}
            disabled={queue.isImporting}
          >
            Clear all
          </Button>
        ) : null}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {queue.items.length === 0 ? (
          <div className="flex min-h-32 flex-col items-center justify-center gap-1 px-5 py-8 text-center text-xs text-muted-foreground">
            <ImageIcon className="size-5 opacity-60" />
            Nothing queued yet. Add files or URLs above.
          </div>
        ) : (
          <ul className="flex min-h-32 flex-col divide-y divide-border/50">
            {queue.items.map((item) => (
              <ImportRow
                key={item.id}
                item={item}
                disabled={queue.isImporting}
                onTitle={(title) => queue.updateTitle(item.id, title)}
                onRemove={() => queue.remove(item.id)}
              />
            ))}
          </ul>
        )}
      </ScrollArea>

      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border/60 px-5 py-4">
        <span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
          <Kbd>{modKey}</Kbd>
          <Kbd>↵</Kbd>
          to import
        </span>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => (queue.isImporting ? queue.cancel() : onOpenChange(false))}
          >
            {queue.isImporting ? "Stop" : "Cancel"}
          </Button>
          <Button type="button" onClick={handleImport} disabled={!canImport}>
            {queue.isImporting ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Importing {queue.progress?.done ?? 0}/{queue.progress?.total ?? 0}
              </>
            ) : (
              <>
                <Upload className="size-3.5" />
                Import{pending > 0 ? ` ${pending}` : ""}
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ImportRow({
  item,
  disabled,
  onTitle,
  onRemove,
}: {
  item: ImportItem;
  disabled: boolean;
  onTitle: (title: string) => void;
  onRemove: () => void;
}) {
  return (
    <li className="flex items-center gap-3 px-5 py-2.5">
      <Thumb item={item} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Input
          value={item.title}
          aria-label="Artwork title"
          disabled={disabled || item.status === "uploading"}
          onChange={(event) => onTitle(event.target.value)}
        />
        <div className="flex items-center gap-1.5">
          <Badge variant="outline">
            {item.source === "url" ? <Link2 /> : <ImageIcon />}
            {item.source}
          </Badge>
          <StatusLabel status={item.status} error={item.error} />
        </div>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Remove from queue"
        onClick={onRemove}
        disabled={disabled}
      >
        <X />
      </Button>
    </li>
  );
}

function Thumb({ item }: { item: ImportItem }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <ImageIcon className="size-4" />
      </div>
    );
  }
  return (
    <img
      src={item.previewUrl}
      alt=""
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="size-11 shrink-0 rounded-lg object-cover"
    />
  );
}

function StatusLabel({ status, error }: { status: ImportStatus; error?: string }) {
  if (status === "uploading") {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" /> Importing
      </span>
    );
  }
  if (status === "done") {
    return (
      <span className="flex items-center gap-1 text-xs text-success">
        <CheckCircle2 className="size-3" /> Done
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="flex items-center gap-1 truncate text-xs text-destructive" title={error}>
        <TriangleAlert className="size-3 shrink-0" /> {error ?? "Failed"}
      </span>
    );
  }
  return <span className="text-xs text-muted-foreground">Ready</span>;
}

function parseHasUrl(text: string): boolean {
  return /^https?:\/\//im.test(text);
}
