package me.aquitano.health.api

import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.config.MapApplicationConfig
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import me.aquitano.health.shared.AppJson
import java.nio.file.Files
import java.nio.file.Path
import java.sql.DriverManager
import kotlin.test.Test
import kotlin.test.assertEquals

class ProviderStatusRouteTest {
    @Test
    fun providerStatusRequiresAuthentication() = testApplication {
        val dbPath = Files.createTempFile("aqt-health-provider-status-auth-test", ".db")
        configureTestApplication(dbPath)

        val response = client.get("/api/v1/providers/status")

        assertEquals(HttpStatusCode.Unauthorized, response.status)
    }

    @Test
    fun unconfiguredProviderReportsConfigureAction() = testApplication {
        val dbPath = Files.createTempFile("aqt-health-provider-status-unconfigured-test", ".db")
        configureTestApplication(dbPath, googleConfigured = false)

        val response = client.get("/api/v1/providers/google-health/status") {
            authorized()
        }

        assertEquals(HttpStatusCode.OK, response.status)
        val status = response.bodyAsJsonObject()
        assertEquals("google-health", status.string("providerCode"))
        assertEquals("false", status["configured"].toString())
        assertEquals("false", status["connected"].toString())
        assertEquals("false", status["needsAuthentication"].toString())
        assertEquals("false", status["canSync"].toString())
        assertEquals("configure", status.string("nextAction"))
        assertEquals(0, status["accounts"]!!.jsonArray.size)
    }

    @Test
    fun configuredButUnconnectedProviderReportsConnectAction() = testApplication {
        val dbPath = Files.createTempFile("aqt-health-provider-status-unconnected-test", ".db")
        configureTestApplication(dbPath)

        val response = client.get("/api/v1/providers/google-health/status") {
            authorized()
        }

        assertEquals(HttpStatusCode.OK, response.status)
        val status = response.bodyAsJsonObject()
        assertEquals("true", status["configured"].toString())
        assertEquals("false", status["connected"].toString())
        assertEquals("true", status["needsAuthentication"].toString())
        assertEquals("false", status["canSync"].toString())
        assertEquals("connect", status.string("nextAction"))
    }

    @Test
    fun connectedProviderReportsValidAccountAndLastSync() = testApplication {
        val dbPath = Files.createTempFile("aqt-health-provider-status-valid-test", ".db")
        configureTestApplication(dbPath)
        client.get("/api/v1/admin/health")
        insertGoogleAccount(
            dbPath = dbPath,
            expiresAt = "2099-01-01T00:00:00Z",
        )
        insertSyncRun(
            dbPath = dbPath,
            finishedAt = "2026-05-15T11:00:00Z",
        )
        insertSyncRun(
            dbPath = dbPath,
            finishedAt = null,
        )

        val response = client.get("/api/v1/providers/status") {
            authorized()
        }

        assertEquals(HttpStatusCode.OK, response.status)
        val google = response.bodyAsJsonObject()
            .getValue("providers")
            .jsonArray
            .map { it.jsonObject }
            .single { it.string("providerCode") == "google-health" }
        assertEquals("true", google["connected"].toString())
        assertEquals("true", google["canSync"].toString())
        assertEquals("false", google["needsAuthentication"].toString())
        assertEquals("sync", google.string("nextAction"))
        val account = google["accounts"]!!.jsonArray.single().jsonObject
        assertEquals("google-health-me", account.string("providerInstanceId"))
        assertEquals("valid", account.string("tokenStatus"))
        assertEquals("2026-05-15T10:00:00Z", account.string("connectedAt"))
        assertEquals("2026-05-15T11:00:00Z", account.string("lastSyncAt"))
    }

    @Test
    fun connectedExpiredProviderCanStillSyncWithRefreshToken() = testApplication {
        val dbPath = Files.createTempFile("aqt-health-provider-status-expired-test", ".db")
        configureTestApplication(dbPath)
        client.get("/api/v1/admin/health")
        insertGoogleAccount(
            dbPath = dbPath,
            expiresAt = "2000-01-01T00:00:00Z",
        )

        val response = client.get("/api/v1/providers/google_health/status") {
            authorized()
        }

        assertEquals(HttpStatusCode.OK, response.status)
        val status = response.bodyAsJsonObject()
        assertEquals("true", status["connected"].toString())
        assertEquals("true", status["canSync"].toString())
        assertEquals("false", status["needsAuthentication"].toString())
        assertEquals("sync", status.string("nextAction"))
        val account = status["accounts"]!!.jsonArray.single().jsonObject
        assertEquals("expired", account.string("tokenStatus"))
    }

