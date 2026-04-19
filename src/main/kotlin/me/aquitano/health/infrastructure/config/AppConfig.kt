package me.aquitano.health.infrastructure.config

import io.ktor.server.config.*

data class AppConfig(
    val database: DatabaseConfig,
    val auth: AuthConfig,
)

data class DatabaseConfig(
    val jdbcUrl: String,
    val driver: String,
)

data class AuthConfig(
    val bootstrapClientName: String,
    val bootstrapApiKey: String,
)

fun ApplicationConfig.toAppConfig(): AppConfig =
    AppConfig(
        database = DatabaseConfig(
            jdbcUrl = property("aqtHealth.database.jdbcUrl").getString(),
            driver = property("aqtHealth.database.driver").getString(),
        ),
        auth = AuthConfig(
            bootstrapClientName = property("aqtHealth.auth.bootstrapClientName").getString(),
            bootstrapApiKey = property("aqtHealth.auth.bootstrapApiKey").getString(),
        ),
    )
