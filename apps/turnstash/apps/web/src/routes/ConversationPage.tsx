import type { ConversationDetail } from "@aqt/turnstash-api";
import { Badge, Banner } from "@cloudflare/kumo";
import { ShieldCheckIcon } from "@phosphor-icons/react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { useState } from "react";

import { Async } from "../components/Async";
import { BookmarkButton } from "../components/BookmarkButton";
import { Card } from "../components/Card";
import { CommitList } from "../components/CommitList";
import { conversationLabel } from "../components/ConversationsTable";
import { MarkdownExportButton } from "../components/MarkdownExportButton";
import { MessageThread } from "../components/MessageThread";
import { ProviderBadge } from "../components/ProviderBadge";
import { RequestInspector } from "../components/RequestInspector";
import { SessionTimeline } from "../components/SessionTimeline";
import { routeLabel } from "../components/Tables";
import { TurnList } from "../components/TurnList";
import { dateTime, duration, int, usd } from "../format";
import { conversationQuery, timelinePagesQuery } from "../queries";

const Summary = ({ detail }: { readonly detail: ConversationDetail }) => {
  const { conversation } = detail;
  const label = conversationLabel(conversation);
  return (
    <div className="page-top">
      <div className="page-head">
        <h1 className="page-title" title={label}>
          {label}
        </h1>
        <span className="page-sub">
          {int(conversation.messageCount)} messages · {int(conversation.requestCount)} requests
        </span>
      </div>
      <div className="row">
        <BookmarkButton conversationId={conversation.id} target={{ kind: "conversation" }} />
        <MarkdownExportButton
          conversationId={conversation.id}
          selection={{ kind: "conversation" }}
        />
        <ProviderBadge provider={conversation.provider} />
        {conversation.projectKey !== null && (
          <Link to="/projects/$key" params={{ key: conversation.projectKey }}>
            <Badge variant="outline" className="badge-clip">
              {conversation.projectKey}
            </Badge>
          </Link>
        )}
        {conversation.gitBranch !== null && (
          <Badge variant="neutral" className="badge-clip">
            {conversation.gitBranch}
          </Badge>
        )}
        <Badge variant="orange">{usd(conversation.costUsd)}</Badge>
        {detail.redactions > 0 && (
          <Badge variant="warning" icon={<ShieldCheckIcon />}>
            {int(detail.redactions)} {detail.redactions === 1 ? "secret" : "secrets"} redacted
          </Badge>
        )}
      </div>

      <dl className="kv">
        <dt>Started</dt>
        <dd>{dateTime(conversation.startedAt)}</dd>
        <dt>Duration</dt>
        <dd>{duration(conversation.startedAt, conversation.endedAt)}</dd>
        <dt>Machines</dt>
        <dd className="row">
          {detail.machines.map((machine) => (
            <Link key={machine.id} to="/machines/$id" params={{ id: machine.id }}>
              <Badge variant="neutral">{machine.name}</Badge>
            </Link>
          ))}
        </dd>
        <dt>Models</dt>
        <dd className="row">
          {detail.byModel.map((model) => (
            <Badge key={`${model.modelId}:${model.route ?? ""}`} variant="neutral">
              {model.modelId}
              {model.route !== null && ` · ${routeLabel(model.route)}`} · {usd(model.costUsd)}
            </Badge>
          ))}
        </dd>
        {conversation.parentId !== null && (
          <>
            <dt>Continued from</dt>
            <dd>
              <Link to="/conversations/$id" params={{ id: conversation.parentId }}>
                parent conversation
              </Link>
            </dd>
          </>
        )}
        {detail.children.length > 0 && (
          <>
            <dt>Continued in</dt>
            <dd className="row">
              {detail.children.map((child) => (
                <Link key={child.id} to="/conversations/$id" params={{ id: child.id }}>
                  <Badge variant="outline">{conversationLabel(child)}</Badge>
                </Link>
              ))}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
};

export const ConversationPage = () => {
  const { id } = useParams({ from: "/conversations/$id" });
  const search = useSearch({ from: "/conversations/$id" });
  const detail = useQuery(conversationQuery(id));
  const timeline = useInfiniteQuery(timelinePagesQuery(id));
  const [inspecting, setInspecting] = useState<string | null>(null);

  return (
    <main className="main">
      <Async query={detail}>{(data) => <Summary key={data.conversation.id} detail={data} />}</Async>

      {detail.data !== undefined && detail.data.commits.length > 0 && (
        <Card title="Commits" note={`${detail.data.commits.length} linked by time window`}>
          <CommitList commits={detail.data.commits} />
        </Card>
      )}
      {detail.data !== undefined && detail.data.turns.length > 0 && (
        <Card title="Turns" note={`${detail.data.turns.length} turns, categories are rule-based`}>
          <TurnList key={id} turns={detail.data.turns} conversationId={id} />
        </Card>
      )}
      <Card title="Session timeline">
        <SessionTimeline key={id} conversationId={id} onInspect={setInspecting} />
      </Card>
      <Card title="Transcript">
        {search.invalidMessage === true ? (
          <Banner
            variant="error"
            title="Invalid message link"
            description="The message key is empty or malformed."
          />
        ) : (
          <MessageThread
            key={`${id}:${search.message ?? ""}:${search.q ?? ""}`}
            conversationId={id}
            messageKey={search.message}
            query={search.q}
            layoutReady={!detail.isPending && !timeline.isPending}
            onInspect={setInspecting}
          />
        )}
        {(search.message !== undefined || search.invalidMessage === true) && (
          <div className="thread-foot">
            <Link to="/conversations/$id" params={{ id }} search={{}}>
              Open transcript from the start
            </Link>
          </div>
        )}
      </Card>

      <RequestInspector requestId={inspecting} onClose={() => setInspecting(null)} />
    </main>
  );
};
