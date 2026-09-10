import { SignIn, SignUp } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

export const Route = createFileRoute("/login")({
  component: RouteComponent,
});

function RouteComponent() {
  const [showSignIn, setShowSignIn] = useState(true);

  // `routing="hash"` lets Clerk drive its multi-step flow off the URL hash, so
  // both cards live on this single /login route. Only one is mounted at a
  // time, so they never contend for the hash.
  return (
    <div className="mx-auto flex min-h-svh w-full max-w-md flex-col items-center justify-center gap-5 p-6">
      {showSignIn ? (
        <SignIn routing="hash" forceRedirectUrl="/explore" />
      ) : (
        <SignUp routing="hash" forceRedirectUrl="/explore" />
      )}
      <button
        type="button"
        className="text-sm text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => setShowSignIn((v) => !v)}
      >
        {showSignIn ? "Need an account? Sign Up" : "Already have an account? Sign In"}
      </button>
    </div>
  );
}
