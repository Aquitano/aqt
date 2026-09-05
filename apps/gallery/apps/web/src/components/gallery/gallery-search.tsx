import { Input } from "@aqt-gallery/ui/components/input";
import { Kbd } from "@aqt-gallery/ui/components/kbd";
import { Search } from "lucide-react";
import { useRef } from "react";

import { useHotkeys } from "@/hooks/use-hotkeys";

export function GallerySearch({
  value,
  onChange,
  placeholder = "Search archive...",
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
        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        ref={inputRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        type="search"
        aria-label="Search gallery"
        className="h-9 px-8"
      />
      <Kbd className="absolute top-1/2 right-2.5 -translate-y-1/2">/</Kbd>
    </div>
  );
}
