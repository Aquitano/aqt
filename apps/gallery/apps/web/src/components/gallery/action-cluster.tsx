import { Button } from "@aqt-gallery/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@aqt-gallery/ui/components/dropdown-menu";
import { Kbd } from "@aqt-gallery/ui/components/kbd";
import { useClerk, useUser } from "@clerk/tanstack-react-start";
import { Link, useNavigate } from "@tanstack/react-router";
import { Upload } from "lucide-react";

import { useImportController } from "./import-provider";

export function ActionCluster() {
  const navigate = useNavigate();
  const { openImport } = useImportController();
  const { isSignedIn, user } = useUser();
  const { signOut } = useClerk();
  const initials = (user?.firstName ?? user?.username)?.slice(0, 1).toUpperCase() ?? "A";

  return (
    <div className="flex items-center justify-end gap-2">
      {isSignedIn ? (
        <Button type="button" variant="secondary" size="lg" onClick={openImport}>
          <Upload />
          Import
          <Kbd className="ml-0.5 border-secondary-foreground/25 bg-secondary-foreground/10 text-secondary-foreground/80">
            I
          </Kbd>
        </Button>
      ) : (
        <Button size="lg" nativeButton={false} render={<Link to="/login">Sign in</Link>} />
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="Open user menu"
          className="inline-grid size-9 place-items-center rounded-full bg-secondary text-xs font-medium text-secondary-foreground ring-1 ring-foreground/10 transition-colors outline-none hover:bg-secondary/80 focus-visible:ring-2 focus-visible:ring-ring"
        >
          {initials}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          <DropdownMenuLabel>
            {user?.primaryEmailAddress?.emailAddress ?? "Gallery"}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => navigate({ to: "/dashboard" })}>
            Archive
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => navigate({ to: "/galleries" })}>
            Galleries
          </DropdownMenuItem>
          {isSignedIn ? (
            <DropdownMenuItem onClick={() => navigate({ to: "/connect" })}>
              Connect an agent
            </DropdownMenuItem>
          ) : null}
          {isSignedIn ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={async () => {
                  await signOut();
                  navigate({ to: "/" });
                }}
              >
                Sign out
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
