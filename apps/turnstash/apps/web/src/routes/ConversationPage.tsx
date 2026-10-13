import type { ConversationDetail } from "@aqt/turnstash-api";
import { Alert, AlertDescription, AlertTitle } from "@aqt/ui/components/alert";
import { Badge } from "@aqt/ui/components/badge";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { CircleAlertIcon, ShieldCheckIcon } from "lucide-react";
import { useState } from "react";

import { Async } from "../components/Async";
import { BookmarkButton } from "../components/BookmarkButton";
import { CommitList } from "../components/CommitList";
import { conversationLabel } from "../components/ConversationsTable";
import { MarkdownExportButton } from "../components/MarkdownExportButton";
import { MessageThread } from "../components/MessageThread";
import { Page, PageHead } from "../components/Page";
import { ProviderBadge } from "../components/ProviderBadge";
import { RequestInspector } from "../components/RequestInspector";
import { Section } from "../components/Section";
import { SessionTimeline } from "../components/SessionTimeline";
import { routeLabel } from "../components/Tables";
import { TurnList } from "../components/TurnList";
import { dateTime, duration, int, usd } from "../format";
import { conversationQuery, timelinePagesQuery } from "../queries";

const row = "flex flex-wrap items-center gap-2";
const textLink = "underline underline-offset-2 hover:decoration-flame";

const Summary = ({ detail }: { readonly detail: ConversationDetail }) => {
  const { conversation } = detail;
  const label = conversationLabel(conversation);
  return (
    <div className="flex flex-col gap-3.5">
      <PageHead
        title={<span title={label}>{label}</span>}
        note={`${int(conversation.messageCount)} messages · ${int(conversation.requestCount)} requests`}
      />
      {/* Project keys and branch names can be wider than a phone; the badge text gets cut, not the page. */}
      <div className={`${row} *:min-w-0`}>
        <BookmarkButton conversationId={conversation.id} target={{ kind: "conversation" }} />
        <MarkdownExportButton
          conversationId={conversation.id}
          selection={{ kind: "conversation" }}
        />
        <ProviderBadge provider={conversation.provider} />
        {conversation.projectKey !== null && (
          <Badge
            variant="outline"
            className="block max-w-full truncate"
            render={<Link to="/projects/$key" params={{ key: conversation.projectKey }} />}
          >
            {conversation.projectKey}
          </Badge>
        )}
        {conversation.gitBranch !== null && (
          <Badge variant="secondary" className="block max-w-full truncate">
            {conversation.gitBranch}
          </Badge>
        )}
        <Badge variant="outline">
          <span className="size-1.5 rounded-full bg-flame" />
          {usd(conversation.costUsd)}
        </Badge>
        {detail.redactions > 0 && (
          <Badge variant="warning">
            <ShieldCheckIcon data-icon="inline-start" />
            {int(detail.redactions)} {detail.redactions === 1 ? "secret" : "secrets"} redacted
          </Badge>
        )}
      </div>

      <dl className="grid grid-cols-[minmax(120px,auto)_1fr] gap-x-5 gap-y-1.5 text-[13px] [&>dd]:wrap-anywhere [&>dt]:text-muted-foreground">
        <dt>Started</dt>
        <dd>{dateTime(conversation.startedAt)}</dd>
        <dt>Duration</dt>
        <dd>{duration(conversation.startedAt, conversation.endedAt)}</dd>
        <dt>Machines</dt>
        <dd className={row}>
          {detail.machines.map((machine) => (
            <Badge
              key={machine.id}
              variant="secondary"
              render={<Link to="/machines/$id" params={{ id: machine.id }} />}
            >
              {machine.name}
            </Badge>
          ))}
        </dd>
        <dt>Models</dt>
        <dd className={row}>
          {detail.byModel.map((model) => (
            <Badge key={`${model.modelId}:${model.route ?? ""}`} variant="secondary">
              {model.modelId}
              {model.route !== null && ` · ${routeLabel(model.route)}`} · {usd(model.costUsd)}
            </Badge>
          ))}
        </dd>
        {conversation.parentId !== null && (
          <>
            <dt>Continued from</dt>
            <dd>
              <Link
                to="/conversations/$id"
                params={{ id: conversation.parentId }}
                className={textLink}
              >
                parent conversation
              </Link>
            </dd>
          </>
        )}
        {detail.children.length > 0 && (
          <>
            <dt>Continued in</dt>
            <dd className={row}>
              {detail.children.map((child) => (
                <Badge
                  key={child.id}
                  variant="outline"
                  render={<Link to="/conversations/$id" params={{ id: child.id }} />}
                >
                  {conversationLabel(child)}
                </Badge>
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
    <Page>
      <Async query={detail}>{(data) => <Summary key={data.conversation.id} detail={data} />}</Async>

      {detail.data !== undefined && detail.data.commits.length > 0 && (
        <Section title="Commits" note={`${detail.data.commits.length} linked by time window`}>
          <CommitList commits={detail.data.commits} />
        </Section>
      )}
      {detail.data !== undefined && detail.data.turns.length > 0 && (
        <Section
          title="Turns"
          note={`${detail.data.turns.length} turns, categories are rule-based`}
        >
          <TurnList key={id} turns={detail.data.turns} conversationId={id} />
        </Section>
      )}
      <Section title="Session timeline">
        <SessionTimeline key={id} conversationId={id} onInspect={setInspecting} />
      </Section>
      <Section title="Transcript">
        {search.invalidMessage === true ? (
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertTitle>Invalid message link</AlertTitle>
            <AlertDescription>The message key is empty or malformed.</AlertDescription>
          </Alert>
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
          <div className="pt-3">
            <Link to="/conversations/$id" params={{ id }} search={{}} className={textLink}>
              Open transcript from the start
            </Link>
          </div>
        )}
      </Section>

      <RequestInspector requestId={inspecting} onClose={() => setInspecting(null)} />
    </Page>
  );
};
