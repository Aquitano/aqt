import { Table, TableCell, TableHead } from "@aqt/ui/components/table";
import { cn } from "cn";
import type { ComponentProps } from "react";

// Phones keep the identifying column and the figure that matters. Columns marked secondary hide
// there instead of pushing the table sideways. From sm up the container stops scrolling, so
// headers can stick below the page header.
export const DataTable = ({ className, ...props }: ComponentProps<typeof Table>) => (
  <div className="min-w-0 sm:*:data-[slot=table-container]:overflow-visible">
    <Table
      className={cn(
        "[&_a]:underline-offset-2 [&_a]:outline-none [&_a]:hover:underline [&_a]:hover:decoration-primary [&_a]:focus-visible:underline [&_tbody_tr]:hover:bg-muted/40",
        className,
      )}
      {...props}
    />
  </div>
);

interface ColumnProps {
  readonly numeric?: boolean | undefined;
  readonly secondary?: boolean | undefined;
}

export const Th = ({
  numeric,
  secondary,
  className,
  ...props
}: ComponentProps<typeof TableHead> & ColumnProps) => (
  <TableHead
    className={cn(
      "h-auto bg-card px-2 pt-2 pb-2 text-xs font-medium text-muted-foreground first:pl-0 last:pr-0 sm:sticky sm:top-12 sm:z-1",
      numeric === true && "text-right",
      secondary === true && "max-sm:hidden",
      className,
    )}
    {...props}
  />
);

export const Td = ({
  numeric,
  secondary,
  className,
  ...props
}: ComponentProps<typeof TableCell> & ColumnProps) => (
  <TableCell
    className={cn(
      "px-2 py-2 first:pl-0 last:pr-0",
      numeric === true && "text-right",
      secondary === true && "max-sm:hidden",
      className,
    )}
    {...props}
  />
);

export const PrimaryTd = ({ className, ...props }: ComponentProps<typeof TableCell>) => (
  <Td className={cn("w-[42%] max-w-0 truncate max-sm:w-full", className)} {...props} />
);
