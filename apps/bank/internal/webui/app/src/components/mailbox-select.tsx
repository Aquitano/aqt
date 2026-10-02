import { useQuery } from "@tanstack/react-query";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getMailboxes } from "@/lib/api";

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
  return (
    <div className="flex flex-col gap-1">
      <Select
        value={value ? String(value) : "all"}
        onValueChange={(selected) => onChange(selected === "all" ? undefined : Number(selected))}
        disabled={query.isPending || query.isError}
      >
        <SelectTrigger size="sm" aria-label="Historically observed folder">
          <SelectValue placeholder="All observed folders" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="all">All observed folders</SelectItem>
            {query.data?.map((folder) => (
              <SelectItem key={folder.id} value={String(folder.id)}>
                {folder.path} ({folder.kind}, {folder.n})
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
