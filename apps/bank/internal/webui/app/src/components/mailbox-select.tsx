import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@aqt/ui/components/select";
import { useQuery } from "@tanstack/react-query";

import { getMailboxes } from "@/lib/api";

const ALL_FOLDERS = "all";

export function MailboxSelect({
  source,
  value,
  onChange,
}: {
  source?: string;
  value?: number;
  onChange: (id: number | undefined) => void;
}) {
  const query = useQuery({
    queryKey: ["mailboxes", source],
    queryFn: () => getMailboxes(source ?? ""),
    enabled: Boolean(source),
  });
  if (!source) return null;
  const items = [
    { value: ALL_FOLDERS, label: "All observed folders" },
    ...(query.data ?? []).map((folder) => ({
      value: String(folder.id),
      label: `${folder.path} (${folder.kind}, ${folder.n})`,
    })),
  ];
  return (
    <div className="flex flex-col gap-1">
      <Select
        items={items}
        value={value ? String(value) : ALL_FOLDERS}
        onValueChange={(selected) =>
          onChange(selected === null || selected === ALL_FOLDERS ? undefined : Number(selected))
        }
        disabled={query.isPending || query.isError}
      >
        <SelectTrigger size="sm" aria-label="Historically observed folder">
          <SelectValue placeholder="All observed folders" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        {query.isError
          ? query.error.message
          : "Folders are historical observations, not live mailbox state."}
      </p>
    </div>
  );
}
