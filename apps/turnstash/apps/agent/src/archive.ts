import {
  type AllocationRow,
  type Analysis,
  ConversationCursor,
  type ConversationDetail,
  type ConversationPage,
  type ConversationSummary,
  DateBoundary,
  MessageCursor,
  type MessagePage,
  type ModelRow,
  NotFound,
  PageLimit,
  providerIds,
  providerLabels,
  type RequestSummary,
  SearchQuery,
  type SearchResult,
  type Stats,
  type StatsFilter,
  type TurnView,
  Unauthorized,
  Uuid,
} from "@aqt/turnstash-api";
import { hostEnvFromProcess, type MessagePart, Role, type ToolStatus } from "@aqt/turnstash-core";
import { Config, DateTime, Effect, Match, Option, Record, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { agentPaths, readConfig } from "./config.ts";
import { type ApiClient, apiClientFor } from "./push.ts";
import {
  bold,
  count,
  dim,
  formatNumber,
  formatTime,
  formatUsd,
  mark,
  oneLine,
  print,
  section,
  table,
} from "./ui.ts";

export class ArchiveError extends Schema.TaggedError<ArchiveError>()("ArchiveError", {
  message: Schema.String,
}) {}

const { configFile } = agentPaths(hostEnvFromProcess());

const tokenHint =
  "Create an API token with the read scope in Settings > Tokens, then set TURNSTASH_READ_TOKEN or pass --token.";

// The read API answers every refused bearer token with the same reason, so the hint covers each cause.
const refused = `The server refused this token. Reading needs an API token with the read scope; the machine token used by sync cannot read the archive. ${tokenHint}`;

const explainFailures = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchIf(Schema.is(Unauthorized), () =>
      Effect.fail(new ArchiveError({ message: refused })),
    ),
    Effect.catchIf(Schema.is(NotFound), (error) =>
      Effect.fail(new ArchiveError({ message: `The server has no ${error.entity} ${error.id}` })),
    ),
  );

// The query schemas use optional keys, so an unset flag must leave its key out instead of sending undefined.
const optionalKey = <const K extends string, A>(
  key: K,
  value: Option.Option<A>,
): { readonly [Key in K]?: A } =>
  Option.match(value, { onNone: () => ({}), onSome: (present) => Record.singleton(key, present) });

const connection = {
  server: Flag.String("server").pipe(
    Flag.withFallbackConfig(Config.String("TURNSTASH_SERVER")),
    Flag.optional,
    Flag.withDescription("Server URL (default: TURNSTASH_SERVER, then the enrolled server)"),
  ),
  token: Flag.Redacted("token").pipe(
    Flag.withFallbackConfig(Config.Redacted("TURNSTASH_READ_TOKEN")),
    Flag.optional,
    Flag.withDescription("API token with the read scope (default: TURNSTASH_READ_TOKEN)"),
  ),
  json: Flag.Boolean("json").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Print the server's JSON response"),
  ),
};

type Connection = Command.Command.Config.Infer<typeof connection>;

const provider = Flag.Literals("provider", providerIds).pipe(
  Flag.optional,
  Flag.withDescription("Only this provider"),
);
const project = Flag.String("project").pipe(
  Flag.optional,
  Flag.withDescription("Only this project key, as listed by turnstash stats"),
);
const range = {
  from: Flag.String("from").pipe(
    Flag.withSchema(DateBoundary),
    Flag.optional,
    Flag.withDescription("From this UTC date, or a UTC timestamp such as 2026-10-01T08:00:00Z"),
  ),
  to: Flag.String("to").pipe(
    Flag.withSchema(DateBoundary),
    Flag.optional,
    Flag.withDescription("Up to this UTC date (inclusive), or a UTC timestamp"),
  ),
};
const filters = {
  provider,
  machine: Flag.String("machine").pipe(
    Flag.optional,
    Flag.withDescription("Only this machine, by name or id"),
  ),
  project,
  ...range,
};

type Filters = Command.Command.Config.Infer<typeof filters>;

const limitOf = (description: string) =>
  Flag.Int("limit").pipe(
    Flag.withSchema(PageLimit),
    Flag.optional,
    Flag.withDescription(description),
  );
const limit = limitOf("Page size, at most 500");
const sessionId = Argument.String("id").pipe(
  Argument.withSchema(Uuid),
  Argument.withDescription("Session id from turnstash sessions list"),
);

