import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@aqt-gallery/ui/components/dropdown-menu";
import { Link, useNavigate } from "@tanstack/react-router";
import { Bolt, Menu } from "lucide-react";

import { authClient } from "@/lib/auth-client";

export function ActionCluster({ onCreate }: { onCreate: () => void }) {
	const navigate = useNavigate();
	const { data: session } = authClient.useSession();
	const initials = session?.user.name?.slice(0, 1).toUpperCase() ?? "A";

	return (
		<div className="gallery-action-cluster">
			<button
				aria-label="Quick actions"
				className="gallery-icon-button"
				type="button"
			>
				<Bolt size={17} />
			</button>
			{session ? (
				<button
					className="gallery-create-button"
					type="button"
					onClick={onCreate}
				>
					Create
				</button>
			) : (
				<Link className="gallery-create-button" to="/login">
					Sign in
				</Link>
			)}
			<div aria-hidden="true" className="gallery-mini-thumb" />
			<DropdownMenu>
				<DropdownMenuTrigger
					className="gallery-avatar"
					aria-label="Open user menu"
				>
					{initials}
				</DropdownMenuTrigger>
				<DropdownMenuContent
					align="end"
					className="border-white/10 bg-[#1f1f1f] text-white"
				>
					<DropdownMenuLabel>
						{session?.user.email ?? "Gallery"}
					</DropdownMenuLabel>
					<DropdownMenuSeparator />
					<DropdownMenuItem onClick={() => navigate({ to: "/dashboard" })}>
						Archive
					</DropdownMenuItem>
					{session ? (
						<DropdownMenuItem
							onClick={() => {
								authClient.signOut({
									fetchOptions: {
										onSuccess: () => {
											navigate({ to: "/" });
										},
									},
								});
							}}
						>
							Sign out
						</DropdownMenuItem>
					) : null}
				</DropdownMenuContent>
			</DropdownMenu>
			<button
				aria-label="Open menu"
				className="gallery-menu-button"
				type="button"
			>
				<Menu size={18} />
			</button>
		</div>
	);
}
