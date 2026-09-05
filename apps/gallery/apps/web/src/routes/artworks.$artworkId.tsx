import { createFileRoute, redirect } from "@tanstack/react-router";

import { ArtworkDetailEditor } from "@/components/gallery/artwork-detail-editor";
import { CosmosShell } from "@/components/gallery/cosmos-shell";
import { getUser } from "@/functions/get-user";

export const Route = createFileRoute("/artworks/$artworkId")({
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
  const { artworkId } = Route.useParams();

  return (
    <CosmosShell active="archive">
      <ArtworkDetailEditor artworkId={artworkId} />
    </CosmosShell>
  );
}
