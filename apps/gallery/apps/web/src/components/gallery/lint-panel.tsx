import { Badge } from "@aqt/gallery-ui/components/badge";
import { Button } from "@aqt/gallery-ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@aqt/gallery-ui/components/dialog";
import { cn } from "@aqt/gallery-ui/lib/utils";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Info,
  Loader2,
  type LucideIcon,
  MapPin,
} from "lucide-react";
import { useState } from "react";

import type { LintReport } from "./use-exhibition-curation";

type LintFinding = LintReport["findings"][number];
type LintLevel = LintFinding["level"];

/** DOM ids the panel scrolls to when a finding names an artwork or room.
 * The studio stamps these on its member rows / room cards. */
export function lintArtworkAnchor(artworkId: string) {
  return `lint-art-${artworkId}`;
}
export function lintRoomAnchor(roomId: string) {
  return `lint-room-${roomId}`;
}

const LEVEL_ORDER: LintLevel[] = ["error", "warning", "info"];

const LEVEL_META: Record<LintLevel, { icon: LucideIcon; className: string }> = {
  error: { icon: CircleAlert, className: "text-destructive" },
  warning: { icon: AlertTriangle, className: "text-amber-400" },
  info: { icon: Info, className: "text-muted-foreground" },
};

function findingAnchor(f: LintFinding): string | null {
  if (f.artworkId) return lintArtworkAnchor(f.artworkId);
  if (f.roomId) return lintRoomAnchor(f.roomId);
  return null;
}

function locate(anchorId: string) {
  const el = document.getElementById(anchorId);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  // Flash the row so the curator can spot it once the scroll settles.
  el.classList.add("ring-2", "ring-ring");
  window.setTimeout(() => el.classList.remove("ring-2", "ring-ring"), 1400);
}

function LintRow({ finding }: { finding: LintFinding }) {
  const meta = LEVEL_META[finding.level];
  const Icon = meta.icon;
  const anchor = findingAnchor(finding);
  return (
    <li className="flex items-start gap-2 rounded-xl px-3 py-2 text-sm transition-colors hover:bg-secondary/60">
      <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", meta.className)} />
      <span className="min-w-0 flex-1">{finding.message}</span>
      {anchor ? (
        <Button variant="ghost" size="xs" className="-my-1 shrink-0" onClick={() => locate(anchor)}>
          <MapPin />
          Locate
        </Button>
      ) : null}
    </li>
  );
}

/** Pre-publish lint results for the studio, grouped by severity with a link to
 * the offending artwork/room where one exists. Renders nothing until the first
 * report resolves. */
export function LintPanel({ report, loading }: { report: LintReport | null; loading: boolean }) {
  const [open, setOpen] = useState(true);

  if (!report) {
    if (!loading) return null;
    return (
      <div className="flex items-center gap-2 rounded-2xl bg-card p-5 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Checking for publish issues…
      </div>
    );
  }

  const ordered = LEVEL_ORDER.flatMap((level) => report.findings.filter((f) => f.level === level));
  const clean = ordered.length === 0;

  return (
    <section className="flex flex-col gap-3 rounded-2xl bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold tracking-[-0.02em]">Pre-publish check</h2>
          {clean ? (
            <Badge variant="success">
              <CheckCircle2 />
              Ready
            </Badge>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5">
              {report.errorCount > 0 ? (
                <Badge variant="destructive">{report.errorCount} blocking</Badge>
              ) : null}
              {report.warningCount > 0 ? (
                <Badge className="border-amber-500/30 bg-amber-500/10 text-amber-300">
                  {report.warningCount} {report.warningCount === 1 ? "warning" : "warnings"}
                </Badge>
              ) : null}
              {report.infoCount > 0 ? (
                <Badge variant="outline">{report.infoCount} info</Badge>
              ) : null}
            </div>
          )}
        </div>
        {clean ? null : (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={open ? "Collapse findings" : "Expand findings"}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <ChevronUp /> : <ChevronDown />}
          </Button>
        )}
      </div>

      {clean ? (
        <p className="text-sm text-muted-foreground">
          No issues found. This exhibition is ready to publish.
        </p>
      ) : open ? (
        <ul className="-mx-3 flex flex-col">
          {ordered.map((finding, i) => (
            <LintRow
              key={`${finding.code}-${finding.artworkId ?? finding.roomId ?? i}-${finding.wall ?? ""}`}
              finding={finding}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** Publish/unpublish toggle that inserts a confirm step when the lint report
 * has blocking (error-level) findings — publishing then risks missing artworks
 * or bare walls. Unpublishing and a clean report proceed straight through. */
export function PublishButton({
  isPublished,
  report,
  disabled,
  onToggle,
}: {
  isPublished: boolean;
  report: LintReport | null;
  disabled: boolean;
  onToggle: () => void | Promise<void>;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const blockingCount = report?.errorCount ?? 0;
  const needsConfirm = !isPublished && blockingCount > 0;

  const handleClick = () => {
    if (needsConfirm) {
      setConfirmOpen(true);
      return;
    }
    void onToggle();
  };

  return (
    <>
      <Button
        variant={isPublished ? "outline" : "default"}
        disabled={disabled}
        onClick={handleClick}
      >
        {isPublished ? "Unpublish" : "Publish"}
      </Button>
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              Publish with {blockingCount} blocking {blockingCount === 1 ? "issue" : "issues"}?
            </DialogTitle>
            <DialogDescription>
              Some hung artworks won't render, so visitors may see missing works or bare walls. Fix
              the blocking findings first, or publish anyway.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={disabled}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setConfirmOpen(false);
                void onToggle();
              }}
              disabled={disabled}
            >
              Publish anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
