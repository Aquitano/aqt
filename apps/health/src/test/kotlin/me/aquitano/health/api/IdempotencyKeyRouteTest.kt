package me.aquitano.health.api

import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.config.*
import io.ktor.server.testing.*
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import me.aquitano.health.shared.AppJson
import me.aquitano.health.test.PostgresTestDatabase
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals

class IdempotencyKeyRouteTest {
    @Test
    fun syncJobSameKeyReturnsSameJob() = testApplication {
        configureTestApplication()

        val first = startSyncJob(key = "sync-job-key-1")
        val second = startSyncJob(key = "sync-job-key-1")

        assertEquals(HttpStatusCode.Accepted, first.status)
        assertEquals(HttpStatusCode.Accepted, second.status)
        assertEquals(first.jobId(), second.jobId())
    }

    @Test
    fun syncJobDifferentKeysCreateDistinctJobs() = testApplication {
        configureTestApplication()

        val first = startSyncJob(key = "sync-job-key-a")
        val second = startSyncJob(key = "sync-job-key-b")

        assertNotEquals(first.jobId(), second.jobId())
    }

    @Test
    fun syncJobSameKeyWithDifferentRequestReturnsConflict() = testApplication {
        configureTestApplication()

        val first = startSyncJob(key = "sync-job-key-conflict")
        val second = client.post("/api/v2/providers/google-health/sync-jobs") {
            authorized()
            header("Idempotency-Key", "sync-job-key-conflict")
            contentType(ContentType.Application.Json)
            setBody("""{"from":"2026-04-02T00:00:00Z","to":"2026-04-03T00:00:00Z","dataTypes":["steps"]}""")
        }

        assertEquals(HttpStatusCode.Accepted, first.status)
        assertEquals(HttpStatusCode.Conflict, second.status)
        assertEquals("idempotency_key_conflict", second.errorCode())
    }

    @Test
    fun syncJobWithoutKeyCreatesNewJobEachTime() = testApplication {
        configureTestApplication()

        val first = startSyncJob(key = null)
        val second = startSyncJob(key = null)

        assertEquals(HttpStatusCode.Accepted, first.status)
        assertEquals(HttpStatusCode.Accepted, second.status)
        assertNotEquals(first.jobId(), second.jobId())
    }

    @Test
    fun replaySameKeyReturnsSameJob() = testApplication {
        configureTestApplication()

        val first = client.post("/api/v2/admin/replay") {
            authorized()
            header("Idempotency-Key", "replay-key-1")
            contentType(ContentType.Application.Json)
            setBody("""{"scope":"projections"}""")
        }
        val second = client.post("/api/v2/admin/replay") {
            authorized()
            header("Idempotency-Key", "replay-key-1")
            contentType(ContentType.Application.Json)
            setBody("""{"scope":"projections"}""")
        }

        assertEquals(HttpStatusCode.Accepted, first.status)
        assertEquals(HttpStatusCode.Accepted, second.status)
        assertEquals(first.jobId(), second.jobId())
    }

    @Test
    fun replaySameKeyWithDifferentRequestReturnsConflict() = testApplication {
        configureTestApplication()

        val first = client.post("/api/v2/admin/replay") {
            authorized()
            header("Idempotency-Key", "replay-key-conflict")
            contentType(ContentType.Application.Json)
            setBody("""{"scope":"projections"}""")
        }
        val second = client.post("/api/v2/admin/replay") {
            authorized()
            header("Idempotency-Key", "replay-key-conflict")
            contentType(ContentType.Application.Json)
            setBody("""{"scope":"derived"}""")
        }

        assertEquals(HttpStatusCode.Accepted, first.status)
        assertEquals(HttpStatusCode.Conflict, second.status)
        assertEquals("idempotency_key_conflict", second.errorCode())
    }

    @Test
    fun failedSyncIsNotStoredForKeyReplay() = testApplication {
        configureTestApplication()

        // google-health is not connected in tests, so the synchronous sync fails with 409.
        // The failure must not be cached: the retry hits the provider again instead of
        // replaying a stored response.
        val first = syncNow(key = "sync-key-1")
        val second = syncNow(key = "sync-key-1")

        assertEquals(HttpStatusCode.Conflict, first.status)
        assertEquals(HttpStatusCode.Conflict, second.status)
    }

    private suspend fun ApplicationTestBuilder.startSyncJob(key: String?): HttpResponse =
        client.post("/api/v2/providers/google-health/sync-jobs") {
            authorized()
            if (key != null) {
                header("Idempotency-Key", key)
            }
            contentType(ContentType.Application.Json)
            setBody("""{"from":"2026-04-01T00:00:00Z","to":"2026-04-02T00:00:00Z","dataTypes":["steps"]}""")
        }

    private suspend fun ApplicationTestBuilder.syncNow(key: String): HttpResponse =
        client.post("/api/v2/providers/google-health/sync") {
            authorized()
            header("Idempotency-Key", key)
            contentType(ContentType.Application.Json)
            setBody("""{"from":"2026-04-01T00:00:00Z","to":"2026-04-02T00:00:00Z","dataTypes":["steps"]}""")
        }

    private suspend fun HttpResponse.jobId(): String =
        AppJson.parseToJsonElement(bodyAsText()).jsonObject["jobId"]!!.jsonPrimitive.content

    private suspend fun HttpResponse.errorCode(): String =
        AppJson.parseToJsonElement(bodyAsText()).jsonObject["error"]!!.jsonObject["code"]!!.jsonPrimitive.content

    private fun ApplicationTestBuilder.configureTestApplication() {
        val dbConfig = PostgresTestDatabase.config()
        val configValues = mutableMapOf(
            "ktor.application.modules.size" to "1",
            "ktor.application.modules.0" to "me.aquitano.health.api.ApplicationKt.module",
            "aqtHealth.auth.bootstrapClientName" to "test-client",
            "aqtHealth.auth.bootstrapApiKey" to "test-key",
            "aqtHealth.googleHealth.clientId" to "client-id",
            "aqtHealth.googleHealth.clientSecret" to "client-secret",
            "aqtHealth.googleHealth.redirectUri" to "http://localhost:8080/api/v2/providers/google-health/oauth/callback",
            "aqtHealth.googleHealth.tokenEncryptionKey" to "test-token-encryption-key-with-32-bytes",
            "aqtHealth.googleHealth.apiBaseUrl" to "https://health.googleapis.com",
            "aqtHealth.googleHealth.oauthTokenUrl" to "https://oauth2.googleapis.com/token",
            "aqtHealth.googleHealth.oauthAuthUrl" to "https://accounts.google.com/o/oauth2/v2/auth",
        )
        configValues.putAll(PostgresTestDatabase.ktorConfigEntries(dbConfig).toMap())
        environment {
            config = MapApplicationConfig(*configValues.map { it.key to it.value }.toTypedArray())
        }
    }

    private fun HttpRequestBuilder.authorized() {
        header(HttpHeaders.Authorization, "Bearer test-key")
    }
}
