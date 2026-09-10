import { Badge } from "@aqt/gallery-ui/components/badge";
import { Button } from "@aqt/gallery-ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";

import { CosmosShell } from "@/components/gallery/cosmos-shell";
import {
  CollectionExhibition2D,
  type ExhibitionLayout,
} from "@/components/journal/collection-exhibition-2d";
import { exhibitionToContent, type GalleryContent } from "@/components/museum/types";
import { getUser } from "@/functions/get-user";
import { useTRPC } from "@/utils/trpc";

import "@/components/museum/museum.css";

const MuseumExperience = lazy(() => import("@/components/museum/museum-experience"));
type CollectionSearch = {
  view?: "2d" | "3d";
  layout?: ExhibitionLayout;
  artwork?: string;
};

export const Route = createFileRoute("/collection/$collectionId")({
  component: CollectionExhibitionPage,
  beforeLoad: async () => ({ session: await getUser() }),
  loader: async ({ context }) => {
    if (!context.session) throw redirect({ to: "/login" });
  },
  validateSearch: (search: Record<string, unknown>): CollectionSearch => ({
    view: search.view === "3d" ? "3d" : "2d",
    layout: search.layout === "list" ? "list" : "masonry",
    artwork:
      typeof search.artwork === "string" && search.artwork.length > 0 ? search.artwork : undefined,
  }),
});

function CollectionMessage({ title, body }: { title: string; body: string }) {
  return (
    <CosmosShell active="journal">
      <div className="mx-auto grid min-h-[70dvh] max-w-xl place-items-center text-center">
        <div>
          <h1 className="text-3xl font-semibold tracking-[-0.03em]">{title}</h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">{body}</p>
          <Button
            className="mt-6"
            variant="outline"
            nativeButton={false}
            render={<Link to="/journal" />}
          >
            Back to journal
          </Button>
        </div>
      </div>
    </CosmosShell>
  );
}

function CollectionExhibitionPage() {
  const { collectionId } = Route.useParams();
  const { view, layout = "masonry", artwork } = Route.useSearch();
  const navigate = Route.useNavigate();
  const trpc = useTRPC();
  const collectionQuery = useQuery(trpc.journal.collections.exhibit.queryOptions({ collectionId }));
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const content = useMemo<GalleryContent | null>(
    () => (collectionQuery.data ? exhibitionToContent(collectionQuery.data) : null),
    [collectionQuery.data],
  );
  if (collectionQuery.isPending)
    return (
      <CollectionMessage title="Opening collection" body="Preparing your private exhibition." />
    );
  if (collectionQuery.isError || !content)
    return (
      <CollectionMessage
        title="Collection unavailable"
        body="This private collection could not be opened."
      />
    );
  if (view === "3d") {
    if (!mounted)
      return (
        <CollectionMessage title="Opening collection" body="Preparing your private exhibition." />
      );
    return (
      <Suspense
        fallback={
          <CollectionMessage title="Opening collection" body="Preparing your private exhibition." />
        }
      >
        <Button
          className="fixed top-5 right-5 z-40 backdrop-blur"
          variant="secondary"
          size="sm"
          nativeButton={false}
          render={
            <Link
              to="/collection/$collectionId"
              params={{ collectionId }}
              search={{ view: "2d", layout }}
            />
          }
        >
          View in 2D
        </Button>
        <div className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center pt-4">
          <Badge variant="secondary" className="px-4 py-1.5 backdrop-blur">
            Private collection
          </Badge>
        </div>
        <MuseumExperience key={content.id} content={content} />
      </Suspense>
    );
  }
  const collection = collectionQuery.data;
  if (!collection)
    return (
      <CollectionMessage
        title="Collection unavailable"
        body="This private collection could not be opened."
      />
    );
  return (
    <CollectionExhibition2D
      collection={collection}
      layout={layout}
      selectedArtworkId={artwork}
      onSelectArtwork={(artworkId) => {
        void navigate({
          search: { view: "2d", layout, artwork: artworkId },
          replace: true,
        });
      }}
      onCloseArtwork={() => {
        void navigate({
          search: { view: "2d", layout, artwork: undefined },
          replace: true,
        });
      }}
    />
  );
}
