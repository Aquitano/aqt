import type { ConversationDetail } from "@aqt/turnstash-api";
import { Alert, AlertDescription, AlertTitle } from "@aqt/ui/components/alert";
import { Badge } from "@aqt/ui/components/badge";
import { Button } from "@aqt/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { cn } from "cn";
import { CircleAlertIcon, GitBranchIcon, ShieldCheckIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { isUnauthorized } from "../api";
import { Async, RequestFailure } from "../components/Async";
import { BookmarkButton } from "../components/BookmarkButton";
import { CommitList } from "../components/CommitList";
import { conversationLabel } from "../components/ConversationsTable";
import { MarkdownExportButton } from "../components/MarkdownExportButton";
import { MessageThread, Requests } from "../components/MessageThread";
import { BackLink, Page, PageHead } from "../components/Page";
import { ProviderBadge } from "../components/ProviderBadge";
import { RequestInspector } from "../components/RequestInspector";
import { Section, surface } from "../components/Section";
import { routeLabel } from "../components/Tables";
import { TurnStrip } from "../components/TurnStrip";
import { dateTime, duration, int, usd } from "../format";
import { conversationQuery } from "../queries";

const row = "flex flex-wrap items-center gap-2";
const textLink = "underline underline-offset-2 hover:decoration-primary";

const Fact = ({ label, children }: { readonly label: string; readonly children: ReactNode }) => (
  <div className="flex min-w-0 flex-col gap-1">
    <dt className="text-xs text-muted-foreground">{label}</dt>
    <dd className="text-lg leading-tight font-semibold tracking-tight">{children}</dd>
  </div>
);

const Summary = ({
  detail,
  onInspect,
}: {
  readonly detail: ConversationDetail;
  readonly onInspect: (requestId: string) => void;
}) => {
  const { conversation } = detail;
  const label = conversationLabel(conversation);
  return (
    <>
      <PageHead
        back={<BackLink to="/conversations">Conversations</BackLink>}
        title={<span title={label}>{label}</span>}
        actions={
          <>
            <BookmarkButton conversationId={conversation.id} target={{ kind: "conversation" }} />
            <MarkdownExportButton
              conversationId={conversation.id}
              selection={{ kind: "conversation" }}
            />
          </>
        }
        meta={
          <>
            <ProviderBadge provider={conversation.provider} />
            {conversation.projectKey !== null && (
              <Badge
                variant="outline"
                className="block max-w-full truncate"
                title={conversation.projectPath ?? conversation.projectKey}
                render={<Link to="/projects/$key" params={{ key: conversation.projectKey }} />}
              >
                {conversation.projectKey}
              </Badge>
            )}
            {conversation.gitBranch !== null && (
              <Badge variant="secondary" className="block max-w-full truncate">
                <GitBranchIcon data-icon="inline-start" className="inline" />
                {conversation.gitBranch}
              </Badge>
            )}
            {detail.redactions > 0 && (
              <Badge variant="warning">
                <ShieldCheckIcon data-icon="inline-start" />
                {int(detail.redactions)} {detail.redactions === 1 ? "secret" : "secrets"} redacted
              </Badge>
            )}
          </>
        }
      />

      <section className={cn(surface, "flex flex-col gap-4 p-4 sm:p-5")}>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
          <Fact label="API-equivalent cost">{usd(conversation.costUsd)}</Fact>
          <Fact label="Messages">{int(conversation.messageCount)}</Fact>
          <Fact label="Requests">{int(conversation.requestCount)}</Fact>
          <Fact label="Duration">{duration(conversation.startedAt, conversation.endedAt)}</Fact>
        </dl>
        <dl className="grid grid-cols-1 gap-x-5 gap-y-2.5 border-t pt-4 sm:grid-cols-[minmax(140px,auto)_1fr] [&>dd]:min-w-0 [&>dd]:wrap-anywhere max-sm:[&>dd]:mb-1 [&>dt]:text-xs [&>dt]:text-muted-foreground sm:[&>dt]:pt-0.5">
          <dt>Started</dt>
          <dd>{dateTime(conversation.startedAt)}</dd>
          <dt>Machines</dt>
          <dd className={row}>
            {detail.machines.length === 0 && <span className="text-muted-foreground">Unknown</span>}
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
          {detail.requestsWithoutMessage.length > 0 && (
            <>
              <dt>Requests without a message</dt>
              <dd className="text-xs text-muted-foreground">
                <Requests requests={detail.requestsWithoutMessage} onInspect={onInspect} />
                {detail.requestsWithoutMessageTotal > detail.requestsWithoutMessage.length && (
                  <p>
                    First {int(detail.requestsWithoutMessage.length)} of{" "}
                    {int(detail.requestsWithoutMessageTotal)}
                  </p>
                )}
              </dd>
            </>
          )}
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
                    className="block max-w-full truncate"
                    render={<Link to="/conversations/$id" params={{ id: child.id }} />}
                  >
                    {conversationLabel(child)}
                  </Badge>
                ))}
              </dd>
            </>
          )}
        </dl>
      </section>
    </>
  );
};

export const ConversationPage = () => {
  const { id } = useParams({ from: "/conversations/$id" });
  const search = useSearch({ from: "/conversations/$id" });
  const detail = useQuery(conversationQuery(id));
  const [inspecting, setInspecting] = useState<string | null>(null);

  if (detail.isError && isUnauthorized(detail.error))
    return (
      <Page>
        <RequestFailure error={detail.error} />
      </Page>
    );

  return (
    <Page>
      <Async query={detail}>
        {(data) => <Summary key={data.conversation.id} detail={data} onInspect={setInspecting} />}
      </Async>

      {detail.data !== undefined && detail.data.turns.length > 1 && (
        <Section
          title="Cost by turn"
          note={`${int(detail.data.turns.length)} turns`}
          description="Select a bar to jump to that turn in the transcript."
        >
          <TurnStrip turns={detail.data.turns} conversationId={id} />
        </Section>
      )}
      {detail.data !== undefined && detail.data.commits.length > 0 && (
        <Section title="Commits" note={`${detail.data.commits.length} linked by time window`}>
          <CommitList commits={detail.data.commits} />
        </Section>
      )}
      <Section
        title="Transcript"
        description="Turn categories come from rules. Select a request line to inspect its tokens and pricing. Message actions bookmark a message or select it for export."
        action={
          (search.message !== undefined || search.invalidMessage === true) && (
            <Button
              size="sm"
              variant="outline"
              nativeButton={false}
              render={<Link to="/conversations/$id" params={{ id }} search={{}} />}
            >
              Open from the start
            </Button>
          )
        }
      >
        {search.invalidMessage === true ? (
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertTitle>Invalid message link</AlertTitle>
            <AlertDescription>The message key is empty or malformed.</AlertDescription>
          </Alert>
        ) : (
          <MessageThread
            key={id}
            conversationId={id}
            turns={detail.data?.turns ?? []}
            messageKey={search.message}
            query={search.q}
            layoutReady={!detail.isPending}
            onInspect={setInspecting}
          />
        )}
      </Section>

      <RequestInspector requestId={inspecting} onClose={() => setInspecting(null)} />
    </Page>
  );
};
