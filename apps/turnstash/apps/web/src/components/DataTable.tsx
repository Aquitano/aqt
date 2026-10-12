import { Table, TableCell, TableHead } from "@aqt/ui/components/table";
import { cn } from "cn";
import type { ComponentProps } from "react";

// Wide tables scroll sideways on phones; from sm up the container stops scrolling, so headers can
// stick below the page header.
export const DataTable = ({ className, ...props }: ComponentProps<typeof Table>) => (
  <div className="min-w-0 sm:*:data-[slot=table-container]:overflow-visible">
    <Table
      className={cn(
        "text-[13px] max-sm:min-w-160 [&_a]:underline-offset-2 [&_a]:outline-none [&_a]:hover:underline [&_a]:hover:decoration-flame [&_a]:focus-visible:underline",
        className,
      )}
      {...props}
    />
  </div>
);

export const Th = ({
  numeric = false,
  className,
  ...props
}: ComponentProps<typeof TableHead> & { readonly numeric?: boolean }) => (
  <TableHead
    className={cn(
      "h-auto bg-background px-2 pt-2 pb-1.5 text-xs font-medium text-muted-foreground first:pl-0 last:pr-0 sm:sticky sm:top-12 sm:z-1",
      numeric && "text-right",
      className,
    )}
    {...props}
  />
);

export const Td = ({
  numeric = false,
  className,
  ...props
}: ComponentProps<typeof TableCell> & { readonly numeric?: boolean }) => (
  <TableCell
    className={cn("px-2 py-1.5 first:pl-0 last:pr-0", numeric && "text-right", className)}
    {...props}
  />
);

export const PrimaryTd = ({ className, ...props }: ComponentProps<typeof TableCell>) => (
  <Td className={cn("w-[42%] max-w-0 truncate max-sm:w-[55%]", className)} {...props} />
);
