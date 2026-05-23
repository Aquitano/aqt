package me.aquitano.health.test

import me.aquitano.health.infrastructure.config.DatabaseConfig
import org.testcontainers.containers.PostgreSQLContainer
import java.sql.Connection
import java.sql.DriverManager
import java.sql.SQLException
import java.util.Collections
import java.util.UUID

object PostgresTestDatabase {
    private data class ExternalSchema(
        val jdbcUrl: String,
        val user: String,
        val password: String,
        val schema: String,
    )

    private val externalSchemas =
        Collections.synchronizedList(mutableListOf<ExternalSchema>())

    private val container: PostgreSQLContainer<Nothing> by lazy {
        PostgreSQLContainer<Nothing>("postgres:17-alpine").apply {
            withDatabaseName("postgres")
            withUsername("aqt_health")
            withPassword("aqt_health")
            start()
        }
    }

    fun config(): DatabaseConfig {
        val configuredJdbcUrl = System.getenv("AQT_HEALTH_TEST_JDBC_URL")
        val configuredUser = System.getenv("AQT_HEALTH_TEST_DB_USER") ?: "aqt_health"
        val configuredPassword = System.getenv("AQT_HEALTH_TEST_DB_PASSWORD") ?: "aqt_health"
        externalConfig(
            jdbcUrl = configuredJdbcUrl ?: LOCAL_JDBC_URL,
            user = configuredUser,
            password = configuredPassword,
            required = configuredJdbcUrl != null,
        )?.let { return it }

        if (!dockerIsAvailable()) {
            throw IllegalStateException(MISSING_DATABASE_MESSAGE)
        }

        val databaseName = "aqt_health_test_${UUID.randomUUID().toString().replace("-", "")}"
        try {
            adminConnection().use { connection ->
                connection.createStatement().use { statement ->
                    statement.execute("CREATE DATABASE $databaseName")
                }
            }
        } catch (exception: Exception) {
            throw IllegalStateException(MISSING_DATABASE_MESSAGE, exception)
        }
        return DatabaseConfig(
            jdbcUrl = "jdbc:postgresql://${container.host}:${container.getMappedPort(5432)}/$databaseName",
            driver = "org.postgresql.Driver",
            user = container.username,
            password = container.password,
            maxPoolSize = 1,
        )
    }

    fun connection(config: DatabaseConfig): Connection =
        DriverManager.getConnection(config.jdbcUrl, config.user, config.password)

    fun ktorConfigEntries(config: DatabaseConfig): Array<Pair<String, String>> =
        arrayOf(
            "aqtHealth.database.jdbcUrl" to config.jdbcUrl,
            "aqtHealth.database.driver" to config.driver,
            "aqtHealth.database.user" to config.user,
            "aqtHealth.database.password" to config.password,
            "aqtHealth.database.maxPoolSize" to config.maxPoolSize.toString(),
        )

    private fun adminConnection(): Connection =
        DriverManager.getConnection(
            "jdbc:postgresql://${container.host}:${container.getMappedPort(5432)}/postgres",
            container.username,
            container.password,
        )

    private fun externalConfig(
        jdbcUrl: String,
        user: String,
        password: String,
        required: Boolean,
    ): DatabaseConfig? {
        val schema = "aqt_health_test_${UUID.randomUUID().toString().replace("-", "")}"
        try {
            DriverManager.getConnection(jdbcUrl.withJdbcParameter("connectTimeout", "1"), user, password)
                .use { connection ->
                    connection.createStatement().use { statement ->
                        statement.execute("CREATE SCHEMA $schema")
                    }
                }
        } catch (exception: SQLException) {
            if (required) {
                throw IllegalStateException(
                    "AQT_HEALTH_TEST_JDBC_URL is set, but the configured PostgreSQL database is not reachable.",
                    exception,
                )
            }
            return null
        }
        externalSchemas.add(ExternalSchema(jdbcUrl, user, password, schema))
        return DatabaseConfig(
            jdbcUrl = jdbcUrl.withJdbcParameter("currentSchema", schema),
            driver = "org.postgresql.Driver",
            user = user,
            password = password,
            maxPoolSize = 1,
        )
    }

    private fun dockerIsAvailable(): Boolean =
        listOf(
            listOf("docker", "info"),
            listOf("/usr/local/bin/docker", "info"),
            listOf("/opt/homebrew/bin/docker", "info"),
        ).any { command ->
            try {
                ProcessBuilder(command)
                    .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                    .redirectError(ProcessBuilder.Redirect.DISCARD)
                    .start()
                    .waitFor() == 0
            } catch (_: Exception) {
                false
            }
        }

    private fun String.withJdbcParameter(name: String, value: String): String {
        val separator = if (contains("?")) "&" else "?"
        return "$this$separator$name=$value"
    }

    init {
        Runtime.getRuntime().addShutdownHook(
            Thread {
                externalSchemas.toList().forEach { externalSchema ->
                    DriverManager.getConnection(
                        externalSchema.jdbcUrl,
                        externalSchema.user,
                        externalSchema.password,
                    ).use { connection ->
                        connection.createStatement().use { statement ->
                            statement.execute(
                                "DROP SCHEMA IF EXISTS ${externalSchema.schema} CASCADE"
                            )
                        }
                    }
                }
            }
        )
    }

    private const val LOCAL_JDBC_URL =
        "jdbc:postgresql://localhost:5432/aqt_health"

    private const val MISSING_DATABASE_MESSAGE =
        "PostgreSQL integration tests require Docker or a reachable " +
                "AQT_HEALTH_TEST_JDBC_URL/local PostgreSQL database."
}
