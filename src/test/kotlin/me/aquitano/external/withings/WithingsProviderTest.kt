package me.aquitano.external.withings

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import me.aquitano.health.application.HealthProviderRegistry
import me.aquitano.health.application.IngestionMappingService
import me.aquitano.health.application.IngestionService
import me.aquitano.health.application.ProviderWorkflowService
import me.aquitano.health.application.ProviderStatusService
import me.aquitano.health.application.metric.common.MetricWriteService
import me.aquitano.health.domain.ConflictException
import me.aquitano.health.domain.ProviderSyncRequest
import me.aquitano.health.domain.RequestValidationException
import me.aquitano.health.domain.UpstreamProviderException
import me.aquitano.health.infrastructure.config.DatabaseConfig
import me.aquitano.health.infrastructure.config.WithingsConfig
import me.aquitano.health.infrastructure.database.DatabaseFactory
import me.aquitano.health.infrastructure.repositories.IngestionRepository
import me.aquitano.health.infrastructure.repositories.ProviderOAuthRepository
import me.aquitano.health.infrastructure.repositories.SupportRepository
import me.aquitano.health.infrastructure.security.TokenCipher
import me.aquitano.health.test.NoOpDerivedRebuildExecutor
import me.aquitano.health.test.PostgresTestDatabase
import org.jetbrains.exposed.v1.jdbc.Database
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class WithingsProviderTest {
    @Test
    fun oauthStartUrlContainsWithingsParameters() = runBlocking {
        val fixture = Fixture()
        val start = fixture.providerWorkflowService.startOAuth("withings", fixture.now)

        assertTrue(start.authorizationUrl.startsWith("https://account.withings.com/oauth2_user/authorize2?"))
        assertTrue(start.authorizationUrl.contains("response_type=code"))
        assertTrue(start.authorizationUrl.contains("client_id=client-id"))
        assertTrue(start.authorizationUrl.contains("scope=user.info%2Cuser.metrics%2Cuser.activity"))
        assertTrue(start.authorizationUrl.contains("redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Fapi%2Fv1%2Fproviders%2Fwithings%2Foauth%2Fcallback"))
        assertTrue(start.authorizationUrl.contains("state="))
    }

    @Test
    fun oauthCallbackStoresEncryptedTokens() = runBlocking {
        val fixture = Fixture()
        val start = fixture.providerWorkflowService.startOAuth("withings", fixture.now)
        val state = Regex("state=([^&]+)").find(start.authorizationUrl)!!.groupValues[1]

        val response = fixture.providerWorkflowService.completeOAuth(
            providerCode = "withings",
            code = "auth-code",
            state = state,
            error = null,
            now = fixture.now.plusSeconds(1),
        )

        assertEquals("withings-363", response.providerInstanceId)
        assertEquals("363", singleString(fixture.dbPath, "SELECT provider_user_id FROM provider_oauth_accounts"))
        assertEquals("withings-363", singleString(fixture.dbPath, "SELECT provider_instance_id FROM provider_oauth_accounts"))
        val accessCiphertext = singleString(fixture.dbPath, "SELECT access_token_ciphertext FROM provider_oauth_accounts")
        val refreshCiphertext = singleString(fixture.dbPath, "SELECT refresh_token_ciphertext FROM provider_oauth_accounts")
        assertFalse(accessCiphertext.contains("access-from-code"))
        assertFalse(refreshCiphertext.contains("refresh-from-code"))
        val cipher = TokenCipher(fixture.config.tokenEncryptionKey)
        assertEquals("access-from-code", cipher.decrypt(accessCiphertext))
        assertEquals("refresh-from-code", cipher.decrypt(refreshCiphertext))
    }

    @Test
    fun oauthCallbackMapsTokenExchangeFailureToUpstreamProviderError() = runBlocking {
        val fixture = Fixture()
        val start = fixture.providerWorkflowService.startOAuth("withings", fixture.now)
        val state = Regex("state=([^&]+)").find(start.authorizationUrl)!!.groupValues[1]
        fixture.client.nextExchangeFailure = WithingsHttpException(
            "withings_token_request_failed",
            "Withings OAuth token request failed with 400",
        )

        val error = assertFailsWith<UpstreamProviderException> {
            fixture.providerWorkflowService.completeOAuth(
                providerCode = "withings",
                code = "auth-code",
                state = state,
                error = null,
                now = fixture.now.plusSeconds(1),
            )
        }

        assertEquals("withings_token_request_failed", error.code)
        assertEquals(502, error.statusCode)
    }

    @Test
    fun syncFetchesNormalizesAndIngestsWithingsData() = runBlocking {
        val fixture = Fixture()
        fixture.seedAccount()

        val summary = fixture.provider.sync(
            ProviderSyncRequest(
                from = Instant.parse("2026-04-01T00:00:00Z"),
                to = Instant.parse("2026-04-02T00:00:00Z"),
            ),
            fixture.now,
        )

        assertEquals("processed", summary.status)
        assertEquals(4, summary.batches.size)
        assertEquals(1, countRows(fixture.dbPath, "step_samples"))
        assertEquals(2, countRows(fixture.dbPath, "sleep_sessions"))
        assertEquals(1, countRows(fixture.dbPath, "sleep_stages"))
        assertEquals(4, countRows(fixture.dbPath, "body_measurements"))
        assertEquals(3, countRows(fixture.dbPath, "heart_rate_samples"))
    }

    @Test
    fun syncRefreshesExpiredTokenBeforeFetch() = runBlocking {
        val fixture = Fixture()
        fixture.seedAccount(expiresAt = fixture.now.minusSeconds(1))

        fixture.provider.sync(
            ProviderSyncRequest(
                from = Instant.parse("2026-04-01T00:00:00Z"),
                to = Instant.parse("2026-04-02T00:00:00Z"),
                dataTypes = listOf("activity"),
            ),
            fixture.now,
        )

        assertEquals(1, fixture.client.refreshCalls)
        assertEquals("fresh-access", fixture.client.accessTokensUsed.single())
    }

    @Test
    fun refreshFailureMarksAccountNeedsReauth() = runBlocking {
        val fixture = Fixture()
        fixture.seedAccount(expiresAt = fixture.now.minusSeconds(1))
        fixture.client.nextRefreshFailure = WithingsHttpException(
            "withings_token_request_failed",
            "Withings refresh token is invalid",
            providerStatus = 401,
        )

        val error = assertFailsWith<ConflictException> {
            fixture.provider.sync(
                ProviderSyncRequest(
                    from = Instant.parse("2026-04-01T00:00:00Z"),
                    to = Instant.parse("2026-04-02T00:00:00Z"),
                    dataTypes = listOf("activity"),
                ),
                fixture.now,
            )
        }

        assertEquals("withings_needs_reauth", error.code)
        assertEquals(
            "needs_reauth",
            singleString(fixture.dbPath, "SELECT account_status FROM provider_oauth_accounts"),
        )
        assertEquals(
            "withings_needs_reauth",
            singleString(fixture.dbPath, "SELECT last_auth_error_code FROM provider_oauth_accounts"),
        )
    }

    @Test
    fun temporaryRefreshFailureDoesNotMarkAccountNeedsReauth() = runBlocking {
        val fixture = Fixture()
        fixture.seedAccount(expiresAt = fixture.now.minusSeconds(1))
        fixture.client.nextRefreshFailure = WithingsHttpException(
            "withings_token_request_failed",
            "Withings OAuth token request failed with 503",
            providerStatus = 503,
        )

        val error = assertFailsWith<UpstreamProviderException> {
            fixture.provider.sync(
                ProviderSyncRequest(
                    from = Instant.parse("2026-04-01T00:00:00Z"),
                    to = Instant.parse("2026-04-02T00:00:00Z"),
                    dataTypes = listOf("activity"),
                ),
                fixture.now,
            )
        }

        assertEquals("withings_token_refresh_failed", error.code)
        assertEquals(
            "connected",
            singleString(fixture.dbPath, "SELECT account_status FROM provider_oauth_accounts"),
        )
        assertEquals(
            "withings_token_request_failed",
            singleString(fixture.dbPath, "SELECT last_auth_error_code FROM provider_oauth_accounts"),
        )
    }

    @Test
    fun needsReauthAccountIsNotSelectedForSync() = runBlocking {
        val fixture = Fixture()
        fixture.seedAccount()
        fixture.providerRepository.markNeedsReauth(
            accountId = singleInt(fixture.dbPath, "SELECT id FROM provider_oauth_accounts"),
            errorCode = "withings_needs_reauth",
            errorMessage = "invalid refresh token",
            now = fixture.now,
        )

        val error = assertFailsWith<ConflictException> {
            fixture.provider.sync(
                ProviderSyncRequest(
                    from = Instant.parse("2026-04-01T00:00:00Z"),
                    to = Instant.parse("2026-04-02T00:00:00Z"),
                    dataTypes = listOf("activity"),
                ),
                fixture.now,
            )
        }

        assertEquals("withings_needs_reauth", error.code)
        assertTrue(fixture.client.accessTokensUsed.isEmpty())
    }

    @Test
    fun syncReportsDataTypesWithNoNormalizedRecords() = runBlocking {
        val fixture = Fixture()
        fixture.seedAccount()
        fixture.client.emptyDataTypes += setOf("activity", "sleep")

        val summary = fixture.provider.sync(
            ProviderSyncRequest(
                from = Instant.parse("2026-05-01T00:00:00Z"),
                to = Instant.parse("2026-05-11T00:00:00Z"),
                dataTypes = listOf("activity", "sleep"),
            ),
            fixture.now,
        )

        assertEquals("processed", summary.status)
        assertTrue(summary.batches.isEmpty())
        assertTrue(summary.errors.isEmpty())
        assertEquals(listOf("activity", "sleep"), summary.emptyDataTypes.map { it.dataType })
        assertEquals(1, summary.emptyDataTypes.first().pagesFetched)
        assertEquals(0, summary.emptyDataTypes.first().sourceRecordsReceived)
        assertEquals(0, summary.emptyDataTypes.first().normalizedRecords)
    }

    @Test
    fun syncUsesRequestedProviderInstanceAccount() = runBlocking {
        val fixture = Fixture()
        fixture.seedAccount(
            providerUserId = "363",
            providerInstanceId = "withings-363",
            accessToken = "requested-access",
            refreshToken = "requested-refresh",
            updatedAt = fixture.now,
        )
        fixture.seedAccount(
            providerUserId = "999",
            providerInstanceId = "withings-999",
            accessToken = "latest-access",
            refreshToken = "latest-refresh",
            updatedAt = fixture.now.plusSeconds(1),
        )

        val summary = fixture.provider.sync(
            ProviderSyncRequest(
                providerInstanceId = "withings-363",
                from = Instant.parse("2026-04-01T00:00:00Z"),
                to = Instant.parse("2026-04-02T00:00:00Z"),
                dataTypes = listOf("activity"),
            ),
            fixture.now.plusSeconds(2),
        )

        assertEquals("withings-363", summary.providerInstanceId)
        assertEquals(listOf("requested-access"), fixture.client.accessTokensUsed)
    }

    @Test
    fun syncRejectsUnknownProviderInstanceBeforeFetching() = runBlocking {
        val fixture = Fixture()
        fixture.seedAccount()

        val error = assertFailsWith<ConflictException> {
            fixture.provider.sync(
                ProviderSyncRequest(
                    providerInstanceId = "withings-missing",
                    from = Instant.parse("2026-04-01T00:00:00Z"),
                    to = Instant.parse("2026-04-02T00:00:00Z"),
                    dataTypes = listOf("activity"),
                ),
                fixture.now,
            )
        }

        assertEquals("withings_account_not_found", error.code)
        assertTrue(fixture.client.accessTokensUsed.isEmpty())
    }

    @Test
    fun authRetryPropagatesRefreshedTokenToRemainingDataTypes() = runBlocking {
        val fixture = Fixture()
        fixture.seedAccount()
        fixture.client.failDataRequestsWithAccessToken = "stored-access"
        fixture.client.failuresRemaining = 1

        fixture.provider.sync(
            ProviderSyncRequest(
                from = Instant.parse("2026-04-01T00:00:00Z"),
                to = Instant.parse("2026-04-02T00:00:00Z"),
                dataTypes = listOf("activity", "measures"),
            ),
            fixture.now,
        )

        assertEquals(1, fixture.client.refreshCalls)
        assertEquals(listOf("stored-access", "fresh-access", "fresh-access"), fixture.client.accessTokensUsed)
    }

    @Test
    fun syncReturnsNotConnectedConflictWhenNoAccount() = runBlocking {
        val fixture = Fixture()

        val error = assertFailsWith<ConflictException> {
            fixture.provider.sync(
                ProviderSyncRequest(
                    from = Instant.parse("2026-04-01T00:00:00Z"),
                    to = Instant.parse("2026-04-02T00:00:00Z"),
                ),
                fixture.now,
            )
        }

        assertEquals("withings_not_connected", error.code)
    }

    @Test
    fun unsupportedDataTypeReturnsValidationError() = runBlocking {
        val fixture = Fixture()

        val error = assertFailsWith<RequestValidationException> {
            fixture.provider.sync(
                ProviderSyncRequest(
                    from = Instant.parse("2026-04-01T00:00:00Z"),
                    to = Instant.parse("2026-04-02T00:00:00Z"),
                    dataTypes = listOf("blood-pressure"),
                ),
                fixture.now,
            )
        }

        assertEquals("dataTypes[0]", error.issues.single().field)
    }

    @Test
    fun duplicateProcessedBatchReturnsCachedBatch() = runBlocking {
        val fixture = Fixture()
        fixture.seedAccount()
        val request = ProviderSyncRequest(
            from = Instant.parse("2026-04-01T00:00:00Z"),
            to = Instant.parse("2026-04-02T00:00:00Z"),
            dataTypes = listOf("activity"),
        )

        val first = fixture.provider.sync(request, fixture.now)
        val second = fixture.provider.sync(request, fixture.now.plusSeconds(1))

        assertEquals(1, first.batches.size)
        assertEquals(1, second.batches.size)
        assertTrue(second.batches.single().duplicateBatch)
        assertEquals(1, countRows(fixture.dbPath, "ingestion_batches"))
    }

    @Test
    fun syncChunksLongRangesAndSkipsCachedChunks() = runBlocking {
        val fixture = Fixture()
        fixture.seedAccount()
        val request = ProviderSyncRequest(
            from = Instant.parse("2026-04-01T00:00:00Z"),
            to = Instant.parse("2026-07-01T00:00:00Z"),
            dataTypes = listOf("activity"),
        )

        val first = fixture.provider.sync(request, fixture.now)
        val second = fixture.provider.sync(request, fixture.now.plusSeconds(1))

        assertEquals("2026-04-01T00:00:00Z", first.requestedFrom.toString())
        assertEquals("2026-07-01T00:00:00Z", first.requestedTo.toString())
        assertEquals(3, first.batches.size)
        assertEquals(3, second.batches.size)
        assertTrue(second.batches.all { it.duplicateBatch })
        assertEquals(
            listOf(
                WithingsFetchRequest("activity", Instant.parse("2026-04-01T00:00:00Z"), Instant.parse("2026-05-02T00:00:00Z")),
                WithingsFetchRequest("activity", Instant.parse("2026-05-02T00:00:00Z"), Instant.parse("2026-06-02T00:00:00Z")),
                WithingsFetchRequest("activity", Instant.parse("2026-06-02T00:00:00Z"), Instant.parse("2026-07-01T00:00:00Z")),
            ),
            fixture.client.fetchRequests,
        )
    }

    private class Fixture(
        val dbPath: DatabaseConfig = PostgresTestDatabase.config(),
        val now: Instant = Instant.parse("2026-04-20T10:00:00Z"),
    ) {
        val config = WithingsConfig(
            clientId = "client-id",
            clientSecret = "client-secret",
            redirectUri = "http://localhost:8080/api/v1/providers/withings/oauth/callback",
            tokenEncryptionKey = "test-token-encryption-key-with-32-bytes",
            apiBaseUrl = "https://wbsapi.withings.net",
            oauthTokenUrl = "https://wbsapi.withings.net/v2/oauth2",
            oauthAuthUrl = "https://account.withings.com/oauth2_user/authorize2",
        )
        private val database: Database = DatabaseFactory().initialize(
            dbPath
        )
        val providerRepository = ProviderOAuthRepository(database)
        private val ingestionService = IngestionService(
            database = database,
            mappingService = IngestionMappingService(),
            supportRepository = SupportRepository(database),
            ingestionRepository = IngestionRepository(),
            metricWriteService = MetricWriteService(),
            derivedRebuildExecutor = NoOpDerivedRebuildExecutor,
        )
        val client = FakeWithingsClient()
        val provider = WithingsProvider(
            config = config,
            repository = providerRepository,
            client = client,
            normalizer = WithingsNormalizer(),
            ingestionService = ingestionService,
            syncPipeline = me.aquitano.health.application.providersync.ProviderSyncPipeline(
                accounts = me.aquitano.health.application.providersync.ProviderOAuthSyncAccountPort(
                    providerRepository,
                    config.tokenEncryptionKey,
                ),
                runs = me.aquitano.health.application.providersync.ProviderOAuthSyncRunPort(providerRepository),
                ingestion = me.aquitano.health.application.providersync.IngestionProviderSyncPort(ingestionService),
                currentTime = { now },
            ),
        )
        private val providerRegistry = HealthProviderRegistry(listOf(provider))
        val providerStatusService = ProviderStatusService(
            providerRegistry = providerRegistry,
            providerOAuthRepository = providerRepository,
        )
        val providerWorkflowService = ProviderWorkflowService(
            providerRegistry = providerRegistry,
            providerOAuthRepository = providerRepository,
            providerStatusService = providerStatusService,
        )

        suspend fun seedAccount(
            providerUserId: String = "363",
            providerInstanceId: String = "withings-363",
            accessToken: String = "stored-access",
            refreshToken: String = "stored-refresh",
            expiresAt: Instant = now.plusSeconds(3600),
            updatedAt: Instant = now,
        ) {
            val cipher = TokenCipher(config.tokenEncryptionKey)
            providerRepository.upsertAccount(
                providerCode = WITHINGS_PROVIDER_CODE,
                providerUserId = providerUserId,
                providerInstanceId = providerInstanceId,
                accessTokenCiphertext = cipher.encrypt(accessToken),
                refreshTokenCiphertext = cipher.encrypt(refreshToken),
                tokenType = "Bearer",
                expiresAt = expiresAt,
                scope = "user.info,user.metrics,user.activity",
                now = updatedAt,
            )
        }
    }

    private class FakeWithingsClient : WithingsClient {
        var nextExchangeFailure: WithingsHttpException? = null
        var nextRefreshFailure: WithingsHttpException? = null
        var refreshCalls = 0
        var failDataRequestsWithAccessToken: String? = null
        var failuresRemaining = 0
        val emptyDataTypes = mutableSetOf<String>()
        val accessTokensUsed = mutableListOf<String>()
        val fetchRequests = mutableListOf<WithingsFetchRequest>()

        override suspend fun exchangeCode(code: String, now: Instant): WithingsTokenSet {
            nextExchangeFailure?.let { throw it }
            return WithingsTokenSet(
                providerUserId = "363",
                accessToken = "access-from-code",
                refreshToken = "refresh-from-code",
                tokenType = "Bearer",
                expiresAt = now.plusSeconds(10800),
                scope = "user.info,user.metrics",
            )
        }

        override suspend fun refreshToken(refreshToken: String, now: Instant): WithingsTokenSet {
            refreshCalls += 1
            nextRefreshFailure?.let {
                nextRefreshFailure = null
                throw it
            }
            return WithingsTokenSet(
                providerUserId = "",
                accessToken = "fresh-access",
                refreshToken = refreshToken,
                tokenType = "Bearer",
                expiresAt = now.plusSeconds(10800),
                scope = "user.info,user.metrics,user.activity",
            )
        }

        override suspend fun fetchMeasures(
            accessToken: String,
            from: Instant,
            to: Instant,
            measureTypes: List<Int>,
            category: Int,
        ): WithingsFetchResult {
            accessTokensUsed.add(accessToken)
            fetchRequests.add(WithingsFetchRequest("measures", from, to))
            failDataRequestIfConfigured(accessToken)
            if ("measures" in emptyDataTypes) return emptyFetchResult("measures")
            return WithingsFetchResult(
                dataType = "measures",
                pages = page("measures"),
                records = listOf(
                    buildJsonObject {
                        put("grpid", 100)
                        put("date", 1775001600)
                        putJsonArray("measures") {
                            addMeasure(1, 80136, -3)
                            addMeasure(6, 214, -1)
                            addMeasure(76, 402, -1)
                            addMeasure(170, 9, 0)
                            addMeasure(11, 62, 0)
                        }
                    }
                ),
            )
        }

        override suspend fun fetchActivity(
            accessToken: String,
            from: Instant,
            to: Instant,
            dataFields: List<String>,
        ): WithingsFetchResult {
            accessTokensUsed.add(accessToken)
            fetchRequests.add(WithingsFetchRequest("activity", from, to))
            failDataRequestIfConfigured(accessToken)
            if ("activity" in emptyDataTypes) return emptyFetchResult("activity")
            return WithingsFetchResult(
                dataType = "activity",
                pages = page("activity"),
                records = listOf(
                    buildJsonObject {
                        put("date", "2026-04-01")
                        put("steps", 1234)
                    }
                ),
            )
        }

        override suspend fun fetchSleep(
            accessToken: String,
            from: Instant,
            to: Instant,
            dataFields: List<String>,
        ): WithingsFetchResult {
            accessTokensUsed.add(accessToken)
            fetchRequests.add(WithingsFetchRequest("sleep", from, to))
            failDataRequestIfConfigured(accessToken)
            if ("sleep" in emptyDataTypes) return emptyFetchResult("sleep")
            return WithingsFetchResult(
                dataType = "sleep",
                pages = page("sleep"),
                records = listOf(
                    buildJsonObject {
                        put("timestamp", 1775001600)
                        put("state", 1)
                        put("hr", 58)
                    },
                    buildJsonObject {
                        put("timestamp", 1775005200)
                        put("state", 2)
                        put("hr", 56)
                    },
                ),
            )
        }

        override suspend fun fetchSleepSummary(
            accessToken: String,
            from: Instant,
            to: Instant,
            dataFields: List<String>,
        ): WithingsFetchResult {
            accessTokensUsed.add(accessToken)
            fetchRequests.add(WithingsFetchRequest("sleep-summary", from, to))
            failDataRequestIfConfigured(accessToken)
            if ("sleep-summary" in emptyDataTypes) return emptyFetchResult("sleep-summary")
            return WithingsFetchResult(
                dataType = "sleep-summary",
                pages = page("sleep-summary"),
                records = listOf(
                    buildJsonObject {
                        put("startdate", 1775001600)
                        put("enddate", 1775023200)
                        put("date", "2026-04-01")
                    }
                ),
            )
        }

        private fun failDataRequestIfConfigured(accessToken: String) {
            if (accessToken == failDataRequestsWithAccessToken && failuresRemaining > 0) {
                failuresRemaining -= 1
                throw WithingsHttpException(
                    "withings_data_request_failed",
                    "Withings data request failed with 401",
                    providerStatus = 401,
                )
            }
        }

        private fun emptyFetchResult(dataType: String): WithingsFetchResult =
            WithingsFetchResult(dataType, page(dataType), emptyList())

        private fun page(dataType: String): List<WithingsPage> =
            listOf(
                WithingsPage(
                    endpoint = "https://wbsapi.withings.net/v2/test",
                    action = dataType,
                    pageIndex = 0,
                    payload = buildJsonObject { put("status", 0) },
                )
            )

        private fun kotlinx.serialization.json.JsonArrayBuilder.addMeasure(type: Int, value: Int, unit: Int) {
            add(
                buildJsonObject {
                    put("type", type)
                    put("value", value)
                    put("unit", unit)
                }
            )
        }
    }

    private data class WithingsFetchRequest(
        val dataType: String,
        val from: Instant,
        val to: Instant,
    )
}

private fun singleString(dbPath: DatabaseConfig, sql: String): String =
    PostgresTestDatabase.connection(dbPath).use { connection ->
        connection.createStatement().use { statement ->
            statement.executeQuery(sql).use { resultSet ->
                resultSet.next()
                resultSet.getString(1)
            }
        }
    }

private fun singleInt(dbPath: DatabaseConfig, sql: String): Int =
    PostgresTestDatabase.connection(dbPath).use { connection ->
        connection.createStatement().use { statement ->
            statement.executeQuery(sql).use { resultSet ->
                resultSet.next()
                resultSet.getInt(1)
            }
        }
    }

private fun countRows(dbPath: DatabaseConfig, tableName: String): Int =
    PostgresTestDatabase.connection(dbPath).use { connection ->
        connection.createStatement().use { statement ->
            statement.executeQuery("SELECT COUNT(*) FROM $tableName").use { resultSet ->
                resultSet.next()
                resultSet.getInt(1)
            }
        }
    }
