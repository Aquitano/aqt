import { SignIn, useAuth } from "@clerk/tanstack-react-start";
import { Navigate, createFileRoute } from "@tanstack/react-router";

import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/")({ component: Landing });

function Landing() {
  const { isLoaded, isSignedIn } = useAuth();

  if (isLoaded && isSignedIn) return <Navigate to="/albums" replace />;

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-10 px-6">
      <div className="max-w-md space-y-3 text-center">
        <h1 className="text-4xl font-semibold tracking-tight">Album</h1>
        <p className="text-balance text-muted-foreground">
          Photo albums that feel like physical ones. Lay out your pictures by hand and flip through
          the spreads.
        </p>
      </div>

      {isLoaded ? <SignIn routing="hash" /> : <Skeleton className="h-96 w-80" />}
    </main>
  );
}
