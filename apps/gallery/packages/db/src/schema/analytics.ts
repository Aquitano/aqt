import {
	date,
	index,
	integer,
	pgTable,
	text,
	uniqueIndex,
} from "drizzle-orm/pg-core";

export const statEntityKinds = ["exhibition"] as const;
export type StatEntityKind = (typeof statEntityKinds)[number];

export const statMetrics = [
	"page_view",
	"session_entered",
	"inspect_open",
	"tour_completed",
] as const;
export type StatMetric = (typeof statMetrics)[number];

/** Anonymous, aggregate-only visit counters for published exhibitions.
 * One row is a running count for a single
 * (entity, metric, artwork, day) tuple — there are no per-visitor rows, no
 * cookies and no IP storage. Beacon events upsert into these rows.
 *
 * `artworkId` is only meaningful for the `inspect_open` metric (which work was
 * opened); every other metric stores the empty string. It is NOT nullable on
 * purpose: a null column would make every row conflict-distinct in Postgres and
 * break the upsert against the unique index below. */
export const museumStat = pgTable(
	"museum_stat",
	{
		entityKind: text("entity_kind").$type<StatEntityKind>().notNull(),
		entityId: text("entity_id").notNull(),
		metric: text("metric").$type<StatMetric>().notNull(),
		artworkId: text("artwork_id").default("").notNull(),
		day: date("day").notNull(),
		count: integer("count").default(0).notNull(),
	},
	(table) => [
		uniqueIndex("museum_stat_unique_idx").on(
			table.entityKind,
			table.entityId,
			table.metric,
			table.artworkId,
			table.day,
		),
		index("museum_stat_entity_idx").on(table.entityKind, table.entityId),
	],
);
