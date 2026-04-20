package me.aquitano.health.infrastructure.providers.googlehealth

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import me.aquitano.health.application.IngestionMappingService
import me.aquitano.health.application.IngestionService
import me.aquitano.health.application.StepSummaryService
import me.aquitano.health.api.dto.GoogleHealthSyncRequest
import me.aquitano.health.domain.UpstreamProviderException
import me.aquitano.health.infrastructure.config.DatabaseConfig
import me.aquitano.health.infrastructure.config.GoogleHealthConfig
import me.aquitano.health.infrastructure.database.DatabaseFactory
import me.aquitano.health.infrastructure.repositories.IngestionRepository
import me.aquitano.health.infrastructure.repositories.MetricsWriteRepository
import me.aquitano.health.infrastructure.repositories.ProviderOAuthRepository
import me.aquitano.health.infrastructure.repositories.SupportRepository
import me.aquitano.health.infrastructure.security.TokenCipher
import org.jetbrains.exposed.sql.Database
import java.nio.file.Files
import java.nio.file.Path
import java.sql.DriverManager
import java.time.Instant
import kotlin.test.*

class GoogleHealthProviderTest {
    @Test
    fun oauthCallbackStoresEncryptedTokens() = runBlocking {
        val fixture = Fixture()
        val now = Instant.parse("2026-04-20T10:00:00Z")
        val start = fixture.oauthService.start(now)

        val state = Regex("state=([^&]+)").find(start.authorizationUrl)!!.groupValues[1]
        val response = fixture.oauthService.callback(
            code = "auth-code",
            state = state,
            error = null,
            now = now.plusSeconds(1),
        )

        assertEquals("google-health-me", response.providerInstanceId)
        val accessCiphertext = singleString(
            fixture.dbPath,
            "SELECT access_token_ciphertext FROM provider_oauth_accounts"
        )
        val refreshCiphertext = singleString(
            fixture.dbPath,
            "SELECT refresh_token_ciphertext FROM provider_oauth_accounts"
        )
        assertFalse(accessCiphertext.contains("access-from-code"))
        assertFalse(refreshCiphertext.contains("refresh-from-code"))
        val cipher = TokenCipher(fixture.config.tokenEncryptionKey)
        assertEquals("access-from-code", cipher.decrypt(accessCiphertext))
        assertEquals("refresh-from-code", cipher.decrypt(refreshCiphertext))
    }

    @Test
    fun oauthCallbackMapsTokenExchangeFailureToUpstreamProviderError() = runBlocking {
        val fixture = Fixture()
        val now = Instant.parse("2026-04-20T10:00:00Z")
        val start = fixture.oauthService.start(now)
        val state = Regex("state=([^&]+)").find(start.authorizationUrl)!!.groupValues[1]
        fixture.client.nextExchangeFailure = GoogleHealthHttpException(
            "google_health_token_exchange_failed",
            "Google OAuth token request failed with 400",
        )

        val error = assertFailsWith<UpstreamProviderException> {
            fixture.oauthService.callback(
                code = "auth-code",
                state = state,
                error = null,
                now = now.plusSeconds(1),
            )
        }

        assertEquals("google_health_token_exchange_failed", error.code)
        assertEquals(502, error.statusCode)
    }

    @Test
    fun syncIngestsExistingMetricTypesAndIsIdempotent() = runBlocking {
        val fixture = Fixture()
        fixture.storeAccount(accessToken = "access-token", refreshToken = "refresh-token")
        fixture.client.fetchResults += allMetricFetchResults()

        val request = GoogleHealthSyncRequest(
            from = "2026-04-01T00:00:00Z",
            to = "2026-04-02T00:00:00Z",
        )
        val first = fixture.syncService.sync(request, fixture.now)
        fixture.client.fetchResults += allMetricFetchResults()
        val second = fixture.syncService.sync(request, fixture.now.plusSeconds(60))

        assertEquals(5, first.batches.size)
        assertEquals(5, second.batches.size)
        assertTrue(second.batches.all { it.duplicateBatch })
        assertEquals(1, countRows(fixture.dbPath, "step_samples"))
        assertEquals(1, countRows(fixture.dbPath, "sleep_sessions"))
        assertEquals(2, countRows(fixture.dbPath, "sleep_stages"))
        assertEquals(1, countRows(fixture.dbPath, "heart_rate_samples"))
        assertEquals(2, countRows(fixture.dbPath, "body_measurements"))
    }

