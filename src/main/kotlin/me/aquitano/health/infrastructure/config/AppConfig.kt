package me.aquitano.health.infrastructure.config

import io.ktor.server.config.*

data class AppConfig(
    val database: DatabaseConfig,
    val auth: AuthConfig,
    val googleHealth: GoogleHealthConfig,
    val withings: WithingsConfig,
)

data class DatabaseConfig(
    val jdbcUrl: String,
    val driver: String,
)

data class AuthConfig(
    val bootstrapClientName: String,
    val bootstrapApiKey: String,
)

data class GoogleHealthConfig(
    val clientId: String,
    val clientSecret: String,
    val redirectUri: String,
    val tokenEncryptionKey: String,
    val apiBaseUrl: String,
    val oauthTokenUrl: String,
    val oauthAuthUrl: String,
)

data class WithingsConfig(
    val clientId: String,
    val clientSecret: String,
    val redirectUri: String,
    val tokenEncryptionKey: String,
    val apiBaseUrl: String,
    val oauthTokenUrl: String,
    val oauthAuthUrl: String,
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
        googleHealth = GoogleHealthConfig(
            clientId = optional("aqtHealth.googleHealth.clientId"),
            clientSecret = optional("aqtHealth.googleHealth.clientSecret"),
            redirectUri = optional(
                "aqtHealth.googleHealth.redirectUri",
                "http://localhost:8080/api/v1/providers/google-health/oauth/callback",
            ),
            tokenEncryptionKey = optional("aqtHealth.googleHealth.tokenEncryptionKey"),
            apiBaseUrl = optional(
                "aqtHealth.googleHealth.apiBaseUrl",
                "https://health.googleapis.com",
            ),
            oauthTokenUrl = optional(
                "aqtHealth.googleHealth.oauthTokenUrl",
                "https://oauth2.googleapis.com/token",
            ),
            oauthAuthUrl = optional(
                "aqtHealth.googleHealth.oauthAuthUrl",
                "https://accounts.google.com/o/oauth2/v2/auth",
            ),
        ),
        withings = WithingsConfig(
            clientId = optional("aqtHealth.withings.clientId"),
            clientSecret = optional("aqtHealth.withings.clientSecret"),
            redirectUri = optional(
                "aqtHealth.withings.redirectUri",
                "http://localhost:8080/api/v1/providers/withings/oauth/callback",
            ),
            tokenEncryptionKey = optional("aqtHealth.withings.tokenEncryptionKey"),
            apiBaseUrl = optional(
                "aqtHealth.withings.apiBaseUrl",
                "https://wbsapi.withings.net",
            ),
            oauthTokenUrl = optional(
                "aqtHealth.withings.oauthTokenUrl",
                "https://wbsapi.withings.net/v2/oauth2",
            ),
            oauthAuthUrl = optional(
                "aqtHealth.withings.oauthAuthUrl",
                "https://account.withings.com/oauth2_user/authorize2",
            ),
        ),
    )

private fun ApplicationConfig.optional(path: String, default: String = ""): String =
    propertyOrNull(path)?.getString() ?: default
