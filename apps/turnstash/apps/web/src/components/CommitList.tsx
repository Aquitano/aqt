import type { CommitView } from "@aqt/turnstash-api";
import { Badge } from "@aqt/ui/components/badge";
import { TableBody, TableHeader, TableRow } from "@aqt/ui/components/table";
import { Link } from "@tanstack/react-router";

import { dateTime, usd } from "../format";
import { DataTable, PrimaryTd, Td, Th } from "./DataTable";

const commitUrl = (commit: CommitView): string | null => {
  if (commit.remote === null) return null;
  const [host, ...segments] = commit.remote.split("/");
  if (host === "github.com" || host === "gitlab.com")
    return `https://${commit.remote}/commit/${commit.sha}`;
  if (host === "bitbucket.org")
    return `https://bitbucket.org/${segments.join("/")}/commits/${commit.sha}`;
  return null;
};

export const CommitList = ({
  commits,
  showConversation = false,
}: {
  readonly commits: ReadonlyArray<CommitView>;
  readonly showConversation?: boolean;
}) => (
  <DataTable>
    <TableHeader>
      <TableRow>
        <Th>Commit</Th>
        <Th>Subject</Th>
        <Th>Branch</Th>
        <Th>Authored</Th>
        {showConversation && <Th>Conversation</Th>}
        <Th numeric title="Spent in the conversation since its previous commit">
          Cost
        </Th>
      </TableRow>
    </TableHeader>
    <TableBody>
      {commits.map((commit) => {
        const url = commitUrl(commit);
        const short = commit.sha.slice(0, 10);
        return (
          <TableRow key={`${commit.repo}:${commit.sha}`}>
            <Td className="font-mono text-xs">
              {url === null ? (
                short
              ) : (
                <a href={url} target="_blank" rel="noreferrer">
                  {short}
                </a>
              )}
            </Td>
            <PrimaryTd title={commit.subject}>{commit.subject}</PrimaryTd>
            <Td>
              <Badge variant={commit.onDefaultBranch ? "success" : "secondary"}>{commit.ref}</Badge>
            </Td>
            <Td>{dateTime(commit.authoredAt)}</Td>
            {showConversation && (
              <Td>
                <Link to="/conversations/$id" params={{ id: commit.conversationId }}>
                  open
                </Link>
              </Td>
            )}
            <Td numeric>{usd(commit.costUsd)}</Td>
          </TableRow>
        );
      })}
    </TableBody>
  </DataTable>
);
