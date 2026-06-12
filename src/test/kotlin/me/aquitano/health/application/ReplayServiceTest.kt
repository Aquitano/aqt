package me.aquitano.health.application

import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.buildJsonObject
import me.aquitano.health.api.dto.ActivitySummaryDto
import me.aquitano.health.api.dto.HeartRateDto
import me.aquitano.health.api.dto.IngestionBatchRequest
import me.aquitano.health.api.dto.ReplayJobStatus
import me.aquitano.health.api.dto.ReplayJobStatusResponse
import me.aquitano.health.api.dto.ReplayRequest
import me.aquitano.health.api.dto.SleepSessionDto
import me.aquitano.health.api.dto.StepIntervalDto
import me.aquitano.health.test.metricWriteService
import me.aquitano.health.domain.RecordTypes
import me.aquitano.health.domain.RequestValidationException
import me.aquitano.health.infrastructure.config.DatabaseConfig
import me.aquitano.health.infrastructure.database.DatabaseFactory
import me.aquitano.health.infrastructure.repositories.IngestionRepository
import me.aquitano.health.infrastructure.repositories.PendingDerivedRebuildRepository
import me.aquitano.health.infrastructure.repositories.ProjectionWipeRepository
import me.aquitano.health.infrastructure.repositories.ReplayJobRepository
import me.aquitano.health.infrastructure.repositories.SupportRepository
import me.aquitano.health.infrastructure.time.UtcClock
import me.aquitano.health.test.PostgresTestDatabase
import me.aquitano.health.test.realDerivedRebuildExecutor
import org.jetbrains.exposed.v1.jdbc.Database
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class ReplayServiceTest {
    @Test
    fun replayRestoresWipedProjectionsAndDerivedTables() = runBlocking {
        val fixture = Fixture()
        fixture.ingestMixedBatch()

        assertEquals(1, fixture.count("scalar_samples"))
        assertEquals(1, fixture.count("canonical_scalar_samples"))
        fixture.execute("DELETE FROM scalar_samples")
        assertEquals(0, fixture.count("scalar_samples"))
        assertEquals(0, fixture.count("canonical_scalar_samples"))

        val job = fixture.runReplay(ReplayRequest(scope = "all"))

        assertEquals(ReplayJobStatus.Completed, job.status)
        assertTrue(job.metricsWritten >= 1, "expected restored metrics, got ${job.metricsWritten}")
        assertEquals(0, job.mappingFailures)
        assertEquals(1, fixture.count("scalar_samples"))
        assertEquals(1, fixture.count("canonical_scalar_samples"))
        assertEquals(1, fixture.count("step_samples"))
        assertEquals(1, fixture.count("canonical_activity_summaries"))
    }

    @Test
    fun verifyModeReportsNoMissingWritesOnIntactData() = runBlocking {
        val fixture = Fixture()
        fixture.ingestMixedBatch()

        val job = fixture.runReplay(ReplayRequest(scope = "projections"))

        assertEquals(ReplayJobStatus.Completed, job.status)
        assertEquals(0, job.metricsWritten)
        assertTrue(job.duplicatesSkipped >= 4, "expected duplicates, got ${job.duplicatesSkipped}")
        assertEquals(0, job.mappingFailures)
    }

    @Test
    fun derivedOnlyReplayRebuildsDerivedTablesWithoutTouchingProjections() = runBlocking {
        val fixture = Fixture()
        fixture.ingestMixedBatch()

        fixture.execute("DELETE FROM step_daily_summaries")
        fixture.execute("DELETE FROM sleep_nights")

        val job = fixture.runReplay(ReplayRequest(scope = "derived"))

        assertEquals(ReplayJobStatus.Completed, job.status)
        assertEquals(0, job.recordsReplayed)
        assertEquals(1, fixture.count("step_daily_summaries"))
        assertEquals(1, fixture.count("sleep_nights"))
        // canonical views need no rebuild: they reflect the underlying tables directly
        assertEquals(1, fixture.count("canonical_step_daily_summaries"))
        assertEquals(1, fixture.count("canonical_activity_summaries"))
    }

    @Test
    fun wipeReplayRewritesProjectionRowsInRange() = runBlocking {
        val fixture = Fixture()
        fixture.ingestMixedBatch()
        val originalId = fixture.singleInt("SELECT id FROM scalar_samples")

        val job = fixture.runReplay(
            ReplayRequest(
                scope = "all",
                metricTypes = listOf(RecordTypes.HEART_RATE),
                fromDate = "2026-04-19",
                toDate = "2026-04-19",
                wipe = true,
            )
        )

        assertEquals(ReplayJobStatus.Completed, job.status)
        assertEquals(1, job.recordsReplayed)
        assertEquals(1, job.metricsWritten)
        assertEquals(1, fixture.count("scalar_samples"))
        assertEquals(1, fixture.count("canonical_scalar_samples"))
        assertTrue(
            fixture.singleInt("SELECT id FROM scalar_samples") != originalId,
            "wipe should rewrite the row under a new id",
        )
        // Untouched record types survive a scoped wipe.
        assertEquals(1, fixture.count("step_samples"))
    }

    @Test
    fun replayRejectsUnknownScopeAndRecordTypes(): Unit = runBlocking {
        val fixture = Fixture()
        assertFailsWith<RequestValidationException> {
            fixture.replayService.create(ReplayRequest(scope = "bogus"), fixture.clock.now())
        }
        assertFailsWith<RequestValidationException> {
            fixture.replayService.create(
                ReplayRequest(metricTypes = listOf("not_a_record_type")),
                fixture.clock.now(),
            )
        }
        assertFailsWith<RequestValidationException> {
            fixture.replayService.create(
                ReplayRequest(scope = "derived", wipe = true),
                fixture.clock.now(),
            )
        }
    }

    private class Fixture {
        val dbConfig: DatabaseConfig = PostgresTestDatabase.config()
        val database: Database = DatabaseFactory().initialize(dbConfig)
        val clock = UtcClock()
        private val mappingService = IngestionMappingService()
        private val metricWriteService = metricWriteService()
        private val derivedRebuildExecutor = realDerivedRebuildExecutor(database)
        private val ingestionService = IngestionService(
            database = database,
            mappingService = mappingService,
            supportRepository = SupportRepository(database),
            ingestionRepository = IngestionRepository(),
            metricWriteService = metricWriteService,
            derivedRebuildExecutor = derivedRebuildExecutor,
            pendingDerivedRebuildRepository = PendingDerivedRebuildRepository(database),
        )
        val replayService = ReplayService(
            database = database,
            ingestionRepository = IngestionRepository(),
            mappingService = mappingService,
            metricWriteService = metricWriteService,
            derivedRebuildExecutor = derivedRebuildExecutor,
            replayJobRepository = ReplayJobRepository(database),
            projectionWipeRepository = ProjectionWipeRepository(),
            clock = clock,
        )

        suspend fun ingestMixedBatch() {
            ingestionService.ingestBatch(
                IngestionBatchRequest(
                    provider = "withings",
                    providerInstanceId = "scale-1",
                    batchExternalId = "replay-fixture-1",
                    ingestedAt = "2026-04-19T10:00:00Z",
                    sourcePayload = buildJsonObject {},
                    records = listOf(
                        StepIntervalDto(
                            providerRecordId = "steps-1",
                            startAt = "2026-04-19T08:00:00Z",
                            endAt = "2026-04-19T09:00:00Z",
                            steps = 1200,
                        ),
                        HeartRateDto(
                            providerRecordId = "hr-1",
                            measuredAt = "2026-04-19T08:30:00Z",
                            bpm = 64,
                            context = "resting",
                        ),
                        SleepSessionDto(
                            providerRecordId = "sleep-1",
                            startAt = "2026-04-18T22:00:00Z",
                            endAt = "2026-04-19T06:00:00Z",
                        ),
                        ActivitySummaryDto(
                            providerRecordId = "activity-1",
                            date = "2026-04-19",
                            distanceMeters = 4200.0,
                            activeMinutes = 55,
                        ),
                    ),
                ),
                Instant.parse("2026-04-19T10:01:00Z"),
            )
        }

        suspend fun runReplay(request: ReplayRequest): ReplayJobStatusResponse {
            val start = replayService.create(request, clock.now())
            return withTimeout(60_000) {
                var job = replayService.get(start.jobId)
                while (!job.status.terminal) {
                    delay(100)
                    job = replayService.get(start.jobId)
                }
                job
            }
        }

        fun count(table: String): Int = singleInt("SELECT COUNT(*) FROM $table")

        fun singleInt(sql: String): Int =
            PostgresTestDatabase.connection(dbConfig).use { connection ->
                connection.createStatement().use { statement ->
                    statement.executeQuery(sql).use { resultSet ->
                        resultSet.next()
                        resultSet.getInt(1)
                    }
                }
            }

        fun execute(sql: String) {
            PostgresTestDatabase.connection(dbConfig).use { connection ->
                connection.createStatement().use { statement ->
                    statement.execute(sql)
                }
            }
        }
    }
}