const clientFor = Effect.fn("Archive.client")(function* (flags: Connection) {
  const serverUrl = yield* Option.match(flags.server, {
    onSome: Effect.succeed,
    onNone: () =>
      readConfig(configFile).pipe(
        Effect.map((config) => config.serverUrl),
        Effect.catchTag("NotEnrolled", () =>
          Effect.fail(
            new ArchiveError({
              message: "This machine is not enrolled. Pass --server or set TURNSTASH_SERVER.",
            }),
          ),
        ),
      ),
  });
  const url = URL.parse(serverUrl);
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) {
    return yield* new ArchiveError({
      message: `${serverUrl} is not a server URL such as https://turnstash.example.com`,
    });
  }
  const token = yield* Option.match(flags.token, {
    onSome: Effect.succeed,
    onNone: () => Effect.fail(new ArchiveError({ message: `No read token. ${tokenHint}` })),
  });
  return { client: yield* apiClientFor(serverUrl, token), origin: url.origin };
});

const machineIdOf = Effect.fn("Archive.machineIdOf")(function* (
  client: ApiClient,
  machine: string,
) {
  const machines = yield* client.read.listMachines();
  const wanted = machine.toLowerCase();
  const [found, ...others] = machines.filter(
    (candidate) => candidate.id === wanted || candidate.name.toLowerCase() === wanted,
  );
  if (found === undefined) {
    return yield* new ArchiveError({
      message: `No machine has the name or id ${machine}. Known machines: ${machines.map((known) => known.name).join(", ")}`,
    });
  }
  if (others.length > 0) {
    return yield* new ArchiveError({
      message: `Several machines are named ${machine}; pass one of their ids: ${[found, ...others].map((known) => known.id).join(", ")}`,
    });
  }
  return found.id;
});

const statsFilterOf = Effect.fn("Archive.statsFilter")(function* (
  client: ApiClient,
  flags: Filters,
) {
  const machineId = yield* Effect.transposeOption(
    Option.map(flags.machine, (machine) => machineIdOf(client, machine)),
  );
  return {
    ...optionalKey("provider", flags.provider),
    ...optionalKey("machineId", machineId),
    ...optionalKey("projectKey", flags.project),
    ...optionalKey("from", flags.from),
    ...optionalKey("to", flags.to),
    timeZone: DateTime.zoneMakeLocal().id,
  } satisfies StatsFilter;
});

const output = <A>(
  flags: Connection,
  value: A,
  describe: (value: A) => ReadonlyArray<string | null>,
) => print(flags.json ? [JSON.stringify(value, null, 2)] : describe(value));

const nextPage = (cursor: string | null, noun: string) =>
  cursor === null ? null : dim(`More ${noun}: repeat with --cursor '${cursor}'`);

const modelLabel = ({ modelId, route }: ModelRow) =>
  route === null ? modelId : `${modelId} ${dim(`via ${route}`)}`;

// Untitled sessions show a dimmed fallback, such as their project, as in the web UI.
const labelOf = (title: string | null, fallback: string, max: number) =>
  title === null ? dim(oneLine(fallback, max)) : oneLine(title, max);

const sessionRows = (sessions: ReadonlyArray<ConversationSummary>) =>
  table(
    [
      ["Started", "Provider", "Session", "Cost", "ID"].map((heading) => dim(heading)),
      ...sessions.map((session) => [
        formatTime(session.startedAt),
        providerLabels[session.provider],
        `${session.parentId === null ? "" : "↳ "}${labelOf(session.title, session.projectKey ?? session.conversationKey.slice(0, 12), 48)}`,
        formatUsd(session.costUsd),
        dim(session.id),
      ]),
    ],
    ["left", "left", "left", "right", "left"],
  );

const describeSessionPage = (page: ConversationPage) =>
  page.items.length === 0
    ? [`${mark.idle} No sessions match`]
    : [...sessionRows(page.items), nextPage(page.nextCursor, "sessions")];

const turnWork = (turn: TurnView) =>
  [
    turn.edits > 0 ? count(turn.edits, "edit") : null,
    turn.retries > 0 ? count(turn.retries, "retry", "retries") : null,
  ]
    .filter((work) => work !== null)
    .join(", ");

