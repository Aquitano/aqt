package me.aquitano.health.infrastructure.database

import me.aquitano.health.infrastructure.config.DatabaseConfig
import me.aquitano.health.test.PostgresTestDatabase
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Semantics of the canonical_scalar_samples view: cross-provider collisions within a 30s
 * date_bin keep only the top-ranked provider's rows, single-provider bins pass through
 * untouched, and context/segment values partition independently. Heart-rate samples with
 * context='sleep' rank by the sleep family (withings first) instead of heart_rate
 * (google_health first).
 */
class CanonicalScalarSamplesViewTest {
    @Test
    fun crossProviderCollisionKeepsOnlyTopRankedProvider() {
        val fixture = Fixture()
        // heart_rate family: google_health(0) beats withings(2); same 30s bin
        fixture.insertSample(GOOGLE, "2026-04-19T08:00:01Z", "heart_rate", 60.0, "bpm", context = "resting")
        fixture.insertSample(WITHINGS, "2026-04-19T08:00:11Z", "heart_rate", 70.0, "bpm", context = "resting")

        assertEquals(listOf(60.0), fixture.canonicalValues("heart_rate"))
    }

    @Test
    fun singleProviderBinPassesAllSamplesThrough() {
        val fixture = Fixture()
        fixture.insertSample(WITHINGS, "2026-04-19T08:00:01Z", "heart_rate", 70.0, "bpm", context = "resting")
        fixture.insertSample(WITHINGS, "2026-04-19T08:00:11Z", "heart_rate", 71.0, "bpm", context = "resting")
        fixture.insertSample(WITHINGS, "2026-04-19T08:00:21Z", "heart_rate", 72.0, "bpm", context = "resting")

        assertEquals(listOf(70.0, 71.0, 72.0), fixture.canonicalValues("heart_rate"))
    }

    @Test
    fun samplesOutsideTheCollidingBinSurvive() {
        val fixture = Fixture()
        fixture.insertSample(GOOGLE, "2026-04-19T08:00:01Z", "heart_rate", 60.0, "bpm", context = "resting")
        fixture.insertSample(WITHINGS, "2026-04-19T08:00:11Z", "heart_rate", 70.0, "bpm", context = "resting")
        // next 30s bin holds only withings, so it passes through
        fixture.insertSample(WITHINGS, "2026-04-19T08:00:41Z", "heart_rate", 71.0, "bpm", context = "resting")

        assertEquals(listOf(60.0, 71.0), fixture.canonicalValues("heart_rate"))
    }

    @Test
    fun contextPartitionsIndependently() {
        val fixture = Fixture()
        // same bin, different contexts: both survive even across providers
        fixture.insertSample(GOOGLE, "2026-04-19T08:00:01Z", "heart_rate", 60.0, "bpm", context = "active")
        fixture.insertSample(WITHINGS, "2026-04-19T08:00:11Z", "heart_rate", 55.0, "bpm", context = "resting")

        assertEquals(listOf(60.0, 55.0), fixture.canonicalValues("heart_rate"))
    }

    @Test
    fun sleepContextHeartRateRanksByTheSleepFamily() {
        val fixture = Fixture()
        // sleep family: withings(0) beats google_health(1)
        fixture.insertSample(GOOGLE, "2026-04-19T03:00:01Z", "heart_rate", 58.0, "bpm", context = "sleep")
        fixture.insertSample(WITHINGS, "2026-04-19T03:00:11Z", "heart_rate", 52.0, "bpm", context = "sleep")

        assertEquals(listOf(52.0), fixture.canonicalValues("heart_rate"))
    }

    @Test
    fun segmentPartitionsIndependently() {
        val fixture = Fixture()
        fixture.insertSample(
            WITHINGS, "2026-04-19T07:00:01Z", "segmental_muscle_mass", 3.2, "kg", segment = "left_arm",
        )
        fixture.insertSample(
            WITHINGS, "2026-04-19T07:00:02Z", "segmental_muscle_mass", 3.4, "kg", segment = "right_arm",
        )

        assertEquals(listOf(3.2, 3.4), fixture.canonicalValues("segmental_muscle_mass"))
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
                       (2, 2, 'google-1', NULL, '2026-04-19T00:00:00Z', '2026-04-19T00:00:00Z')
                """.trimIndent()
            )
        }

        fun insertSample(
            sourceInstanceId: Int,
            measuredAt: String,
            metricType: String,
            value: Double,
            unit: String,
            context: String? = null,
            segment: String? = null,
        ) {
            execute(
                """
                INSERT INTO scalar_samples (source_instance_id, measured_at, metric_type, value, unit, context, segment, created_at)
                VALUES ($sourceInstanceId, '$measuredAt', '$metricType', $value, '$unit',
                        ${context?.let { "'$it'" } ?: "NULL"}, ${segment?.let { "'$it'" } ?: "NULL"},
                        '2026-04-19T10:00:00Z')
                """.trimIndent()
            )
        }

        fun canonicalValues(metricType: String): List<Double> {
            val values = mutableListOf<Double>()
            PostgresTestDatabase.connection(dbConfig).use { connection ->
                connection.createStatement().use { statement ->
                    statement.executeQuery(
                        "SELECT value FROM canonical_scalar_samples WHERE metric_type = '$metricType' ORDER BY measured_at"
                    ).use { resultSet ->
                        while (resultSet.next()) values.add(resultSet.getDouble(1))
                    }
                }
            }
            return values
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
    }
}
