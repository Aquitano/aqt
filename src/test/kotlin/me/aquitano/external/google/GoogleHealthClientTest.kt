package me.aquitano.external.google

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import me.aquitano.health.infrastructure.config.DatabaseConfig
import me.aquitano.health.infrastructure.config.GoogleHealthConfig
import me.aquitano.health.infrastructure.database.DatabaseFactory
import me.aquitano.health.infrastructure.providers.googlehealth.GOOGLE_HEALTH_PROVIDER_CODE
import me.aquitano.health.infrastructure.providers.googlehealth.GOOGLE_HEALTH_SCOPES
import me.aquitano.health.infrastructure.providers.googlehealth.GoogleHealthFetchResult
import me.aquitano.health.infrastructure.providers.googlehealth.GoogleHealthTokenSet
import me.aquitano.health.infrastructure.repositories.ProviderOAuthRepository
import me.aquitano.health.infrastructure.security.TokenCipher
import org.jetbrains.exposed.sql.Database
import java.nio.file.Files
import java.net.URI
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals

class GoogleHealthClientTest {
    @Test
    fun dataPointsServiceSettingsUseProvidedOAuthAccessToken() {
        val settings = GoogleHealthClient().dataPointsServiceSettings("oauth-access-token")
        val metadata = settings.credentialsProvider
            .credentials
            .getRequestMetadata(URI("https://health.googleapis.com"))

        assertEquals(listOf("Bearer oauth-access-token"), metadata["Authorization"])
    }

    @Test
    fun storedAccessTokenUsesEncryptedTokenFromLatestProviderAccount() = runBlocking {
        val fixture = Fixture()
        fixture.storeAccount(accessToken = "stored-access-token")

        val accessToken = GoogleHealthClient().storedAccessToken(
            config = fixture.config,
            repository = fixture.repository,
            oauthClient = fixture.oauthClient,
            now = fixture.now,
        )

        assertEquals("stored-access-token", accessToken)
        assertEquals(0, fixture.oauthClient.refreshCalls)
    }

    @Test
    fun storedAccessTokenRefreshesExpiredProviderAccount() = runBlocking {
        val fixture = Fixture()
        fixture.storeAccount(
            accessToken = "expired-access-token",
            refreshToken = "stored-refresh-token",
            expiresAt = fixture.now.minusSeconds(1),
        )

        val accessToken = GoogleHealthClient().storedAccessToken(
            config = fixture.config,
            repository = fixture.repository,
            oauthClient = fixture.oauthClient,
            now = fixture.now,
        )

        assertEquals("refreshed-access-token", accessToken)
        assertEquals(1, fixture.oauthClient.refreshCalls)
        assertEquals("stored-refresh-token", fixture.oauthClient.refreshTokens.single())
    }

    private class Fixture {
        val now: Instant = Instant.parse("2026-04-20T10:00:00Z")
        val dbPath = Files.createTempFile("aqt-health-generated-google-client-test", ".db")
        val database: Database = DatabaseFactory().initialize(
            DatabaseConfig("jdbc:sqlite:$dbPath", "org.sqlite.JDBC")
        )
        val config = GoogleHealthConfig(
            clientId = "client-id",
            clientSecret = "client-secret",
            redirectUri = "http://localhost:8080/api/v1/providers/google-health/oauth/callback",
            tokenEncryptionKey = "test-token-encryption-key-with-32-bytes",
            apiBaseUrl = "https://health.googleapis.com",
            oauthTokenUrl = "https://oauth2.googleapis.com/token",
            oauthAuthUrl = "https://accounts.google.com/o/oauth2/v2/auth",
        )
        val repository = ProviderOAuthRepository(database)
        val oauthClient = FakeGoogleHealthOAuthClient()

        suspend fun storeAccount(
            accessToken: String,
            refreshToken: String = "refresh-token",
            expiresAt: Instant = now.plusSeconds(3600),
        ) {
            val cipher = TokenCipher(config.tokenEncryptionKey)
            repository.upsertAccount(
                providerCode = GOOGLE_HEALTH_PROVIDER_CODE,
                providerUserId = "google-user-1",
                providerInstanceId = "google-health-me",
                accessTokenCiphertext = cipher.encrypt(accessToken),
                refreshTokenCiphertext = cipher.encrypt(refreshToken),
                tokenType = "Bearer",
                expiresAt = expiresAt,
                scope = GOOGLE_HEALTH_SCOPES.joinToString(" "),
                now = now,
            )
        }
    }

    private class FakeGoogleHealthOAuthClient : me.aquitano.health.infrastructure.providers.googlehealth.GoogleHealthClient {
        var refreshCalls = 0
        val refreshTokens = mutableListOf<String>()

        override suspend fun exchangeCode(code: String, now: Instant): GoogleHealthTokenSet =
            error("not used")

        override suspend fun refreshToken(refreshToken: String, now: Instant): GoogleHealthTokenSet {
            refreshCalls += 1
            refreshTokens.add(refreshToken)
            return GoogleHealthTokenSet(
                accessToken = "refreshed-access-token",
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
        ): GoogleHealthFetchResult =
            GoogleHealthFetchResult(dataType, emptyList(), emptyList<JsonObject>())
    }
}
