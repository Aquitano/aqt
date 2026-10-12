import { BadRequest, NotFound, TimelineChanged, TimelinePage } from "@aqt/turnstash-api";
import { eq, sql } from "drizzle-orm";
import { Effect, Schema } from "effect";

import { Db } from "./db/client.ts";
import { conversations } from "./db/schema.ts";

const TimelineRead = Schema.Struct({ page: TimelinePage, cursorFound: Schema.Boolean });

export const getTimeline = Effect.fn("Conversations.timeline")(function* (
  id: string,
  cursor?: string,
  limit = 200,
  expectedVersion?: string,
) {
  const db = yield* Db;
  const [conversation] = yield* db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.id, id))
    .limit(1);
  if (conversation === undefined) return yield* new NotFound({ entity: "conversation", id });

  const anchor =
    cursor === undefined
      ? sql`0`
      : sql`(select position from ordered where kind || ':' || source_key = ${cursor})`;
  const rows = yield* db.execute<{ payload: unknown }>(
    sql`
    with requests as (
      select r.request_key as source_key, 'request'::text as kind,
        r.requested_at as event_at, m.message_key, r.id as request_id, r.model_id,
        lag(r.model_id) over (order by r.requested_at, r.request_key collate "C") as previous_model_id,
        null::text as tool_name, null::text as tool_status,
        v.cost_usd, coalesce(v.unpriced_reason, 'pending') as unpriced_reason
      from model_requests r
      left join messages m on m.conversation_id = r.conversation_id and m.message_key = r.message_key
      left join valuations v on v.request_id = r.id and v.active
      where r.conversation_id = ${id}
    ), events as (
      select * from requests
      union all
      select t.tool_key, 'tool', coalesce(t.started_at, t.ended_at), m.message_key,
        null::uuid, null::text, null::text, t.name, t.status::text, null::numeric, null::text
      from tool_executions t
      left join messages m on m.conversation_id = t.conversation_id and m.message_key = t.message_key
      where t.conversation_id = ${id}
    ), ordered as (
      select *, row_number() over chronology as position,
        coalesce(sum(cost_usd) over chronology, 0) as cumulative_cost,
        count(*) filter (where kind = 'request' and cost_usd is null) over chronology as cumulative_unpriced
      from events
      window chronology as (order by event_at nulls last, kind collate "C", source_key collate "C" rows unbounded preceding)
    ), anchor as (
      select ${anchor} as position
    ), page as (
      select position, jsonb_build_object(
        'eventKey', kind || ':' || source_key,
        'kind', kind,
        'timestamp', to_char(event_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'messageKey', message_key, 'requestId', request_id, 'modelId', model_id,
        'previousModelId', case when previous_model_id is distinct from model_id then previous_model_id else null end,
        'toolName', tool_name, 'toolStatus', tool_status,
        'costUsd', cost_usd::double precision,
        'unpricedReason', case when kind = 'request' and cost_usd is null then unpriced_reason else null end,
        'cumulativeCostUsd', cumulative_cost::double precision,
        'cumulativeUnpricedRequests', cumulative_unpriced
      ) as item
      from ordered where position > (select position from anchor) and position <= (select position + ${limit} from anchor)
    )
    select jsonb_build_object(
      'cursorFound', (select position is not null from anchor),
      'page', jsonb_build_object(
      'version', md5(coalesce(jsonb_agg(to_jsonb(events) order by event_at nulls last, kind collate "C", source_key collate "C"), '[]'::jsonb)::text),
      'items', coalesce((select jsonb_agg(item order by position) from page), '[]'::jsonb),
      'nextCursor', case when count(*) > (select position + ${limit} from anchor) then (select item->>'eventKey' from page order by position desc limit 1) else null end,
      'totalEvents', count(*),
      'pricedCostUsd', coalesce(sum(cost_usd), 0)::double precision,
      'unpricedRequests', count(*) filter (where kind = 'request' and cost_usd is null)
    )) as payload from events
  `,
    "objects",
  );
  const result = yield* Schema.decodeUnknownEffect(TimelineRead)(rows[0]?.payload).pipe(
    Effect.orDie,
  );
  if (expectedVersion !== undefined && expectedVersion !== result.page.version)
    return yield* new TimelineChanged({
      expectedVersion,
      actualVersion: result.page.version,
      message:
        "The timeline changed while loading events. Reload it to use consistent costs and event order.",
    });
  if (!result.cursorFound)
    return yield* new BadRequest({
      message: "Timeline cursor no longer exists. Reload the timeline.",
    });
  return result.page;
});
