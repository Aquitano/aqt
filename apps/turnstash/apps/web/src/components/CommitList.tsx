import type { CommitView } from "@aqt/turnstash-api";
import { Badge } from "@cloudflare/kumo";
import { Link } from "@tanstack/react-router";

import { dateTime, usd } from "../format";

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
  <table className="data-table">
    <thead>
      <tr>
        <th>Commit</th>
        <th>Subject</th>
        <th>Branch</th>
        <th>Authored</th>
        {showConversation && <th>Conversation</th>}
        <th className="num" title="Spent in the conversation since its previous commit">
          Cost
        </th>
      </tr>
    </thead>
    <tbody>
      {commits.map((commit) => {
        const url = commitUrl(commit);
        const short = commit.sha.slice(0, 10);
        return (
          <tr key={`${commit.repo}:${commit.sha}`}>
            <td className="mono nowrap">
              {url === null ? (
                short
              ) : (
                <a href={url} target="_blank" rel="noreferrer">
                  {short}
                </a>
              )}
            </td>
            <td className="primary" title={commit.subject}>
              {commit.subject}
            </td>
            <td>
              <Badge variant={commit.onDefaultBranch ? "success" : "neutral"}>{commit.ref}</Badge>
            </td>
            <td className="nowrap">{dateTime(commit.authoredAt)}</td>
            {showConversation && (
              <td>
                <Link to="/conversations/$id" params={{ id: commit.conversationId }}>
                  open
                </Link>
              </td>
            )}
            <td className="num">{usd(commit.costUsd)}</td>
          </tr>
        );
      })}
    </tbody>
  </table>
);
