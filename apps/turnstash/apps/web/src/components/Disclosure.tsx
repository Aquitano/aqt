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
  <Collapsible defaultOpen={defaultOpen} className="min-w-0">
    <CollapsibleTrigger className="group/disclosure flex max-w-full cursor-pointer items-center gap-1.5 rounded-md py-0.5 text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
      <ChevronRightIcon className="size-3 shrink-0 transition-transform group-data-panel-open/disclosure:rotate-90" />
      {summary}
    </CollapsibleTrigger>
    <CollapsibleContent className="mt-1.5 ml-1.5 border-l pl-3.5">{children}</CollapsibleContent>
  </Collapsible>
);
