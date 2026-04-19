package me.aquitano.health.infrastructure.database

import me.aquitano.health.application.ApiClientBootstrapService
import me.aquitano.health.infrastructure.config.AuthConfig
import me.aquitano.health.infrastructure.config.DatabaseConfig
import me.aquitano.health.infrastructure.repositories.SupportRepository
import me.aquitano.health.infrastructure.security.ApiKeyHasher
import me.aquitano.health.infrastructure.time.UtcClock
import org.jetbrains.exposed.sql.transactions.transaction
import java.nio.file.Files
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals

class DatabaseFactoryTest {
    @Test
    fun migrationsCreateExpectedTables() {
        val database = DatabaseFactory().initialize(tempDatabaseConfig())

        val tableNames = transaction(database) {
            val names = mutableSetOf<String>()
            exec("SELECT name FROM sqlite_master WHERE type = 'table'") { resultSet ->
                while (resultSet.next()) {
                    names.add(resultSet.getString("name"))
                }
            }
            names
        }

        assertContains(tableNames, "sources")
        assertContains(tableNames, "source_instances")
        assertContains(tableNames, "api_clients")
        assertContains(tableNames, "raw_ingestion_batches")
        assertContains(tableNames, "raw_ingestion_records")
        assertContains(tableNames, "step_samples")
        assertContains(tableNames, "step_daily_summaries")
        assertContains(tableNames, "sleep_sessions")
        assertContains(tableNames, "sleep_stages")
        assertContains(tableNames, "body_measurements")
        assertContains(tableNames, "heart_rate_samples")
    }

    @Test
    fun bootstrapStoresOnlyHashedApiKey() {
        val database = DatabaseFactory().initialize(tempDatabaseConfig())
        val hasher = ApiKeyHasher()
        ApiClientBootstrapService(
            authConfig = AuthConfig(
                bootstrapClientName = "test-client",
                bootstrapApiKey = "plain-test-key"
            ),
            supportRepository = SupportRepository(database),
            apiKeyHasher = hasher,
            clock = UtcClock.fixed(Instant.parse("2026-04-19T10:00:00Z")),
        ).bootstrap()

        val stored = transaction(database) {
            var hash: String? = null
            exec("SELECT api_key_hash FROM api_clients WHERE name = 'test-client'") { resultSet ->
                if (resultSet.next()) hash = resultSet.getString("api_key_hash")
            }
            hash
        }

        assertEquals(hasher.hash("plain-test-key"), stored)
    }

    private fun tempDatabaseConfig(): DatabaseConfig {
        val dbPath = Files.createTempFile("aqt-health-db-test", ".db")
        return DatabaseConfig(
            jdbcUrl = "jdbc:sqlite:$dbPath",
            driver = "org.sqlite.JDBC",
        )
    }
}
