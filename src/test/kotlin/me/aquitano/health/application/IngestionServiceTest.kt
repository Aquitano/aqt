package me.aquitano.health.application

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import me.aquitano.health.api.dto.BatchStatus
import me.aquitano.health.api.dto.IngestionBatchRequest
import me.aquitano.health.api.dto.StepIntervalDto
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
                    StepIntervalDto(
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
}