    @Test
    fun unknownProviderStatusReturnsNotFound() = testApplication {
        val dbPath = Files.createTempFile("aqt-health-provider-status-not-found-test", ".db")
        configureTestApplication(dbPath)

        val response = client.get("/api/v1/providers/not-real/status") {
            authorized()
        }

        assertEquals(HttpStatusCode.NotFound, response.status)
    }

    private fun ApplicationTestBuilder.configureTestApplication(
        dbPath: Path,
        googleConfigured: Boolean = true,
    ) {
        val configValues = mutableMapOf(
            "ktor.application.modules.size" to "1",
            "ktor.application.modules.0" to "me.aquitano.health.api.ApplicationKt.module",
            "aqtHealth.database.jdbcUrl" to "jdbc:sqlite:$dbPath",
            "aqtHealth.database.driver" to "org.sqlite.JDBC",
            "aqtHealth.auth.bootstrapClientName" to "test-client",
            "aqtHealth.auth.bootstrapApiKey" to "test-key",
            "aqtHealth.googleHealth.clientId" to "client-id",
            "aqtHealth.googleHealth.redirectUri" to "http://localhost:8080/api/v1/providers/google-health/oauth/callback",
            "aqtHealth.googleHealth.tokenEncryptionKey" to "test-token-encryption-key-with-32-bytes",
            "aqtHealth.googleHealth.apiBaseUrl" to "https://health.googleapis.com",
            "aqtHealth.googleHealth.oauthTokenUrl" to "https://oauth2.googleapis.com/token",
            "aqtHealth.googleHealth.oauthAuthUrl" to "https://accounts.google.com/o/oauth2/v2/auth",
            "aqtHealth.withings.clientId" to "withings-client-id",
            "aqtHealth.withings.clientSecret" to "withings-client-secret",
            "aqtHealth.withings.redirectUri" to "http://localhost:8080/api/v1/providers/withings/oauth/callback",
            "aqtHealth.withings.tokenEncryptionKey" to "test-token-encryption-key-with-32-bytes",
            "aqtHealth.withings.apiBaseUrl" to "https://wbsapi.withings.net",
            "aqtHealth.withings.oauthTokenUrl" to "https://wbsapi.withings.net/v2/oauth2",
            "aqtHealth.withings.oauthAuthUrl" to "https://account.withings.com/oauth2_user/authorize2",
        )
        if (googleConfigured) {
            configValues["aqtHealth.googleHealth.clientSecret"] = "client-secret"
        }
        environment {
            config = MapApplicationConfig(*configValues.map { it.key to it.value }.toTypedArray())
        }
    }

    private fun insertGoogleAccount(dbPath: Path, expiresAt: String) {
        DriverManager.getConnection("jdbc:sqlite:$dbPath").use { connection ->
            connection.createStatement().use { statement ->
                statement.executeUpdate(
                    """
                    INSERT INTO provider_oauth_accounts (
                        provider_code,
                        provider_user_id,
                        provider_instance_id,
                        access_token_ciphertext,
                        refresh_token_ciphertext,
                        token_type,
                        expires_at,
                        scope,
                        created_at,
                        updated_at
                    ) VALUES (
                        'google_health',
                        'google-health-me',
                        'google-health-me',
                        'access-ciphertext',
                        'refresh-ciphertext',
                        'Bearer',
                        '$expiresAt',
                        'scope',
                        '2026-05-15T10:00:00Z',
                        '2026-05-15T10:00:00Z'
                    )
                    """.trimIndent(),
                )
            }
        }
    }

    private fun insertSyncRun(dbPath: Path, finishedAt: String?) {
        DriverManager.getConnection("jdbc:sqlite:$dbPath").use { connection ->
            connection.createStatement().use { statement ->
                statement.executeUpdate(
                    """
                    INSERT INTO provider_sync_runs (
                        provider_code,
                        provider_instance_id,
                        requested_from,
                        requested_to,
                        status,
                        started_at,
                        finished_at,
                        error_message
                    ) VALUES (
                        'google_health',
                        'google-health-me',
                        '2026-05-15T09:00:00Z',
                        '2026-05-15T10:00:00Z',
                        '${if (finishedAt == null) "running" else "processed"}',
                        '2026-05-15T10:30:00Z',
                        ${finishedAt?.let { "'$it'" } ?: "NULL"},
                        NULL
                    )
                    """.trimIndent(),
                )
            }
        }
    }

    private suspend fun HttpResponse.bodyAsJsonObject(): JsonObject =
        AppJson.parseToJsonElement(bodyAsText()).jsonObject

    private fun JsonObject.string(name: String): String =
        getValue(name).jsonPrimitive.content

    private fun io.ktor.client.request.HttpRequestBuilder.authorized() {
        header(HttpHeaders.Authorization, "Bearer test-key")
    }
}
