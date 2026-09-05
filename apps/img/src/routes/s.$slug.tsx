import { useState } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { Book } from "@/book/Book";
import { sharedAlbumQuery } from "@/lib/queries";

export const Route = createFileRoute("/s/$slug")({
  loader: async ({ context, params }) => {
    const shared = await context.queryClient.ensureQueryData(sharedAlbumQuery(params.slug));
    if (!shared) throw notFound();
  },
  notFoundComponent: () => (
    <main className="flex min-h-dvh items-center justify-center px-6">
      <p className="text-muted-foreground">This share link is not available.</p>
    </main>
  ),
  component: SharedAlbum,
});

function SharedAlbum() {
  const { slug } = Route.useParams();
  const { data } = useSuspenseQuery(sharedAlbumQuery(slug));
  const [current, setCurrent] = useState(-1);

  if (!data) return null;

  return (
    <main className="flex h-dvh flex-col">
      <header className="px-6 py-4">
        <h1 className="text-lg font-medium">{data.album.title}</h1>
      </header>
      <div className="flex min-h-0 flex-1 px-6 pb-10">
        <Book
          title={data.album.title}
          cover={data.album.cover}
          spreads={data.spreads}
          current={current}
          onCurrentChange={setCurrent}
        />
      </div>
    </main>
  );
}
