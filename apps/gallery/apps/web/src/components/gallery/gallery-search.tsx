import { Kbd } from "@aqt/gallery-ui/components/kbd";
import { Search } from "lucide-react";
import { useRef } from "react";

import { useHotkeys } from "@/hooks/use-hotkeys";

export function GallerySearch({
  value,
  onChange,
  placeholder = "Search",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useHotkeys([
    { combo: "/", handler: () => inputRef.current?.focus() },
    {
      combo: "escape",
      handler: () => inputRef.current?.blur(),
      enableOnFormTags: true,
      preventDefault: false,
    },
  ]);

  return (
    <div className="relative w-full">
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-4 size-[18px] -translate-y-1/2 text-muted-foreground"
      />
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        type="search"
        aria-label="Search"
        className="h-11 w-full rounded-full border border-border bg-card pr-12 pl-11 text-[15px] transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring/60 focus-visible:bg-secondary [&::-webkit-search-cancel-button]:hidden"
      />
      <Kbd className="absolute top-1/2 right-3.5 -translate-y-1/2">/</Kbd>
    </div>
  );
}
