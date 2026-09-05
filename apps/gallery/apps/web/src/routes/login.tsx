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
    <div className="mx-auto mt-10 flex w-full max-w-md flex-col items-center gap-4 p-6">
      {showSignIn ? (
        <SignIn routing="hash" forceRedirectUrl="/dashboard" />
      ) : (
        <SignUp routing="hash" forceRedirectUrl="/dashboard" />
      )}
      <button
        type="button"
        className="text-sm text-indigo-400 hover:text-indigo-300"
        onClick={() => setShowSignIn((v) => !v)}
      >
        {showSignIn ? "Need an account? Sign Up" : "Already have an account? Sign In"}
      </button>
    </div>
  );
}
