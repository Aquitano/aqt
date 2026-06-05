package me.aquitano.health.infrastructure.config

import io.ktor.server.config.*
import java.net.URI

data class AppConfig(
    val environment: RuntimeEnvironment,
    val database: DatabaseConfig,
    val auth: AuthConfig,
    val googleHealth: GoogleHealthConfig,
    val withings: WithingsConfig,
    val cors: CorsConfig,
    val openObserve: OpenObserveConfig,
)

enum class RuntimeEnvironment {
    LOCAL,
    PRODUCTION;

    val isProduction: Boolean
        get() = this == PRODUCTION

    companion object {
        fun from(value: String): RuntimeEnvironment =
            when (value.trim().lowercase()) {
                "production", "prod" -> PRODUCTION
                else -> LOCAL
            }
    }
}

data class OpenObserveConfig(
    val url: String,
    val org: String,
    val user: String,
    val password: String,
)

data class CorsConfig(
    val origins: List<String>,
)

data class DatabaseConfig(
    val jdbcUrl: String,
    val driver: String,
    val user: String,
    val password: String,
    val maxPoolSize: Int,
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

data class ConfigValidationIssue(
    val path: String,
    val message: String,
)

class AppConfigValidationException(
    val issues: List<ConfigValidationIssue>,
) : IllegalStateException(
    "Invalid production configuration: " +
            issues.joinToString("; ") { "${it.path}: ${it.message}" },
)

fun ApplicationConfig.toAppConfig(): AppConfig =
    AppConfig(
        environment = RuntimeEnvironment.from(optional("aqtHealth.environment", "local")),
        database = DatabaseConfig(
            jdbcUrl = property("aqtHealth.database.jdbcUrl").getString(),
            driver = property("aqtHealth.database.driver").getString(),
            user = property("aqtHealth.database.user").getString(),
            password = property("aqtHealth.database.password").getString(),
            maxPoolSize = property("aqtHealth.database.maxPoolSize").getString()
                .toInt(),
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
        cors = CorsConfig(
            origins = optional("aqtHealth.cors.origins", "http://localhost:3000")
                .split(",")
                .map { it.trim() }
                .filter { it.isNotBlank() },
        ),
        openObserve = OpenObserveConfig(
            url = optional("aqtHealth.openObserve.url"),
            org = optional("aqtHealth.openObserve.org"),
            user = optional("aqtHealth.openObserve.user"),
            password = optional("aqtHealth.openObserve.password"),
        ),
    ).also { it.validateForStartup() }

fun AppConfig.validateForStartup() {
    if (!environment.isProduction) return

    val issues = buildList {
        requireSecret("aqtHealth.auth.bootstrapApiKey", auth.bootstrapApiKey)
        requireValue("aqtHealth.auth.bootstrapClientName", auth.bootstrapClientName)
        if (auth.bootstrapClientName.trim() == "local-admin") {
            add(ConfigValidationIssue("aqtHealth.auth.bootstrapClientName", "must not use the local default"))
        }

        requireValue("aqtHealth.database.jdbcUrl", database.jdbcUrl)
        requireValue("aqtHealth.database.user", database.user)
        requireSecret("aqtHealth.database.password", database.password)
        rejectLocalUrl("aqtHealth.database.jdbcUrl", database.jdbcUrl)
        if (database.user == "aqt_health" || database.password == "aqt_health") {
            add(ConfigValidationIssue("aqtHealth.database", "must not use default compose credentials"))
        }

        validateGoogleHealth(googleHealth)
        validateWithings(withings)
        validateCors(cors)
    }

    if (issues.isNotEmpty()) {
        throw AppConfigValidationException(issues)
    }
}

private fun MutableList<ConfigValidationIssue>.validateGoogleHealth(config: GoogleHealthConfig) {
    requireValue("aqtHealth.googleHealth.clientId", config.clientId)
    requireSecret("aqtHealth.googleHealth.clientSecret", config.clientSecret)
    requireTokenKey("aqtHealth.googleHealth.tokenEncryptionKey", config.tokenEncryptionKey)
    requirePublicHttpsUrl("aqtHealth.googleHealth.redirectUri", config.redirectUri)
    requireHttpsUrl("aqtHealth.googleHealth.apiBaseUrl", config.apiBaseUrl)
    requireHttpsUrl("aqtHealth.googleHealth.oauthTokenUrl", config.oauthTokenUrl)
    requireHttpsUrl("aqtHealth.googleHealth.oauthAuthUrl", config.oauthAuthUrl)
}

private fun MutableList<ConfigValidationIssue>.validateWithings(config: WithingsConfig) {
    requireValue("aqtHealth.withings.clientId", config.clientId)
    requireSecret("aqtHealth.withings.clientSecret", config.clientSecret)
    requireTokenKey("aqtHealth.withings.tokenEncryptionKey", config.tokenEncryptionKey)
    requirePublicHttpsUrl("aqtHealth.withings.redirectUri", config.redirectUri)
    requireHttpsUrl("aqtHealth.withings.apiBaseUrl", config.apiBaseUrl)
    requireHttpsUrl("aqtHealth.withings.oauthTokenUrl", config.oauthTokenUrl)
    requireHttpsUrl("aqtHealth.withings.oauthAuthUrl", config.oauthAuthUrl)
}

private fun MutableList<ConfigValidationIssue>.validateCors(cors: CorsConfig) {
    if (cors.origins.isEmpty()) {
        add(ConfigValidationIssue("aqtHealth.cors.origins", "must include at least one production origin"))
        return
    }
    cors.origins.forEachIndexed { index, origin ->
        val path = "aqtHealth.cors.origins[$index]"
        if (origin == "*") {
            add(ConfigValidationIssue(path, "must not allow wildcard origins in production"))
        } else {
            requirePublicHttpsUrl(path, origin)
        }
    }
}

private fun MutableList<ConfigValidationIssue>.requireValue(path: String, value: String) {
    val trimmed = value.trim()
    if (trimmed.isBlank()) {
        add(ConfigValidationIssue(path, "must not be blank in production"))
    } else if (isPlaceholder(trimmed)) {
        add(ConfigValidationIssue(path, "must not use a placeholder value in production"))
    }
}

private fun MutableList<ConfigValidationIssue>.requireSecret(path: String, value: String) {
    requireValue(path, value)
}

private fun MutableList<ConfigValidationIssue>.requireTokenKey(path: String, value: String) {
    requireSecret(path, value)
    if (value.toByteArray(Charsets.UTF_8).size < 32) {
        add(ConfigValidationIssue(path, "must be at least 32 bytes"))
    }
}

private fun MutableList<ConfigValidationIssue>.requireHttpsUrl(path: String, value: String) {
    requireValue(path, value)
    val uri = value.toUriOrNull()
    if (uri == null || uri.scheme != "https" || uri.host.isNullOrBlank()) {
        add(ConfigValidationIssue(path, "must be an absolute HTTPS URL"))
    }
}

private fun MutableList<ConfigValidationIssue>.requirePublicHttpsUrl(path: String, value: String) {
    requireHttpsUrl(path, value)
    val host = value.toUriOrNull()?.host ?: return
    if (host.isLocalOrPrivateHost()) {
        add(ConfigValidationIssue(path, "must be a public production URL"))
    }
}

private fun MutableList<ConfigValidationIssue>.rejectLocalUrl(path: String, value: String) {
    val host = jdbcHost(value) ?: value.toUriOrNull()?.host ?: return
    if (host.isLocalHost()) {
        add(ConfigValidationIssue(path, "must not point at localhost in production"))
    }
}

private fun isPlaceholder(value: String): Boolean {
    val normalized = value.lowercase()
    return listOf(
        "replace-with",
        "placeholder",
        "changeme",
        "change-me",
        "example.",
        "example-",
        "local-dev",
    ).any { it in normalized }
}

private fun String.toUriOrNull(): URI? =
    runCatching { URI(this) }.getOrNull()

private fun jdbcHost(jdbcUrl: String): String? =
    Regex("""^jdbc:[a-z0-9]+://([^/:?]+)""", RegexOption.IGNORE_CASE)
        .find(jdbcUrl)
        ?.groupValues
        ?.get(1)

private fun String.isLocalOrPrivateHost(): Boolean {
    val host = trim().trim('[', ']').lowercase()
    if (host.isLocalHost()) return true
    val parts = host.split(".").mapNotNull { it.toIntOrNull() }
    if (parts.size != 4) return false
    val first = parts[0]
    val second = parts[1]
    return first == 10 ||
            first == 127 ||
            (first == 172 && second in 16..31) ||
            (first == 192 && second == 168) ||
            (first == 169 && second == 254)
}

private fun String.isLocalHost(): Boolean {
    val host = trim().trim('[', ']').lowercase()
    if (host == "localhost" || host.endsWith(".localhost")) return true
    if (host == "::1") return true
    val parts = host.split(".").mapNotNull { it.toIntOrNull() }
    return parts.size == 4 && parts[0] == 127
}

private fun ApplicationConfig.optional(
    path: String,
    default: String = ""
): String =
    propertyOrNull(path)?.getString() ?: default
