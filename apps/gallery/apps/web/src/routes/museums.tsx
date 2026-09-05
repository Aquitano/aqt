import { Badge } from "@aqt-gallery/ui/components/badge";
import { Button } from "@aqt-gallery/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";

import { CosmosShell } from "@/components/gallery/cosmos-shell";
import { MuseumEditorDialog } from "@/components/gallery/museum-editor-dialog";
import type { StudioMuseum } from "@/components/gallery/use-museum-curation";
import { getUser } from "@/functions/get-user";
import { useTRPC } from "@/utils/trpc";

export const Route = createFileRoute("/museums")({
  component: RouteComponent,
  beforeLoad: async () => {
    const session = await getUser();
    return { session };
  },
  loader: async ({ context }) => {
    if (!context.session) {
      throw redirect({ to: "/login" });
    }
  },
});

function RouteComponent() {
  const trpc = useTRPC();
  const museums = useQuery(trpc.museum.myMuseums.queryOptions());
  const [editorOpen, setEditorOpen] = useState(false);
  const [search, setSearch] = useState("");
  const visible = (museums.data ?? []).filter((museum) =>
    museum.name.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <CosmosShell active="museums" search={search} onSearch={setSearch}>
      <div className="mx-auto w-full max-w-[1120px] pt-6">
        <div className="mb-6 flex items-end justify-between gap-4">
          <div>
            <p className="font-semibold text-[11px] text-muted-foreground uppercase tracking-[0.12em]">
              Multi-room museums
            </p>
            <h1 className="mt-1 font-semibold text-3xl tracking-tight">Museums</h1>
          </div>
          <Button size="lg" onClick={() => setEditorOpen(true)}>
            <Plus />
            New museum
          </Button>
        </div>

        <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
          {visible.map((museum) => (
            <MuseumCard key={museum.id} museum={museum} />
          ))}
          {museums.isSuccess && visible.length === 0 ? (
            <button
              type="button"
              onClick={() => setEditorOpen(true)}
              className="flex min-h-56 flex-col items-center justify-center gap-2 border border-border border-dashed bg-card/40 px-4 text-center text-muted-foreground text-xs outline-none transition-colors hover:border-ring hover:text-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50"
            >
              <Plus className="size-5" />
              <span>
                {search ? "No museums match — create a new one" : "Create your first museum"}
              </span>
            </button>
          ) : null}
        </div>
      </div>
      <MuseumEditorDialog open={editorOpen} onOpenChange={setEditorOpen} />
    </CosmosShell>
  );
}

function MuseumCard({ museum }: { museum: StudioMuseum }) {
  const roomCount = museum.rooms.length;
  const artworkCount = museum.rooms.reduce((total, room) => total + room.artworkIds.length, 0);
  return (
    <Link
      to="/museums/$museumId"
      params={{ museumId: museum.id }}
      className="group flex flex-col overflow-hidden bg-card ring-1 ring-foreground/10 transition-all hover:ring-foreground/25"
    >
      <div className="aspect-[1.5] overflow-hidden bg-muted">
        {museum.coverImageUrl ? (
          <img
            src={museum.coverImageUrl}
            alt=""
            className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
          />
        ) : (
          <div className="size-full bg-gradient-to-br from-muted to-background" />
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1 p-3">
        <h2 className="font-medium text-sm">{museum.name}</h2>
        <p className="line-clamp-2 text-muted-foreground text-xs">
          {museum.tagline || museum.description || "A multi-room museum"}
        </p>
        <div className="mt-auto flex items-center justify-between pt-3">
          <span className="text-muted-foreground text-xs">
            {roomCount} {roomCount === 1 ? "room" : "rooms"} · {artworkCount}{" "}
            {artworkCount === 1 ? "artwork" : "artworks"}
          </span>
          <Badge variant={museum.isPublished ? "success" : "outline"}>
            {museum.isPublished ? "Published" : "Draft"}
          </Badge>
        </div>
      </div>
    </Link>
  );
}
