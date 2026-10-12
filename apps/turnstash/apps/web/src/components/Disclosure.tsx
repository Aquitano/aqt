import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@aqt/ui/components/collapsible";
import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";

export const Disclosure = ({
  summary,
  defaultOpen = false,
  children,
}: {
  readonly summary: ReactNode;
  readonly defaultOpen?: boolean;
  readonly children: ReactNode;
}) => (
  <Collapsible defaultOpen={defaultOpen} className="rounded-lg border bg-background px-2.5 py-2">
    <CollapsibleTrigger className="group/disclosure flex w-full cursor-pointer items-center gap-1.5 text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
      <ChevronRightIcon className="size-3 transition-transform group-data-panel-open/disclosure:rotate-90" />
      {summary}
    </CollapsibleTrigger>
    <CollapsibleContent className="mt-2">{children}</CollapsibleContent>
  </Collapsible>
);
