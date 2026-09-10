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
	const initials =
		(user?.firstName ?? user?.username)?.slice(0, 1).toUpperCase() ?? "A";

	return (
		<div className="flex items-center justify-end gap-2">
			{isSignedIn ? (
				<Button type="button" variant="secondary" onClick={openImport}>
					<Upload />
					Import
					<Kbd className="ml-0.5 border-transparent bg-foreground/10 text-secondary-foreground/80">
						I
					</Kbd>
				</Button>
			) : (
				<Button
					nativeButton={false}
					render={<Link to="/login">Sign in</Link>}
				/>
			)}
			<DropdownMenu>
				<DropdownMenuTrigger
					aria-label="Open user menu"
					className="inline-grid size-9 place-items-center rounded-full bg-secondary font-medium text-secondary-foreground text-sm outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60"
				>
					{initials}
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="min-w-44">
					<DropdownMenuGroup>
						<DropdownMenuLabel>
							{user?.primaryEmailAddress?.emailAddress ?? "Gallery"}
						</DropdownMenuLabel>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							onClick={() =>
								navigate({ to: "/explore", search: { view: "artworks" } })
							}
						>
							Artworks
						</DropdownMenuItem>
						<DropdownMenuItem
							onClick={() =>
								navigate({ to: "/explore", search: { view: "spaces" } })
							}
						>
							Galleries and museums
						</DropdownMenuItem>
						<DropdownMenuItem onClick={() => navigate({ to: "/museum" })}>
							Public museum
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
					</DropdownMenuGroup>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