    @Test
    fun syncRefreshesExpiredTokenAndRetriesUnauthorizedFetch() = runBlocking {
        val fixture = Fixture()
        fixture.storeAccount(
            accessToken = "expired-access",
            refreshToken = "refresh-token",
            expiresAt = fixture.now.minusSeconds(1),
        )
        fixture.client.refreshedAccessToken = "fresh-access"
        fixture.client.throwUnauthorizedOnce = true
        fixture.client.fetchResults += listOf(stepsFetchResult())

        val response = fixture.syncService.sync(
            GoogleHealthSyncRequest(
                from = "2026-04-01T00:00:00Z",
                to = "2026-04-02T00:00:00Z",
                dataTypes = listOf("steps"),
            ),
            fixture.now,
        )

        assertEquals(1, response.batches.size)
        assertEquals(2, fixture.client.refreshCalls)
        assertEquals(listOf("fresh-access", "fresh-access"), fixture.client.fetchAccessTokens)
        val accessCiphertext = singleString(
            fixture.dbPath,
            "SELECT access_token_ciphertext FROM provider_oauth_accounts"
        )
        assertEquals("fresh-access", TokenCipher(fixture.config.tokenEncryptionKey).decrypt(accessCiphertext))
    }

    @Test
    fun syncRecordsFailedRunForUpstreamFailure() = runBlocking {
        val fixture = Fixture()
        fixture.storeAccount(accessToken = "access-token", refreshToken = "refresh-token")
        fixture.client.nextFetchFailure = GoogleHealthHttpException(
            "google_health_upstream_failed",
            "Google Health failed with 429",
        )

        assertFailsWith<UpstreamProviderException> {
            fixture.syncService.sync(
                GoogleHealthSyncRequest(
                    from = "2026-04-01T00:00:00Z",
                    to = "2026-04-02T00:00:00Z",
                    dataTypes = listOf("steps"),
                ),
                fixture.now,
            )
        }
        assertEquals("failed", singleString(fixture.dbPath, "SELECT status FROM provider_sync_runs"))
    }

    private class Fixture {
        val dbPath: Path = Files.createTempFile("aqt-health-google-provider-test", ".db")
        val database: Database = DatabaseFactory().initialize(
            DatabaseConfig("jdbc:sqlite:$dbPath", "org.sqlite.JDBC")
        )
        val now: Instant = Instant.parse("2026-04-20T10:00:00Z")
        val config = GoogleHealthConfig(
            clientId = "client-id",
            clientSecret = "client-secret",
            redirectUri = "http://localhost:8080/api/v1/providers/google-health/oauth/callback",
            tokenEncryptionKey = "test-token-encryption-key-with-32-bytes",
            apiBaseUrl = "https://health.googleapis.com",
            oauthTokenUrl = "https://oauth2.googleapis.com/token",
            oauthAuthUrl = "https://accounts.google.com/o/oauth2/v2/auth",
        )
        val providerRepository = ProviderOAuthRepository(database)
        val client = FakeGoogleHealthClient()
        val ingestionService = IngestionService(
            database = database,
            mappingService = IngestionMappingService(),
            supportRepository = SupportRepository(database),
            ingestionRepository = IngestionRepository(),
            metricsWriteRepository = MetricsWriteRepository(),
            stepSummaryService = StepSummaryService(MetricsWriteRepository()),
        )
        val oauthService = GoogleHealthOAuthService(config, providerRepository, client)
        val syncService = GoogleHealthSyncService(
            config = config,
            repository = providerRepository,
            client = client,
            normalizer = GoogleHealthNormalizer(),
            ingestionService = ingestionService,
        )

        suspend fun storeAccount(
            accessToken: String,
            refreshToken: String,
            expiresAt: Instant = now.plusSeconds(3600),
        ) {
            val cipher = TokenCipher(config.tokenEncryptionKey)
            providerRepository.upsertAccount(
                providerCode = GOOGLE_HEALTH_PROVIDER_CODE,
                providerUserId = "google-user-1",
                providerInstanceId = "google-user-1",
                accessTokenCiphertext = cipher.encrypt(accessToken),
                refreshTokenCiphertext = cipher.encrypt(refreshToken),
                tokenType = "Bearer",
                expiresAt = expiresAt,
                scope = GOOGLE_HEALTH_SCOPES.joinToString(" "),
                now = now,
            )
        }
    }

    private class FakeGoogleHealthClient : GoogleHealthClient {
        val fetchResults = ArrayDeque<List<GoogleHealthFetchResult>>()
        val fetchAccessTokens = mutableListOf<String>()
        var refreshedAccessToken = "new-access"
        var refreshCalls = 0
        var throwUnauthorizedOnce = false
        var nextExchangeFailure: RuntimeException? = null
        var nextFetchFailure: RuntimeException? = null

        override suspend fun exchangeCode(code: String, now: Instant): GoogleHealthTokenSet {
            nextExchangeFailure?.let {
                nextExchangeFailure = null
                throw it
            }
            return GoogleHealthTokenSet(
                accessToken = "access-from-code",
                refreshToken = "refresh-from-code",
                tokenType = "Bearer",
                expiresAt = now.plusSeconds(3600),
                scope = GOOGLE_HEALTH_SCOPES.joinToString(" "),
            )
        }

