import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";

import { TooltipProvider } from "@/components/ui/tooltip";
import { AlbumHeader } from "@/editor/AlbumHeader";
import { attachAutosave } from "@/editor/autosave";
import { Editor } from "@/editor/Editor";
import { EditorStoreProvider, createEditorStore } from "@/editor/store";
import { requireSignedIn } from "@/lib/guard";
import { albumQuery } from "@/lib/queries";
import { useMediaQuery } from "@/lib/use-media-query";
import type { Album, Spread } from "@/server/db/schema";

export const Route = createFileRoute("/albums/$albumId")({
  beforeLoad: requireSignedIn,
  loader: async ({ context, params }) => {
    const album = await context.queryClient.ensureQueryData(albumQuery(params.albumId));
    if (!album) throw notFound();
  },
  notFoundComponent: () => (
    <main className="flex min-h-dvh items-center justify-center px-6">
      <p className="text-muted-foreground">This album is not available.</p>
    </main>
  ),
  component: AlbumRoute,
});

function AlbumRoute() {
  const { albumId } = Route.useParams();
  const { data } = useSuspenseQuery(albumQuery(albumId));
  if (!data) return null;
  return <AlbumPage album={data.album} spreads={data.spreads} />;
}

function AlbumPage({ album, spreads }: { album: Album; spreads: Spread[] }) {
  const phone = useMediaQuery("(max-width: 767px)");

  // One store per open album; recreated when the album identity changes.
  const store = useMemo(() => createEditorStore(album, spreads), [album.id]);

  useEffect(() => attachAutosave(store), [store]);

  return (
    <EditorStoreProvider value={store}>
      <TooltipProvider>
        <main className="relative flex h-dvh flex-col">
          <AlbumHeader canEdit={!phone} />
          <Editor canEdit={!phone} />
        </main>
      </TooltipProvider>
    </EditorStoreProvider>
  );
}
