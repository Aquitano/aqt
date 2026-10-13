import type { TurnView } from "@aqt/turnstash-api";
import { Badge } from "@aqt/ui/components/badge";
import { TableBody, TableHeader, TableRow } from "@aqt/ui/components/table";

import { int, usd } from "../format";
import { BookmarkButton } from "./BookmarkButton";
import { DataTable, PrimaryTd, Td, Th } from "./DataTable";
import { SelectForExport, SelectionBar, useExportSelection } from "./ExportSelection";

export const TurnList = ({
  turns,
  conversationId,
}: {
  readonly turns: ReadonlyArray<TurnView>;
  readonly conversationId?: string;
}) => {
  const selection = useExportSelection();
  return (
    <>
      {conversationId !== undefined && (
        <SelectionBar
          conversationId={conversationId}
          kind="turns"
          selected={selection.selected}
          onClear={selection.clear}
        />
      )}
      <DataTable>
        <TableHeader>
          <TableRow>
            <Th numeric>#</Th>
            <Th>Request</Th>
            <Th>Task</Th>
            <Th>Model</Th>
            <Th>Tools</Th>
            <Th numeric>Edits</Th>
            <Th numeric>Retries</Th>
            <Th numeric>Cost</Th>
            {conversationId !== undefined && <Th>Save / export</Th>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {turns.map((turn) => (
            <TableRow key={turn.turnIndex}>
              <Td numeric>{turn.turnIndex + 1}</Td>
              <PrimaryTd>
                {turn.userExcerpt === "" ? (
                  <span className="text-xs text-muted-foreground">no user text</span>
                ) : (
                  turn.userExcerpt
                )}
              </PrimaryTd>
              <Td>
                <Badge variant="secondary">{turn.category}</Badge>
                {turn.skill !== null && (
                  <span className="text-xs text-muted-foreground"> {turn.skill}</span>
                )}
              </Td>
              <Td>{turn.primaryModelId ?? ""}</Td>
              <Td className="text-xs text-muted-foreground">{turn.tools.join(", ")}</Td>
              <Td numeric>{int(turn.edits)}</Td>
              <Td numeric>{int(turn.retries)}</Td>
              <Td numeric>{usd(turn.costUsd)}</Td>
              {conversationId !== undefined && (
                <Td>
                  {turn.messageKey !== null && (
                    <div className="flex flex-wrap items-center gap-2">
                      <SelectForExport
                        label={`Select turn ${turn.turnIndex + 1} for export`}
                        messageKey={turn.messageKey}
                        selection={selection}
                      />
                      <BookmarkButton
                        conversationId={conversationId}
                        target={{ kind: "turn", messageKey: turn.messageKey }}
                      />
                    </div>
                  )}
                </Td>
              )}
            </TableRow>
          ))}
        </TableBody>
      </DataTable>
    </>
  );
};
