import { Badge } from "@aqt-gallery/ui/components/badge";
import { Button } from "@aqt-gallery/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";

import { CosmosShell } from "@/components/gallery/cosmos-shell";
import { GalleryEditorDialog } from "@/components/gallery/gallery-editor-dialog";
import type { GalleryGroup } from "@/components/gallery/use-gallery-curation";
import { getUser } from "@/functions/get-user";
import { useTRPC } from "@/utils/trpc";

export const Route = createFileRoute("/galleries")({
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
  const groups = useQuery(trpc.museum.myGroups.queryOptions());
  const [editorOpen, setEditorOpen] = useState(false);
  const [search, setSearch] = useState("");
  const visible = (groups.data ?? []).filter((group) =>
    group.name.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <CosmosShell active="galleries" search={search} onSearch={setSearch}>
      <div className="mx-auto w-full max-w-[1120px] pt-6">
        <div className="mb-6 flex items-end justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
              Curated galleries
            </p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">Galleries</h1>
          </div>
          <Button size="lg" onClick={() => setEditorOpen(true)}>
            <Plus />
            New gallery
          </Button>
        </div>

        <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
          {visible.map((group) => (
            <GalleryCard key={group.id} group={group} />
          ))}
          {groups.isSuccess && visible.length === 0 ? (
            <button
              type="button"
              onClick={() => setEditorOpen(true)}
              className="flex min-h-56 flex-col items-center justify-center gap-2 border border-dashed border-border bg-card/40 px-4 text-center text-xs text-muted-foreground transition-colors outline-none hover:border-ring hover:text-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50"
            >
              <Plus className="size-5" />
              <span>
                {search ? "No galleries match — create a new one" : "Create your first gallery"}
              </span>
            </button>
          ) : null}
        </div>
      </div>
      <GalleryEditorDialog open={editorOpen} onOpenChange={setEditorOpen} />
    </CosmosShell>
  );
}

function GalleryCard({ group }: { group: GalleryGroup }) {
  return (
    <Link
      to="/galleries/$galleryId"
      params={{ galleryId: group.id }}
      className="group flex flex-col overflow-hidden bg-card ring-1 ring-foreground/10 transition-all hover:ring-foreground/25"
    >
      <div className="aspect-[1.5] overflow-hidden bg-muted">
        {group.coverImageUrl ? (
          <img
            src={group.coverImageUrl}
            alt=""
            className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
          />
        ) : (
          <div className="size-full bg-gradient-to-br from-muted to-background" />
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1 p-3">
        <h2 className="text-sm font-medium">{group.name}</h2>
        <p className="line-clamp-2 text-xs text-muted-foreground">
          {group.tagline || group.description || "A curated gallery"}
        </p>
        <div className="mt-auto flex items-center justify-between pt-3">
          <span className="text-xs text-muted-foreground">
            {group.artworkIds.length} {group.artworkIds.length === 1 ? "artwork" : "artworks"}
          </span>
          <Badge variant={group.isPublished ? "success" : "outline"}>
            {group.isPublished ? "Published" : "Draft"}
          </Badge>
        </div>
      </div>
    </Link>
  );
}
