import { createFileRoute, Link, redirect } from "@tanstack/react-router";

import { getUser } from "@/functions/get-user";

export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    const session = await getUser();
    if (session) {
      throw redirect({ to: "/explore", search: { view: "artworks" } });
    }
    return { session };
  },
  component: HomeComponent,
});

function HomeComponent() {
  return (
    <main className="grid min-h-svh place-items-center bg-background px-6 text-foreground">
      <section className="flex max-w-md flex-col items-center gap-5 text-center">
        <span className="gallery-logo" data-size="lg" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
        </span>
        <h1 className="text-4xl font-semibold tracking-[-0.03em]">AQT Gallery</h1>
        <p className="text-[15px] leading-relaxed text-muted-foreground">
          Archive the art you meet, hang it in galleries and museums you can walk through, and keep
          a private journal for every work.
        </p>
        <div className="mt-2 flex items-center gap-3">
          <Link className="gallery-primary-button" to="/login">
            Enter archive
          </Link>
          <Link
            className="inline-flex h-9 items-center rounded-full border border-border px-4 text-sm font-medium transition-colors hover:bg-muted"
            to="/museum"
          >
            Visit the museum
          </Link>
        </div>
      </section>
    </main>
  );
}
