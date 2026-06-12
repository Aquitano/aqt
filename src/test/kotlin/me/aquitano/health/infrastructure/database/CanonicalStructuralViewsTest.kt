package me.aquitano.health.infrastructure.database

import me.aquitano.health.infrastructure.config.DatabaseConfig
import me.aquitano.health.test.PostgresTestDatabase
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Semantics of the structural canonical views (V15): per partition the top-ranked provider
 * wins via provider_ranks; DISTINCT ON families keep one row, while the window-function
 * families (sleep sessions/nights) keep ALL rows of the winning provider so naps survive.
 * Activity/steps rank google_health first; sleep and sleep_summary rank withings first.
 */
class CanonicalStructuralViewsTest {
    @Test
    fun activitySummaryRankWinnerPerDate() {
        val fixture = Fixture()
        fixture.insertActivitySummary(id = 1, sourceInstanceId = WITHINGS, date = "2026-04-19")
        fixture.insertActivitySummary(id = 2, sourceInstanceId = GOOGLE, date = "2026-04-19")
        fixture.insertActivitySummary(id = 3, sourceInstanceId = WITHINGS, date = "2026-04-20")

        assertEquals(listOf(2, 3), fixture.canonicalIds("canonical_activity_summaries", "date"))
    }

    @Test
    fun stepDailySummaryPrefersRankThenSampleCountThenSteps() {
        val fixture = Fixture()
        // google (rank 0) beats withings despite fewer samples/steps
        fixture.insertStepDailySummary(id = 1, sourceInstanceId = WITHINGS, date = "2026-04-19", steps = 9000, sampleCount = 90)
        fixture.insertStepDailySummary(id = 2, sourceInstanceId = GOOGLE, date = "2026-04-19", steps = 100, sampleCount = 1)
        // rank tie between two google instances: higher sample_count wins
        fixture.insertStepDailySummary(id = 3, sourceInstanceId = GOOGLE, date = "2026-04-20", steps = 2000, sampleCount = 5)
        fixture.insertStepDailySummary(id = 4, sourceInstanceId = GOOGLE_2, date = "2026-04-20", steps = 1000, sampleCount = 50)
        // rank and sample_count tie: higher steps wins
        fixture.insertStepDailySummary(id = 5, sourceInstanceId = GOOGLE, date = "2026-04-21", steps = 1000, sampleCount = 10)
        fixture.insertStepDailySummary(id = 6, sourceInstanceId = GOOGLE_2, date = "2026-04-21", steps = 2000, sampleCount = 10)

        assertEquals(listOf(2, 4, 6), fixture.canonicalIds("canonical_step_daily_summaries", "date"))
    }

    @Test
    fun sleepSummaryRankWinnerPerUtcStartDate() {
        val fixture = Fixture()
        // sleep_summary family: withings (rank 0) beats google_health
        fixture.insertSleepSummary(id = 1, sourceInstanceId = GOOGLE, startAt = "2026-04-19T22:00:00Z", endAt = "2026-04-20T06:00:00Z")
        fixture.insertSleepSummary(id = 2, sourceInstanceId = WITHINGS, startAt = "2026-04-19T22:30:00Z", endAt = "2026-04-20T06:30:00Z")
        // next UTC start date is its own partition
        fixture.insertSleepSummary(id = 3, sourceInstanceId = GOOGLE, startAt = "2026-04-20T22:00:00Z", endAt = "2026-04-21T06:00:00Z")

        assertEquals(listOf(2, 3), fixture.canonicalIds("canonical_sleep_summaries", "date"))
    }

    @Test
    fun sleepSessionsWinningProviderKeepsAllItsSessions() {
        val fixture = Fixture()
        // same UTC start date: winning withings keeps both the night and the nap, google is dropped
        fixture.insertSleepSession(id = 1, sourceInstanceId = WITHINGS, startAt = "2026-04-19T01:00:00Z", endAt = "2026-04-19T07:00:00Z")
        fixture.insertSleepSession(id = 2, sourceInstanceId = WITHINGS, startAt = "2026-04-19T14:00:00Z", endAt = "2026-04-19T14:30:00Z")
        fixture.insertSleepSession(id = 3, sourceInstanceId = GOOGLE, startAt = "2026-04-19T01:05:00Z", endAt = "2026-04-19T07:05:00Z")

        assertEquals(listOf(1, 2), fixture.canonicalIds("canonical_sleep_sessions", "start_at"))
    }

    @Test
    fun sleepSessionsSingleProviderDatePassesThrough() {
        val fixture = Fixture()
        fixture.insertSleepSession(id = 1, sourceInstanceId = GOOGLE, startAt = "2026-04-19T01:00:00Z", endAt = "2026-04-19T07:00:00Z")
        fixture.insertSleepSession(id = 2, sourceInstanceId = GOOGLE, startAt = "2026-04-19T14:00:00Z", endAt = "2026-04-19T14:30:00Z")

        assertEquals(listOf(1, 2), fixture.canonicalIds("canonical_sleep_sessions", "start_at"))
    }