const describeSession = ({
  conversation,
  children,
  machines,
  byModel,
  redactions,
  commits,
  turns,
}: ConversationDetail) => [
  `${bold(oneLine(conversation.title ?? conversation.projectKey ?? conversation.conversationKey, 100))}  ${dim(conversation.id)}`,
  ...table([
    [
      dim("Provider"),
      `${providerLabels[conversation.provider]}  ${dim(conversation.conversationKey)}`,
    ],
    [dim("Project"), conversation.projectPath ?? conversation.projectKey ?? dim("none")],
    ...(conversation.gitBranch === null ? [] : [[dim("Branch"), conversation.gitBranch]]),
    [dim("Machines"), machines.map((machine) => machine.name).join(", ") || dim("none")],
    [dim("Active"), `${formatTime(conversation.startedAt)} to ${formatTime(conversation.endedAt)}`],
    [
      dim("Usage"),
      `${count(conversation.messageCount, "message")}, ${count(conversation.requestCount, "request")}, ${formatUsd(conversation.costUsd)}`,
    ],
    ...(conversation.parentId === null ? [] : [[dim("Parent"), conversation.parentId]]),
    ...(redactions === 0 ? [] : [[dim("Redacted"), count(redactions, "secret")]]),
  ]),
  ...section(
    "Models",
    table(
      byModel.map((model) => [
        modelLabel(model),
        count(model.requests, "request"),
        formatUsd(model.costUsd),
      ]),
      ["left", "right", "right"],
    ),
  ),
  ...section(
    "Turns",
    table(
      turns.map((turn) => [
        dim(`#${turn.turnIndex}`),
        turn.category,
        formatUsd(turn.costUsd),
        turnWork(turn),
        oneLine(turn.userExcerpt, 60),
      ]),
      ["right", "left", "right", "left", "left"],
    ),
  ),
  ...(children.length === 0 ? [] : section("Subagents", sessionRows(children))),
  ...(commits.length === 0
    ? []
    : section(
        "Commits",
        table(
          commits.map((commit) => [
            commit.sha.slice(0, 7),
            oneLine(commit.subject, 60),
            dim(commit.repo),
          ]),
        ),
      )),
];

const statusMarks: { readonly [Status in ToolStatus]: string } = {
  ok: mark.done,
  error: mark.fail,
  unknown: mark.idle,
};

const partLines = (
  part: MessagePart,
  statusOf: ReadonlyMap<string, ToolStatus>,
): ReadonlyArray<string> =>
  Match.value(part).pipe(
    Match.discriminatorsExhaustive("type")({
      text: ({ text }) => text.split("\n").map((line) => `  ${line}`),
      thinking: () => [],
      tool_call: ({ toolKey, name }) => [
        `  ${statusMarks[statusOf.get(toolKey) ?? "unknown"]} ${name}`,
      ],
      tool_result: () => [],
      image: () => [dim("  [image]")],
      opaque: () => [],
    }),
  );

const requestLabel = (requests: ReadonlyArray<RequestSummary>) =>
  requests.length === 0
    ? ""
    : dim(
        `  ${[...new Set(requests.map((request) => request.modelId))].join(", ")} ${formatUsd(
          requests.reduce((total, request) => total + (request.costUsd ?? 0), 0),
        )}`,
      );

const describeMessages = (page: MessagePage) => {
  const statusOf = new Map(page.toolExecutions.map((tool) => [tool.toolKey, tool.status]));
  return [
    ...page.items.flatMap((message) => [
      `${bold(`#${message.seq} ${message.role}`)}  ${dim(formatTime(message.createdAt))}${requestLabel(message.requests)}`,
      ...message.parts.flatMap((part) => partLines(part, statusOf)),
      "",
    ]),
    nextPage(page.nextCursor, "messages"),
  ];
};

const highlight = (snippet: string) =>
  snippet.replace(/<b>(.*?)<\/b>/g, (_, term: string) => bold(term));

const describeSearch = ({ hits }: SearchResult) =>
  hits.length === 0
    ? [`${mark.idle} No messages match`]
    : hits.flatMap((hit) => [
        `${formatTime(hit.createdAt)}  ${providerLabels[hit.provider]}  ${labelOf(hit.title, hit.projectKey ?? hit.conversationId.slice(0, 12), 60)}  ${dim(`${hit.conversationId} #${hit.seq} ${hit.role}`)}`,
        `  ${highlight(oneLine(hit.snippet, 240))}`,
      ]);

const topRows = 10;

const ranked = <A>(
  rows: ReadonlyArray<A>,
  describe: (row: A) => ReadonlyArray<string>,
  align: ReadonlyArray<"left" | "right">,
) => [
  ...table(rows.slice(0, topRows).map(describe), align),
  rows.length > topRows ? dim(`and ${formatNumber(rows.length - topRows)} more in --json`) : null,
];

