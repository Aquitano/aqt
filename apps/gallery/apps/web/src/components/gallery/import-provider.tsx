import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
	useState,
} from "react";

import { useHotkeys } from "@/hooks/use-hotkeys";
import { ImportDialog, type ImportTarget } from "./import-dialog";

type ImportContextValue = {
	/** Opens the import dialog (also bound to the global `i` shortcut). */
	openImport: () => void;
	/**
	 * Registers the page's import destination so imported artworks flow there.
	 * Pass `null` on unmount to fall back to a plain archive import.
	 */
	setImportTarget: (target: ImportTarget | null) => void;
};

const ImportContext = createContext<ImportContextValue | null>(null);

export function useImportController(): ImportContextValue {
	const context = useContext(ImportContext);
	if (!context) {
		throw new Error(
			"useImportController must be used within an ImportProvider",
		);
	}
	return context;
}

export function ImportProvider({ children }: { children: ReactNode }) {
	const [open, setOpen] = useState(false);
	const [target, setTarget] = useState<ImportTarget | null>(null);

	const openImport = useCallback(() => setOpen(true), []);
	const setImportTarget = useCallback(
		(next: ImportTarget | null) => setTarget(next),
		[],
	);

	useHotkeys([{ combo: "i", handler: () => setOpen(true) }]);

	const value = useMemo(
		() => ({ openImport, setImportTarget }),
		[openImport, setImportTarget],
	);

	return (
		<ImportContext.Provider value={value}>
			{children}
			<ImportDialog open={open} onOpenChange={setOpen} target={target} />
		</ImportContext.Provider>
	);
}