    @Test
    fun sleepNightsRankWinnerPerDateAndTimezone() {
        val fixture = Fixture()
        fixture.insertSleepSession(id = 1, sourceInstanceId = WITHINGS, startAt = "2026-04-18T22:00:00Z", endAt = "2026-04-19T06:00:00Z")
        fixture.insertSleepSession(id = 2, sourceInstanceId = GOOGLE, startAt = "2026-04-18T22:05:00Z", endAt = "2026-04-19T06:05:00Z")
        // same (date, timezone): withings (sleep rank 0) wins
        fixture.insertSleepNight(id = 1, sourceInstanceId = WITHINGS, date = "2026-04-19", timezone = "UTC", sleepSessionId = 1)
        fixture.insertSleepNight(id = 2, sourceInstanceId = GOOGLE, date = "2026-04-19", timezone = "UTC", sleepSessionId = 2)
        // same date in another timezone partitions independently, so google survives there
        fixture.insertSleepNight(id = 3, sourceInstanceId = GOOGLE, date = "2026-04-19", timezone = "Europe/Berlin", sleepSessionId = 2)

        assertEquals(listOf(3, 1), fixture.canonicalIds("canonical_sleep_nights", "timezone"))
    }

    private class Fixture {
        val dbConfig: DatabaseConfig = PostgresTestDatabase.config()

        init {
            DatabaseFactory().initialize(dbConfig)
            execute(
                """
                INSERT INTO sources (id, code, display_name, created_at)
                VALUES (1, 'withings', NULL, '2026-04-19T00:00:00Z'),
                       (2, 'google_health', NULL, '2026-04-19T00:00:00Z')
                """.trimIndent()
            )
            execute(
                """
                INSERT INTO source_instances (id, source_id, provider_instance_id, display_name, created_at, updated_at)
                VALUES (1, 1, 'withings-1', NULL, '2026-04-19T00:00:00Z', '2026-04-19T00:00:00Z'),
                       (2, 2, 'google-1', NULL, '2026-04-19T00:00:00Z', '2026-04-19T00:00:00Z'),
                       (3, 2, 'google-2', NULL, '2026-04-19T00:00:00Z', '2026-04-19T00:00:00Z')
                """.trimIndent()
            )
        }

        fun insertActivitySummary(id: Int, sourceInstanceId: Int, date: String) {
            execute(
                """
                INSERT INTO activity_summaries (id, source_instance_id, date, distance_meters, created_at)
                VALUES ($id, $sourceInstanceId, '$date', 1000.0, '2026-04-19T10:00:00Z')
                """.trimIndent()
            )
        }

        fun insertStepDailySummary(id: Int, sourceInstanceId: Int, date: String, steps: Int, sampleCount: Int) {
            execute(
                """
                INSERT INTO step_daily_summaries (id, date, source_instance_id, steps, sample_count, computed_at)
                VALUES ($id, '$date', $sourceInstanceId, $steps, $sampleCount, '2026-04-19T10:00:00Z')
                """.trimIndent()
            )
        }

        fun insertSleepSummary(id: Int, sourceInstanceId: Int, startAt: String, endAt: String) {
            execute(
                """
                INSERT INTO sleep_summaries (id, source_instance_id, start_at, end_at, total_sleep_seconds, created_at)
                VALUES ($id, $sourceInstanceId, '$startAt', '$endAt', 28800, '2026-04-19T10:00:00Z')
                """.trimIndent()
            )
        }

        fun insertSleepSession(id: Int, sourceInstanceId: Int, startAt: String, endAt: String) {
            execute(
                """
                INSERT INTO sleep_sessions (id, source_instance_id, start_at, end_at, duration_seconds, created_at)
                VALUES ($id, $sourceInstanceId, '$startAt', '$endAt',
                        EXTRACT(EPOCH FROM ('$endAt'::timestamptz - '$startAt'::timestamptz))::bigint,
                        '2026-04-19T10:00:00Z')
                """.trimIndent()
            )
        }

        fun insertSleepNight(id: Int, sourceInstanceId: Int, date: String, timezone: String, sleepSessionId: Int) {
            execute(
                """
                INSERT INTO sleep_nights (id, date, timezone, source_instance_id, sleep_session_id, algorithm_version, computed_at)
                VALUES ($id, '$date', '$timezone', $sourceInstanceId, $sleepSessionId, 1, '2026-04-19T10:00:00Z')
                """.trimIndent()
            )
        }

        fun canonicalIds(view: String, orderBy: String): List<Int> {
            val ids = mutableListOf<Int>()
            PostgresTestDatabase.connection(dbConfig).use { connection ->
                connection.createStatement().use { statement ->
                    statement.executeQuery("SELECT id FROM $view ORDER BY $orderBy, id").use { resultSet ->
                        while (resultSet.next()) ids.add(resultSet.getInt(1))
                    }
                }
            }
            return ids
        }

        fun execute(sql: String) {
            PostgresTestDatabase.connection(dbConfig).use { connection ->
                connection.createStatement().use { statement ->
                    statement.execute(sql)
                }
            }
        }
    }

    private companion object {
        const val WITHINGS = 1
        const val GOOGLE = 2
        const val GOOGLE_2 = 3
    }
}