const windowOf = ({ from, to }: StatsFilter) =>
  from === undefined && to === undefined
    ? "all time"
    : `${from ?? "first session"} to ${to ?? "now"}`;

const describeStats = (
  filter: StatsFilter,
  { overall, byProvider, byModel, byProject, byMachine, topConversations }: Stats,
) => [
  `${bold(formatUsd(overall.costUsd))} over ${count(overall.conversations, "session")}, ${count(overall.requests, "request")} and ${count(overall.messages, "message")}  ${dim(windowOf(filter))}`,
  dim(
    `${formatNumber(overall.inputTokens)} input, ${formatNumber(overall.outputTokens)} output, ${formatNumber(overall.cacheReadTokens)} cache read and ${formatNumber(overall.cacheWriteTokens)} cache write tokens`,
  ),
  overall.unpricedRequests > 0
    ? `${mark.warn} ${count(overall.unpricedRequests, "request")} could not be priced`
    : null,
  ...section(
    "Providers",
    ranked(
      byProvider,
      (row) => [
        providerLabels[row.provider],
        count(row.conversations, "session"),
        count(row.requests, "request"),
        formatUsd(row.costUsd),
      ],
      ["left", "right", "right", "right"],
    ),
  ),
  ...section(
    "Models",
    ranked(
      byModel,
      (row) => [modelLabel(row), count(row.requests, "request"), formatUsd(row.costUsd)],
      ["left", "right", "right"],
    ),
  ),
  ...section(
    "Projects",
    ranked(
      byProject,
      (row) => [row.projectKey, count(row.conversations, "session"), formatUsd(row.costUsd)],
      ["left", "right", "right"],
    ),
  ),
  ...section(
    "Machines",
    ranked(
      byMachine.filter((row) => row.conversations > 0).toSorted((a, b) => b.costUsd - a.costUsd),
      (row) => [row.name, count(row.conversations, "session"), formatUsd(row.costUsd), dim(row.id)],
      ["left", "right", "right", "left"],
    ),
  ),
  ...section("Most expensive sessions", sessionRows(topConversations)),
];

const allocation = (title: string, rows: ReadonlyArray<AllocationRow>) =>
  rows.length === 0
    ? []
    : section(
        title,
        ranked(
          rows,
          (row) => [row.name, count(row.turns, "turn"), `~${formatUsd(row.estimatedCostUsd)}`],
          ["left", "right", "right"],
        ),
      );

const describeAnalysis = (analysis: Analysis) => [
  ...section(
    "Task categories",
    table(
      analysis.byCategory.map((row) => [
        row.category,
        count(row.turns, "turn"),
        count(row.editTurns, "editing turn"),
        count(row.retries, "retry", "retries"),
        formatUsd(row.costUsd),
      ]),
      ["left", "right", "right", "right", "right"],
    ),
  ),
  ...section(
    "Models",
    ranked(
      analysis.byModel,
      (row) => [
        row.modelId,
        count(row.turns, "turn"),
        count(row.retries, "retry", "retries"),
        row.cacheHitRate === null
          ? dim("no cache data")
          : `${(row.cacheHitRate * 100).toFixed(1)}% cached`,
        formatUsd(row.costUsd),
      ],
      ["left", "right", "right", "right", "right"],
    ),
  ),
  ...allocation("Tools", analysis.byTool),
  ...allocation("Shell commands", analysis.byCommand),
  ...allocation("Skills", analysis.bySkill),
  ...allocation("MCP servers", analysis.byMcpServer),
  "",
  dim(
    `${formatUsd(analysis.attributedCostUsd)} attributed to turns, ${formatUsd(analysis.unattributedCostUsd)} not attributed`,
  ),
];

const list = Command.make(
  "list",
  {
    ...connection,
    ...filters,
    query: Flag.String("query").pipe(
      Flag.optional,
      Flag.withDescription("Only sessions whose title, project path or key contains this text"),
    ),
    cursor: Flag.String("cursor").pipe(
      Flag.withSchema(ConversationCursor),
      Flag.optional,
      Flag.withDescription("Continue after the previous page"),
    ),
    limit,
  },
  Effect.fn("cli.sessions.list")(function* (flags) {
    const { client } = yield* clientFor(flags);
    const page = yield* client.read.listConversations({
      query: {
        ...(yield* statsFilterOf(client, flags)),
        ...optionalKey("q", flags.query),
        ...optionalKey("cursor", flags.cursor),
        ...optionalKey("limit", flags.limit),
      },
    });
    yield* output(flags, page, describeSessionPage);
  }, explainFailures),
).pipe(
  Command.withDescription(
    "List archived sessions from every machine, newest start first; subagent sessions are included and marked ↳",
  ),
);

