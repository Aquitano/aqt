import { Button } from "@aqt-gallery/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@aqt-gallery/ui/components/dropdown-menu";
import { Skeleton } from "@aqt-gallery/ui/components/skeleton";
import { useClerk, useUser } from "@clerk/tanstack-react-start";
import { Link, useNavigate } from "@tanstack/react-router";

export default function UserMenu() {
  const navigate = useNavigate();
  const { isLoaded, isSignedIn, user } = useUser();
  const { signOut } = useClerk();

  if (!isLoaded) {
    return <Skeleton className="h-9 w-24" />;
  }

  if (!isSignedIn) {
    return (
      <Link to="/login">
        <Button variant="outline">Sign In</Button>
      </Link>
    );
  }

  const name = user.fullName ?? user.username ?? "Account";
  const email = user.primaryEmailAddress?.emailAddress;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" />}>{name}</DropdownMenuTrigger>
      <DropdownMenuContent className="bg-card">
        <DropdownMenuGroup>
          <DropdownMenuLabel>My Account</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {email ? <DropdownMenuItem>{email}</DropdownMenuItem> : null}
          <DropdownMenuItem
            variant="destructive"
            onClick={async () => {
              await signOut();
              navigate({ to: "/" });
            }}
          >
            Sign Out
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
