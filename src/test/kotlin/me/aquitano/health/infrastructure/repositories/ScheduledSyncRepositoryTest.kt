package me.aquitano.health.infrastructure.repositories

import kotlinx.coroutines.runBlocking
import me.aquitano.health.infrastructure.config.DatabaseConfig
import me.aquitano.health.infrastructure.database.DatabaseFactory
import me.aquitano.health.test.PostgresTestDatabase
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

class ScheduledSyncRepositoryTest {
    @Test
    fun configAndCheckpointsArePersisted() = runBlocking {
        val database = DatabaseFactory().initialize(tempDatabaseConfig())
        val repository = ScheduledSyncRepository(database)
        val now = Instant.parse("2026-05-31T10:00:00Z")

        val config = repository.upsertConfig(
            providerCode = "google_health",
            providerInstanceId = "google-health-me",
            enabled = true,
            dataTypes = listOf("steps", "heart-rate"),
            cadenceMinutes = 1_440,
            lookbackDays = 7,
            nextRunAt = now,
            now = now,
        )

        assertEquals(true, config.enabled)
        assertEquals(listOf("steps", "heart-rate"), config.dataTypes)
        assertEquals(2, repository.checkpoints(config.id).size)

        repository.markDataTypeSuccess(
            configId = config.id,
            dataType = "steps",
            from = Instant.parse("2026-05-30T00:00:00Z"),
            to = now,
            now = now,
        )
        val stepsCheckpoint = repository.checkpoints(config.id).single { it.dataType == "steps" }
        assertEquals(now, stepsCheckpoint.checkpointAt)

        repository.upsertConfig(
            providerCode = "google_health",
            providerInstanceId = "google-health-me",
            enabled = true,
            dataTypes = listOf("steps"),
            cadenceMinutes = 1_440,
            lookbackDays = 7,
            nextRunAt = now,
            now = now,
        )
        assertEquals(listOf("steps"), repository.checkpoints(config.id).map { it.dataType })

        val due = repository.dueConfigs(now)
        assertEquals(config.id, due.single().id)
        assertNotNull(repository.getConfig("google_health", "google-health-me"))
        Unit
    }

    private fun tempDatabaseConfig(): DatabaseConfig = PostgresTestDatabase.config()
}