const show = Command.make(
  "show",
  { ...connection, id: sessionId },
  Effect.fn("cli.sessions.show")(function* (flags) {
    const { client } = yield* clientFor(flags);
    const detail = yield* client.read.getConversation({ params: { id: flags.id } });
    yield* output(flags, detail, describeSession);
  }, explainFailures),
).pipe(Command.withDescription("Show a session's models, turns, subagents and linked commits"));

const messages = Command.make(
  "messages",
  {
    ...connection,
    id: sessionId,
    cursor: Flag.String("cursor").pipe(
      Flag.withSchema(MessageCursor),
      Flag.optional,
      Flag.withDescription("Continue after the previous page"),
    ),
    limit,
  },
  Effect.fn("cli.sessions.messages")(function* (flags) {
    const { client } = yield* clientFor(flags);
    const page = yield* client.read.getMessages({
      params: { id: flags.id },
      query: { ...optionalKey("cursor", flags.cursor), ...optionalKey("limit", flags.limit) },
    });
    yield* output(flags, page, describeMessages);
  }, explainFailures),
).pipe(
  Command.withDescription(
    "Page through a session's messages; --json includes every part and tool execution",
  ),
);

const exportSession = Command.make(
  "export",
  {
    ...connection,
    id: sessionId,
    tools: Flag.Boolean("tools").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Include tool calls and their output"),
    ),
  },
  Effect.fn("cli.sessions.export")(function* (flags) {
    const { client, origin } = yield* clientFor(flags);
    const exported = yield* client.read.exportMarkdown({
      params: { id: flags.id },
      payload: {
        selection: { kind: "conversation" },
        includeTools: flags.tools,
        sourceOrigin: origin,
      },
    });
    yield* output(flags, exported, ({ markdown }) => [markdown]);
  }, explainFailures),
).pipe(Command.withDescription("Print a session's transcript as Markdown"));

const sessions = Command.make("sessions").pipe(
  Command.withDescription("Read archived sessions from the server"),
  Command.withSubcommands([list, show, messages, exportSession]),
);

const search = Command.make(
  "search",
  {
    ...connection,
    provider,
    project,
    ...range,
    role: Flag.Literals("role", Role.literals).pipe(
      Flag.optional,
      Flag.withDescription("Only messages with this role"),
    ),
    limit: limitOf("Number of hits, at most 500"),
    query: Argument.String("query").pipe(
      Argument.withSchema(SearchQuery.fields.q),
      Argument.withDescription("Words to look for, without wildcards"),
    ),
  },
  Effect.fn("cli.search")(function* (flags) {
    const { client } = yield* clientFor(flags);
    const result = yield* client.read.search({
      query: {
        q: flags.query,
        ...optionalKey("provider", flags.provider),
        ...optionalKey("projectKey", flags.project),
        ...optionalKey("role", flags.role),
        ...optionalKey("from", flags.from),
        ...optionalKey("to", flags.to),
        ...optionalKey("limit", flags.limit),
      },
    });
    yield* output(flags, result, describeSearch);
  }, explainFailures),
).pipe(Command.withDescription("Search message text across every archived session"));

const stats = Command.make(
  "stats",
  { ...connection, ...filters },
  Effect.fn("cli.stats")(function* (flags) {
    const { client } = yield* clientFor(flags);
    const filter = yield* statsFilterOf(client, flags);
    const result = yield* client.read.stats({ query: filter });
    yield* output(flags, result, (response) => describeStats(filter, response));
  }, explainFailures),
).pipe(Command.withDescription("Show cost and usage by provider, model, project and machine"));

const analysis = Command.make(
  "analysis",
  { ...connection, ...filters },
  Effect.fn("cli.analysis")(function* (flags) {
    const { client } = yield* clientFor(flags);
    const result = yield* client.read.analysis({ query: yield* statsFilterOf(client, flags) });
    yield* output(flags, result, describeAnalysis);
  }, explainFailures),
).pipe(
  Command.withDescription(
    "Show task categories, retries and where cost goes by tool, command, skill and MCP server",
  ),
);

export const archiveCommands = [sessions, search, stats, analysis] as const;
