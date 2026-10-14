// drizzle-orm 1.0.0-rc.5 declarations still import SqlError from its pre-4.0 Effect path, which turns every
// Effect driver error channel into `any`. Delete once drizzle publishes drizzle-team/drizzle-orm#6429.
declare module "effect/unstable/sql/SqlError" {
  export * from "effect/sql/SqlError";
}
