import type { TurnView } from "@aqt/turnstash-api";
import { Badge } from "@cloudflare/kumo";

import { int, usd } from "../format";
import { BookmarkButton } from "./BookmarkButton";
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
      <table className="data-table">
        <thead>
          <tr>
            <th className="num">#</th>
            <th>Request</th>
            <th>Task</th>
            <th>Model</th>
            <th>Tools</th>
            <th className="num">Edits</th>
            <th className="num">Retries</th>
            <th className="num">Cost</th>
            {conversationId !== undefined && <th>Save / export</th>}
          </tr>
        </thead>
        <tbody>
          {turns.map((turn) => (
            <tr key={turn.turnIndex}>
              <td className="num">{turn.turnIndex + 1}</td>
              <td className="primary">
                {turn.userExcerpt === "" ? (
                  <span className="muted">no user text</span>
                ) : (
                  turn.userExcerpt
                )}
              </td>
              <td>
                <Badge variant="neutral">{turn.category}</Badge>
                {turn.skill !== null && <span className="muted"> {turn.skill}</span>}
              </td>
              <td>{turn.primaryModelId ?? ""}</td>
              <td className="muted">{turn.tools.join(", ")}</td>
              <td className="num">{int(turn.edits)}</td>
              <td className="num">{int(turn.retries)}</td>
              <td className="num">{usd(turn.costUsd)}</td>
              {conversationId !== undefined && (
                <td>
                  {turn.messageKey !== null && (
                    <div className="row">
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
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
};
