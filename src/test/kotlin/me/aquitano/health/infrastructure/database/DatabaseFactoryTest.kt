package me.aquitano.health.infrastructure.database

import me.aquitano.health.application.ApiClientBootstrapService
import me.aquitano.health.infrastructure.config.AuthConfig
import me.aquitano.health.infrastructure.config.DatabaseConfig
import me.aquitano.health.infrastructure.repositories.SupportRepository
import me.aquitano.health.infrastructure.security.ApiKeyHasher
import me.aquitano.health.infrastructure.time.UtcClock
import me.aquitano.health.test.PostgresTestDatabase
import org.jetbrains.exposed.v1.jdbc.transactions.TransactionManager
import org.jetbrains.exposed.v1.jdbc.transactions.transaction
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class DatabaseFactoryTest {
    @Test
    fun migrationsCreateExpectedTables() {
        val database = DatabaseFactory().initialize(tempDatabaseConfig())

        val tableNames = transaction(database) {
            val names = mutableSetOf<String>()
            exec("SELECT tablename FROM pg_tables WHERE schemaname = current_schema()") { resultSet ->
                while (resultSet.next()) {
                    names.add(resultSet.getString("tablename"))
                }
            }
            names
        }

        assertContains(tableNames, "sources")
        assertContains(tableNames, "source_instances")
        assertContains(tableNames, "api_clients")
        assertContains(tableNames, "ingestion_batches")
        assertContains(tableNames, "ingestion_records")
        assertContains(tableNames, "step_samples")
        assertContains(tableNames, "step_daily_summaries")
        assertContains(tableNames, "sleep_sessions")
        assertContains(tableNames, "sleep_stages")
        assertContains(tableNames, "body_measurements")
        assertContains(tableNames, "heart_rate_samples")
        assertContains(tableNames, "canonical_heart_rate_samples")
        assertContains(tableNames, "canonical_respiratory_rate_samples")
        assertContains(tableNames, "canonical_hrv_samples")
        assertContains(tableNames, "provider_oauth_accounts")
        assertContains(tableNames, "provider_oauth_states")
        assertContains(tableNames, "provider_sync_runs")
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

    @Test
    fun postgresForeignKeysAreEnforced() {
        val database = DatabaseFactory().initialize(tempDatabaseConfig())

        transaction(database) {
            assertFailsWith<Exception> {
                exec(
                    """
                    INSERT INTO source_instances (
                        source_id,
                        provider_instance_id,
                        display_name,
                        created_at,
                        updated_at
                    )
                    VALUES (
                        999,
                        'missing-source',
                        NULL,
                        '2026-04-19T10:00:00Z',
                        '2026-04-19T10:00:00Z'
                    )
                    """.trimIndent()
                )
            }
        }
    }

    @Test
    fun postgresConnectionUsesReadCommitted() {
        val database = DatabaseFactory().initialize(tempDatabaseConfig())

        transaction(database) {
            assertEquals("read committed", singleString("SHOW transaction_isolation"))
        }
    }

    @Test
    fun sleepStagesCascadeWhenSessionIsDeleted() {
        val database = DatabaseFactory().initialize(tempDatabaseConfig())

        transaction(database) {
            insertSourceInstance()
            exec(
                """
                INSERT INTO sleep_sessions (
                    id,
                    source_instance_id,
                    ingestion_record_id,
                    provider_record_id,
                    start_at,
                    end_at,
                    duration_seconds,
                    created_at
                )
                VALUES (
                    1,
                    1,
                    NULL,
                    'sleep-1',
                    '2026-04-18T22:00:00Z',
                    '2026-04-19T06:00:00Z',
                    28800,
                    '2026-04-19T10:00:00Z'
                )
                """.trimIndent()
            )
            exec(
                """
                INSERT INTO sleep_stages (
                    sleep_session_id,
                    stage,
                    start_at,
                    end_at,
                    duration_seconds
                )
                VALUES (
                    1,
                    'light',
                    '2026-04-18T22:00:00Z',
                    '2026-04-19T06:00:00Z',
                    28800
                )
                """.trimIndent()
            )

            exec("DELETE FROM sleep_sessions WHERE id = 1")

            assertEquals(0, singleInt("SELECT COUNT(*) FROM sleep_stages"))
        }
    }

    @Test
    fun integrityConstraintsRejectInvalidMetricRows() {
        val database = DatabaseFactory().initialize(tempDatabaseConfig())

        transaction(database) {
            insertSourceInstance()

            assertFailsWith<Exception> {
                exec(
                    """
                    INSERT INTO ingestion_batches (
                        source_instance_id,
                        batch_external_id,
                        source_payload_json,
                        normalized_payload_json,
                        status,
                        ingested_at,
                        received_at,
                        processed_at,
                        error_message,
                        created_at,
                        updated_at
                    )
                    VALUES (
                        1,
                        'bad-status',
                        '{}',
                        '{}',
                        'done',
                        '2026-04-19T10:00:00Z',
                        '2026-04-19T10:00:00Z',
                        NULL,
                        NULL,
                        '2026-04-19T10:00:00Z',
                        '2026-04-19T10:00:00Z'
                    )
                    """.trimIndent()
                )
            }

            assertFailsWith<Exception> {
                exec(
                    """
                    INSERT INTO step_samples (
                        source_instance_id,
                        ingestion_record_id,
                        provider_record_id,
                        start_at,
                        end_at,
                        steps,
                        created_at
                    )
                    VALUES (
                        1,
                        NULL,
                        'steps-invalid',
                        '2026-04-19T09:00:00Z',
                        '2026-04-19T08:00:00Z',
                        1200,
                        '2026-04-19T10:00:00Z'
                    )
                    """.trimIndent()
                )
            }

            assertFailsWith<Exception> {
                exec(
                    """
                    INSERT INTO heart_rate_samples (
                        source_instance_id,
                        ingestion_record_id,
                        provider_record_id,
                        measured_at,
                        bpm,
                        context,
                        created_at
                    )
                    VALUES (
                        1,
                        NULL,
                        'hr-invalid',
                        '2026-04-19T10:00:00Z',
                        400,
                        'resting',
                        '2026-04-19T10:00:00Z'
                    )
                    """.trimIndent()
                )
            }
        }
    }

    private fun tempDatabaseConfig(): DatabaseConfig = PostgresTestDatabase.config()

    private fun singleInt(sql: String): Int {
        var value = 0
        TransactionManager.current().exec(sql) { resultSet ->
            resultSet.next()
            value = resultSet.getInt(1)
        }
        return value
    }

    private fun singleString(sql: String): String {
        var value = ""
        TransactionManager.current().exec(sql) { resultSet ->
            resultSet.next()
            value = resultSet.getString(1)
        }
        return value
    }

    private fun insertSourceInstance() {
        TransactionManager.current().exec(
            """
            INSERT INTO sources (id, code, display_name, created_at)
            VALUES (1, 'health_connect', NULL, '2026-04-19T10:00:00Z')
            """.trimIndent()
        )
        TransactionManager.current().exec(
            """
            INSERT INTO source_instances (
                id,
                source_id,
                provider_instance_id,
                display_name,
                created_at,
                updated_at
            )
            VALUES (
                1,
                1,
                'pixel-8-health-connect',
                NULL,
                '2026-04-19T10:00:00Z',
                '2026-04-19T10:00:00Z'
            )
            """.trimIndent()
        )
    }
}