        override suspend fun refreshToken(refreshToken: String, now: Instant): GoogleHealthTokenSet {
            refreshCalls += 1
            return GoogleHealthTokenSet(
                accessToken = refreshedAccessToken,
                refreshToken = refreshToken,
                tokenType = "Bearer",
                expiresAt = now.plusSeconds(3600),
                scope = GOOGLE_HEALTH_SCOPES.joinToString(" "),
            )
        }

        override suspend fun fetchDataPoints(
            accessToken: String,
            dataType: String,
            from: Instant,
            to: Instant,
            pageSize: Int,
        ): GoogleHealthFetchResult {
            fetchAccessTokens.add(accessToken)
            nextFetchFailure?.let {
                nextFetchFailure = null
                throw it
            }
            if (throwUnauthorizedOnce) {
                throwUnauthorizedOnce = false
                throw GoogleHealthUnauthorizedException("unauthorized")
            }
            val next = fetchResults.first()
            val result = next.first { it.dataType == dataType }
            if (dataType == next.last().dataType) fetchResults.removeFirst()
            return result
        }
    }

    private fun allMetricFetchResults(): List<GoogleHealthFetchResult> =
        listOf(
            stepsFetchResult(),
            fetchResult("sleep", sleepPoint()),
            fetchResult("heart-rate", heartRatePoint()),
            fetchResult("weight", weightPoint()),
            fetchResult("body-fat", bodyFatPoint()),
        )

    private fun stepsFetchResult(): GoogleHealthFetchResult = fetchResult("steps", stepsPoint())

    private fun fetchResult(dataType: String, point: JsonObject): GoogleHealthFetchResult {
        val payload = buildJsonObject {
            put("dataPoints", JsonArray(listOf(point)))
            put("nextPageToken", "")
        }
        return GoogleHealthFetchResult(
            dataType = dataType,
            pages = listOf(GoogleHealthPage(dataType, 0, payload)),
            dataPoints = listOf(point),
        )
    }

    private fun stepsPoint(): JsonObject = buildJsonObject {
        put("name", "google-steps-1")
        putJsonObject("steps") {
            putJsonObject("interval") {
                put("startTime", "2026-04-01T08:00:00Z")
                put("endTime", "2026-04-01T09:00:00Z")
            }
            put("count", "1200")
        }
    }

    private fun sleepPoint(): JsonObject = buildJsonObject {
        put("name", "google-sleep-1")
        putJsonObject("sleep") {
            putJsonObject("interval") {
                put("startTime", "2026-03-31T22:00:00Z")
                put("endTime", "2026-04-01T06:00:00Z")
            }
            putJsonArray("stages") {
                add(buildJsonObject {
                    put("type", "LIGHT")
                    put("startTime", "2026-03-31T22:00:00Z")
                    put("endTime", "2026-04-01T01:00:00Z")
                })
                add(buildJsonObject {
                    put("type", "REM")
                    put("startTime", "2026-04-01T01:00:00Z")
                    put("endTime", "2026-04-01T02:00:00Z")
                })
            }
        }
    }

    private fun heartRatePoint(): JsonObject = buildJsonObject {
        put("name", "google-hr-1")
        putJsonObject("heartRate") {
            putJsonObject("sampleTime") {
                put("physicalTime", "2026-04-01T08:30:00Z")
            }
            put("beatsPerMinute", "62")
            putJsonObject("metadata") {
                put("motionContext", "SEDENTARY")
            }
        }
    }

    private fun weightPoint(): JsonObject = buildJsonObject {
        put("name", "google-weight-1")
        putJsonObject("weight") {
            putJsonObject("sampleTime") {
                put("physicalTime", "2026-04-01T07:00:00Z")
            }
            put("weightGrams", 82400.0)
        }
    }

    private fun bodyFatPoint(): JsonObject = buildJsonObject {
        put("name", "google-body-fat-1")
        putJsonObject("bodyFat") {
            putJsonObject("sampleTime") {
                put("physicalTime", "2026-04-01T07:00:00Z")
            }
            put("percentage", 18.2)
        }
    }

    private fun countRows(dbPath: Path, tableName: String): Int =
        singleInt(dbPath, "SELECT COUNT(*) FROM $tableName")

    private fun singleInt(dbPath: Path, sql: String): Int =
        DriverManager.getConnection("jdbc:sqlite:$dbPath").use { connection ->
            connection.createStatement().use { statement ->
                statement.executeQuery(sql).use { resultSet ->
                    resultSet.next()
                    resultSet.getInt(1)
                }
            }
        }

    private fun singleString(dbPath: Path, sql: String): String =
        DriverManager.getConnection("jdbc:sqlite:$dbPath").use { connection ->
            connection.createStatement().use { statement ->
                statement.executeQuery(sql).use { resultSet ->
                    resultSet.next()
                    resultSet.getString(1)
                }
            }
        }
}
