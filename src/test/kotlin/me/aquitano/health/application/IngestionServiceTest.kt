package me.aquitano.health.application

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import me.aquitano.health.domain.BatchStatus
import me.aquitano.health.domain.ConflictException
import me.aquitano.health.api.dto.IngestionBatchRequest
import me.aquitano.health.api.dto.StepInterval
import me.aquitano.health.test.metricWriteService
import me.aquitano.health.infrastructure.config.DatabaseConfig
import me.aquitano.health.infrastructure.database.DatabaseFactory
import me.aquitano.health.infrastructure.repositories.IngestionRepository
import me.aquitano.health.infrastructure.repositories.PendingDerivedRebuildRepository
import me.aquitano.health.infrastructure.repositories.SupportRepository
import me.aquitano.health.test.PostgresTestDatabase
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class IngestionServiceTest {
    @Test
    fun derivedRebuildFailureDoesNotFailRawIngestion() = runBlocking {
        val dbConfig = PostgresTestDatabase.config()
        val database = DatabaseFactory().initialize(dbConfig)
        val service = IngestionService(
            database = database,
            mappingService = IngestionMappingService(),
            supportRepository = SupportRepository(database),
            ingestionRepository = IngestionRepository(),
            metricWriteService = metricWriteService(),
            derivedRebuildExecutor = FailingDerivedRebuildExecutor,
            pendingDerivedRebuildRepository = PendingDerivedRebuildRepository(database),
        )

        val response = service.ingestBatch(
            IngestionBatchRequest(
                provider = "health_connect",
                providerInstanceId = "pixel-8-health-connect",
                batchExternalId = "derived-fails",
                ingestedAt = "2026-04-19T10:00:00Z",
                sourcePayload = buildJsonObject {},
                records = listOf(
                    StepInterval(
                        providerRecordId = "steps-1",
                        startAt = "2026-04-19T08:00:00Z",
                        endAt = "2026-04-19T09:00:00Z",
                        steps = 1200,
                    )
                ),
            ),
            Instant.parse("2026-04-19T10:01:00Z"),
        )

        assertEquals(BatchStatus.Processed, response.status)
        assertEquals("processed", singleString(dbConfig, "SELECT status FROM ingestion_batches"))
        assertEquals(1, singleInt(dbConfig, "SELECT COUNT(*) FROM ingestion_records"))
        assertEquals(1, singleInt(dbConfig, "SELECT COUNT(*) FROM step_samples"))
        assertEquals(0, singleInt(dbConfig, "SELECT COUNT(*) FROM step_daily_summaries"))
        assertTrue(
            singleString(dbConfig, "SELECT error_message FROM ingestion_batches")
                .startsWith("Derived rebuild failed: test derived failure")
        )
        // The failed rebuild must be queued for the sweeper, not just marked on the batch.
        assertEquals(1, singleInt(dbConfig, "SELECT COUNT(*) FROM pending_derived_rebuilds"))
        assertEquals(
            "STEP_SUMMARY",
            singleString(dbConfig, "SELECT derived_kind FROM pending_derived_rebuilds"),
        )
        assertEquals(
            "2026-04-19",
            singleString(dbConfig, "SELECT affected_date::text FROM pending_derived_rebuilds"),
        )
    }

    @Test
    fun unknownExistingBatchStatusReturnsConflictInsteadOfParseFailure() = runBlocking {
        val dbConfig = PostgresTestDatabase.config()
        val database = DatabaseFactory().initialize(dbConfig)
        val service = IngestionService(
            database = database,
            mappingService = IngestionMappingService(),
            supportRepository = SupportRepository(database),
            ingestionRepository = IngestionRepository(),
            metricWriteService = metricWriteService(),
            derivedRebuildExecutor = FailingDerivedRebuildExecutor,
            pendingDerivedRebuildRepository = PendingDerivedRebuildRepository(database),
        )
        val request = IngestionBatchRequest(
            provider = "health_connect",
            providerInstanceId = "pixel-8-health-connect",
            batchExternalId = "legacy-status",
            ingestedAt = "2026-04-20T10:00:00Z",
            sourcePayload = buildJsonObject {},
            records = listOf(
                StepInterval(
                    providerRecordId = "steps-legacy",
                    startAt = "2026-04-20T08:00:00Z",
                    endAt = "2026-04-20T09:00:00Z",
                    steps = 900,
                )
            ),
        )

        service.ingestBatch(request, Instant.parse("2026-04-20T10:01:00Z"))
        execute(dbConfig, "ALTER TABLE ingestion_batches DROP CONSTRAINT ingestion_batches_status_check")
        execute(dbConfig, "UPDATE ingestion_batches SET status = 'legacy' WHERE batch_external_id = 'legacy-status'")

        val error = assertFailsWith<ConflictException> {
            service.ingestBatch(request, Instant.parse("2026-04-20T10:02:00Z"))
        }

        assertEquals("ingestion_batch_in_progress", error.code)
        assertTrue(error.message!!.contains("status 'legacy'"))
    }

    private object FailingDerivedRebuildExecutor : DerivedRebuildExecutor {
        override suspend fun rebuild(request: DerivedRebuildRequest, computedAt: Instant) {
            throw IllegalStateException("test derived failure")
        }
    }

    private fun singleInt(dbConfig: DatabaseConfig, sql: String): Int =
        PostgresTestDatabase.connection(dbConfig).use { connection ->
            connection.createStatement().use { statement ->
                statement.executeQuery(sql).use { resultSet ->
                    resultSet.next()
                    resultSet.getInt(1)
                }
            }
        }

    private fun singleString(dbConfig: DatabaseConfig, sql: String): String =
        PostgresTestDatabase.connection(dbConfig).use { connection ->
            connection.createStatement().use { statement ->
                statement.executeQuery(sql).use { resultSet ->
                    resultSet.next()
                    resultSet.getString(1)
                }
            }
        }

    private fun execute(dbConfig: DatabaseConfig, sql: String) {
        PostgresTestDatabase.connection(dbConfig).use { connection ->
            connection.createStatement().use { statement ->
                statement.execute(sql)
            }
        }
    }
}
