package me.aquitano.health.infrastructure.repositories

import kotlinx.coroutines.runBlocking
import me.aquitano.health.infrastructure.database.DatabaseFactory
import me.aquitano.health.infrastructure.config.DatabaseConfig
import me.aquitano.health.test.PostgresTestDatabase
import org.jetbrains.exposed.v1.jdbc.Database
import org.jetbrains.exposed.v1.jdbc.transactions.transaction
import java.time.Instant
import java.time.OffsetDateTime
import kotlin.test.*

class ProviderOAuthRepositoryTest {
    private val now = Instant.parse("2026-05-15T10:00:00Z")
    private val later = Instant.parse("2026-05-15T11:00:00Z")

    @Test
    fun upsertAccountInsertsNewConnectedAccount() = runBlocking {
        val db = freshDatabase()
        val repo = ProviderOAuthRepository(db)

        repo.upsertAccount(
            providerCode = "google_health",
            providerUserId = "user-1",
            providerInstanceId = "google-health-user-1",
            accessTokenCiphertext = "enc-access",
            refreshTokenCiphertext = "enc-refresh",
            tokenType = "Bearer",
            expiresAt = Instant.parse("2099-01-01T00:00:00Z"),
            scope = "health.read",
            now = now,
        )

        val account = repo.accountByProviderInstanceForStatus("google_health", "google-health-user-1")
        assertNotNull(account)
        assertEquals(ACCOUNT_STATUS_CONNECTED, account.accountStatus)
        assertEquals("enc-access", account.accessTokenCiphertext)
        assertEquals("enc-refresh", account.refreshTokenCiphertext)
        assertEquals(now, account.connectedAt)
        assertNull(account.disconnectedAt)
        assertNull(account.lastTokenRefreshAt)
        assertNull(account.lastAuthErrorCode)
    }

    @Test
    fun upsertAccountReconnectsDisconnectedAccount() = runBlocking {
        val db = freshDatabase()
        val repo = ProviderOAuthRepository(db)

        repo.upsertAccount(
            providerCode = "google_health",
            providerUserId = "user-1",
            providerInstanceId = "google-health-user-1",
            accessTokenCiphertext = "enc-access",
            refreshTokenCiphertext = "enc-refresh",
            tokenType = "Bearer",
            expiresAt = Instant.parse("2099-01-01T00:00:00Z"),
            scope = "health.read",
            now = now,
        )
        repo.disconnectAccount("google_health", "google-health-user-1", now)

        repo.upsertAccount(
            providerCode = "google_health",
            providerUserId = "user-1",
            providerInstanceId = "google-health-user-1",
            accessTokenCiphertext = "new-access",
            refreshTokenCiphertext = "new-refresh",
            tokenType = "Bearer",
            expiresAt = Instant.parse("2099-01-01T00:00:00Z"),
            scope = "health.read",
            now = later,
        )

        val account = repo.accountByProviderInstanceForStatus("google_health", "google-health-user-1")
        assertNotNull(account)
        assertEquals(ACCOUNT_STATUS_CONNECTED, account.accountStatus)
        assertEquals("new-access", account.accessTokenCiphertext)
        assertEquals(later, account.connectedAt)
        assertNull(account.disconnectedAt)
        assertNull(account.lastAuthErrorCode)
    }

    @Test
    fun upsertAccountReconnectsNeedsReauthAccount() = runBlocking {
        val db = freshDatabase()
        val repo = ProviderOAuthRepository(db)

        repo.upsertAccount(
            providerCode = "google_health",
            providerUserId = "user-1",
            providerInstanceId = "google-health-user-1",
            accessTokenCiphertext = "enc-access",
            refreshTokenCiphertext = "enc-refresh",
            tokenType = "Bearer",
            expiresAt = Instant.parse("2099-01-01T00:00:00Z"),
            scope = "health.read",
            now = now,
        )
        repo.markNeedsReauth(1, "test_error", "Test error message", now)

        repo.upsertAccount(
            providerCode = "google_health",
            providerUserId = "user-1",
            providerInstanceId = "google-health-user-1",
            accessTokenCiphertext = "new-access",
            refreshTokenCiphertext = "new-refresh",
            tokenType = "Bearer",
            expiresAt = Instant.parse("2099-01-01T00:00:00Z"),
            scope = "health.read",
            now = later,
        )

        val account = repo.accountByProviderInstanceForStatus("google_health", "google-health-user-1")
        assertNotNull(account)
        assertEquals(ACCOUNT_STATUS_CONNECTED, account.accountStatus)
        assertEquals(later, account.connectedAt)
        assertNull(account.lastAuthErrorCode)
    }

    @Test
    fun disconnectAccountClearsTokensAndSetsStatus() = runBlocking {
        val db = freshDatabase()
        val repo = ProviderOAuthRepository(db)

        repo.upsertAccount(
            providerCode = "google_health",
            providerUserId = "user-1",
            providerInstanceId = "google-health-user-1",
            accessTokenCiphertext = "enc-access",
            refreshTokenCiphertext = "enc-refresh",
            tokenType = "Bearer",
            expiresAt = Instant.parse("2099-01-01T00:00:00Z"),
            scope = "health.read",
            now = now,
        )

        val result = repo.disconnectAccount("google_health", "google-health-user-1", later)
        assertTrue(result)

        val account = repo.accountByProviderInstanceForStatus("google_health", "google-health-user-1")
        assertNotNull(account)
        assertEquals(ACCOUNT_STATUS_DISCONNECTED, account.accountStatus)
        assertEquals("", account.accessTokenCiphertext)
        assertEquals("", account.refreshTokenCiphertext)
        assertEquals(later, account.disconnectedAt)
        assertNull(account.lastTokenRefreshAt)
        assertNull(account.lastTokenRefreshStatus)
        assertNull(account.lastAuthErrorCode)
        assertNull(account.lastAuthErrorMessage)
    }

    @Test
    fun disconnectAccountReturnsFalseForUnknownInstance() = runBlocking {
        val db = freshDatabase()
        val repo = ProviderOAuthRepository(db)

        val result = repo.disconnectAccount("google_health", "nonexistent", now)
        assertFalse(result)
    }

    @Test
    fun markNeedsReauthSetsStatusAndErrorCode() = runBlocking {
        val db = freshDatabase()
        val repo = ProviderOAuthRepository(db)

        repo.upsertAccount(
            providerCode = "google_health",
            providerUserId = "user-1",
            providerInstanceId = "google-health-user-1",
            accessTokenCiphertext = "enc-access",
            refreshTokenCiphertext = "enc-refresh",
            tokenType = "Bearer",
            expiresAt = Instant.parse("2099-01-01T00:00:00Z"),
            scope = "health.read",
            now = now,
        )
        val accountId = repo.accountByProviderInstanceForStatus("google_health", "google-health-user-1")!!.id

        repo.markNeedsReauth(accountId, "google_health_needs_reauth", "Consent was revoked", later)

        val account = repo.accountByProviderInstanceForStatus("google_health", "google-health-user-1")
        assertNotNull(account)
        assertEquals(ACCOUNT_STATUS_NEEDS_REAUTH, account.accountStatus)
        assertEquals(later, account.lastTokenRefreshAt)
        assertEquals(TOKEN_REFRESH_STATUS_FAILED, account.lastTokenRefreshStatus)
        assertEquals("google_health_needs_reauth", account.lastAuthErrorCode)
        assertEquals("Consent was revoked", account.lastAuthErrorMessage)
    }

    @Test
    fun markNeedsReauthTruncatesLongErrorFields() = runBlocking {
        val db = freshDatabase()
        val repo = ProviderOAuthRepository(db)

        repo.upsertAccount(
            providerCode = "google_health",
            providerUserId = "user-1",
            providerInstanceId = "google-health-user-1",
            accessTokenCiphertext = "enc-access",
            refreshTokenCiphertext = "enc-refresh",
            tokenType = "Bearer",
            expiresAt = Instant.parse("2099-01-01T00:00:00Z"),
            scope = "health.read",
            now = now,
        )
        val accountId = repo.accountByProviderInstanceForStatus("google_health", "google-health-user-1")!!.id

        val longCode = "x".repeat(300)
        val longMessage = "y".repeat(2000)
        repo.markNeedsReauth(accountId, longCode, longMessage, later)

        val account = repo.accountByProviderInstanceForStatus("google_health", "google-health-user-1")!!
        assertEquals(200, account.lastAuthErrorCode!!.length)
        assertEquals(1000, account.lastAuthErrorMessage!!.length)
    }

    @Test
    fun markTokenRefreshFailedRecordsErrorWithoutChangingStatus() = runBlocking {
        val db = freshDatabase()
        val repo = ProviderOAuthRepository(db)

        repo.upsertAccount(
            providerCode = "google_health",
            providerUserId = "user-1",
            providerInstanceId = "google-health-user-1",
            accessTokenCiphertext = "enc-access",
            refreshTokenCiphertext = "enc-refresh",
            tokenType = "Bearer",
            expiresAt = Instant.parse("2099-01-01T00:00:00Z"),
            scope = "health.read",
            now = now,
        )
        val accountId = repo.accountByProviderInstanceForStatus("google_health", "google-health-user-1")!!.id

        repo.markTokenRefreshFailed(accountId, "transient_error", "Network timeout", later)

        val account = repo.accountByProviderInstanceForStatus("google_health", "google-health-user-1")
        assertNotNull(account)
        assertEquals(ACCOUNT_STATUS_CONNECTED, account.accountStatus, "status should remain connected")
        assertEquals(later, account.lastTokenRefreshAt)
        assertEquals(TOKEN_REFRESH_STATUS_FAILED, account.lastTokenRefreshStatus)
        assertEquals("transient_error", account.lastAuthErrorCode)
        assertEquals("Network timeout", account.lastAuthErrorMessage)
    }

    @Test
    fun updateAccessTokenResetsToConnectedAndClearsErrors() = runBlocking {
        val db = freshDatabase()
        val repo = ProviderOAuthRepository(db)

        repo.upsertAccount(
            providerCode = "google_health",
            providerUserId = "user-1",
            providerInstanceId = "google-health-user-1",
            accessTokenCiphertext = "old-access",
            refreshTokenCiphertext = "old-refresh",
            tokenType = "Bearer",
            expiresAt = Instant.parse("2026-05-15T09:00:00Z"),
            scope = "health.read",
            now = now,
        )
        val accountId = repo.accountByProviderInstanceForStatus("google_health", "google-health-user-1")!!.id
        repo.markNeedsReauth(accountId, "some_error", "some message", now)

        repo.updateAccessToken(
            accountId = accountId,
            accessTokenCiphertext = "new-access",
            refreshTokenCiphertext = "new-refresh",
            tokenType = "Bearer",
            expiresAt = Instant.parse("2099-01-01T00:00:00Z"),
            scope = "health.read",
            now = later,
        )

        val account = repo.accountByProviderInstanceForStatus("google_health", "google-health-user-1")
        assertNotNull(account)
        assertEquals(ACCOUNT_STATUS_CONNECTED, account.accountStatus)
        assertEquals("new-access", account.accessTokenCiphertext)
        assertEquals("new-refresh", account.refreshTokenCiphertext)
        assertEquals(later, account.lastTokenRefreshAt)
        assertEquals(TOKEN_REFRESH_STATUS_SUCCESS, account.lastTokenRefreshStatus)
        assertNull(account.lastAuthErrorCode)
        assertNull(account.lastAuthErrorMessage)
    }

    @Test
    fun latestAccountExcludesDisconnectedAndNeedsReauth() = runBlocking {
        val db = freshDatabase()
        val repo = ProviderOAuthRepository(db)

        repo.upsertAccount(
            providerCode = "google_health",
            providerUserId = "user-1",
            providerInstanceId = "google-health-user-1",
            accessTokenCiphertext = "enc-access",
            refreshTokenCiphertext = "enc-refresh",
            tokenType = "Bearer",
            expiresAt = Instant.parse("2099-01-01T00:00:00Z"),
            scope = "health.read",
            now = now,
        )

        assertNotNull(repo.latestAccount("google_health"))

        repo.disconnectAccount("google_health", "google-health-user-1", later)
        assertNull(repo.latestAccount("google_health"))
    }

    @Test
    fun latestAccountExcludesNeedsReauth() = runBlocking {
        val db = freshDatabase()
        val repo = ProviderOAuthRepository(db)

        repo.upsertAccount(
            providerCode = "google_health",
            providerUserId = "user-1",
            providerInstanceId = "google-health-user-1",
            accessTokenCiphertext = "enc-access",
            refreshTokenCiphertext = "enc-refresh",
            tokenType = "Bearer",
            expiresAt = Instant.parse("2099-01-01T00:00:00Z"),
            scope = "health.read",
            now = now,
        )
        val accountId = repo.accountByProviderInstanceForStatus("google_health", "google-health-user-1")!!.id
        repo.markNeedsReauth(accountId, "error", "msg", later)

        assertNull(repo.latestAccount("google_health"))
    }

    @Test
    fun latestAccountExcludesEmptyTokens() = runBlocking {
        val db = freshDatabase()
        val repo = ProviderOAuthRepository(db)

        repo.upsertAccount(
            providerCode = "google_health",
            providerUserId = "user-1",
            providerInstanceId = "google-health-user-1",
            accessTokenCiphertext = "",
            refreshTokenCiphertext = "",
            tokenType = "Bearer",
            expiresAt = Instant.parse("2099-01-01T00:00:00Z"),
            scope = "health.read",
            now = now,
        )

        assertNull(repo.latestAccount("google_health"))
    }

    @Test
    fun accountsByProviderIncludesDisconnectedByDefault() = runBlocking {
        val db = freshDatabase()
        val repo = ProviderOAuthRepository(db)

        repo.upsertAccount(
            providerCode = "google_health",
            providerUserId = "user-1",
            providerInstanceId = "google-health-user-1",
            accessTokenCiphertext = "enc-access",
            refreshTokenCiphertext = "enc-refresh",
            tokenType = "Bearer",
            expiresAt = Instant.parse("2099-01-01T00:00:00Z"),
            scope = "health.read",
            now = now,
        )
        repo.disconnectAccount("google_health", "google-health-user-1", later)

        val all = repo.accountsByProvider("google_health", includeDisconnected = true)
        assertEquals(1, all.size)
        assertEquals(ACCOUNT_STATUS_DISCONNECTED, all[0].accountStatus)
    }

    @Test
    fun accountsByProviderExcludesDisconnectedWhenRequested() = runBlocking {
        val db = freshDatabase()
        val repo = ProviderOAuthRepository(db)

        repo.upsertAccount(
            providerCode = "google_health",
            providerUserId = "user-1",
            providerInstanceId = "google-health-user-1",
            accessTokenCiphertext = "enc-access",
            refreshTokenCiphertext = "enc-refresh",
            tokenType = "Bearer",
            expiresAt = Instant.parse("2099-01-01T00:00:00Z"),
            scope = "health.read",
            now = now,
        )
        repo.disconnectAccount("google_health", "google-health-user-1", later)

        val active = repo.accountsByProvider("google_health", includeDisconnected = false)
        assertEquals(0, active.size)
    }

    @Test
    fun accountByProviderInstanceExcludesDisconnected() = runBlocking {
        val db = freshDatabase()
        val repo = ProviderOAuthRepository(db)

        repo.upsertAccount(
            providerCode = "google_health",
            providerUserId = "user-1",
            providerInstanceId = "google-health-user-1",
            accessTokenCiphertext = "enc-access",
            refreshTokenCiphertext = "enc-refresh",
            tokenType = "Bearer",
            expiresAt = Instant.parse("2099-01-01T00:00:00Z"),
            scope = "health.read",
            now = now,
        )

        assertNotNull(repo.accountByProviderInstance("google_health", "google-health-user-1"))

        repo.disconnectAccount("google_health", "google-health-user-1", later)
        assertNull(repo.accountByProviderInstance("google_health", "google-health-user-1"))
    }

    @Test
    fun accountByProviderInstanceForStatusReturnsDisconnectedAccounts() = runBlocking {
        val db = freshDatabase()
        val repo = ProviderOAuthRepository(db)

        repo.upsertAccount(
            providerCode = "google_health",
            providerUserId = "user-1",
            providerInstanceId = "google-health-user-1",
            accessTokenCiphertext = "enc-access",
            refreshTokenCiphertext = "enc-refresh",
            tokenType = "Bearer",
            expiresAt = Instant.parse("2099-01-01T00:00:00Z"),
            scope = "health.read",
            now = now,
        )
        repo.disconnectAccount("google_health", "google-health-user-1", later)

        val account = repo.accountByProviderInstanceForStatus("google_health", "google-health-user-1")
        assertNotNull(account)
        assertEquals(ACCOUNT_STATUS_DISCONNECTED, account.accountStatus)
    }

    @Test
    fun fullLifecycleTransitionSequence() = runBlocking {
        val db = freshDatabase()
        val repo = ProviderOAuthRepository(db)

        // 1. Connect
        repo.upsertAccount(
            providerCode = "google_health",
            providerUserId = "user-1",
            providerInstanceId = "google-health-user-1",
            accessTokenCiphertext = "access-v1",
            refreshTokenCiphertext = "refresh-v1",
            tokenType = "Bearer",
            expiresAt = Instant.parse("2026-05-15T11:00:00Z"),
            scope = "health.read",
            now = now,
        )
        var account = repo.accountByProviderInstanceForStatus("google_health", "google-health-user-1")!!
        assertEquals(ACCOUNT_STATUS_CONNECTED, account.accountStatus)
        assertEquals(now, account.connectedAt)

        // 2. Token refresh succeeds
        val t2 = Instant.parse("2026-05-15T10:30:00Z")
        repo.updateAccessToken(
            accountId = account.id,
            accessTokenCiphertext = "access-v2",
            refreshTokenCiphertext = "refresh-v2",
            tokenType = "Bearer",
            expiresAt = Instant.parse("2026-05-15T12:00:00Z"),
            scope = "health.read",
            now = t2,
        )
        account = repo.accountByProviderInstanceForStatus("google_health", "google-health-user-1")!!
        assertEquals(ACCOUNT_STATUS_CONNECTED, account.accountStatus)
        assertEquals(TOKEN_REFRESH_STATUS_SUCCESS, account.lastTokenRefreshStatus)

        // 3. Token refresh fails with invalid refresh token -> needs_reauth
        val t3 = Instant.parse("2026-05-15T11:00:00Z")
        repo.markNeedsReauth(account.id, "google_health_needs_reauth", "Token was revoked", t3)
        account = repo.accountByProviderInstanceForStatus("google_health", "google-health-user-1")!!
        assertEquals(ACCOUNT_STATUS_NEEDS_REAUTH, account.accountStatus)
        assertNull(repo.latestAccount("google_health"), "needs_reauth should be excluded from sync")

        // 4. Reconnect via upsertAccount
        val t4 = Instant.parse("2026-05-15T12:00:00Z")
        repo.upsertAccount(
            providerCode = "google_health",
            providerUserId = "user-1",
            providerInstanceId = "google-health-user-1",
            accessTokenCiphertext = "access-v3",
            refreshTokenCiphertext = "refresh-v3",
            tokenType = "Bearer",
            expiresAt = Instant.parse("2026-05-16T00:00:00Z"),
            scope = "health.read",
            now = t4,
        )
        account = repo.accountByProviderInstanceForStatus("google_health", "google-health-user-1")!!
        assertEquals(ACCOUNT_STATUS_CONNECTED, account.accountStatus)
        assertEquals(t4, account.connectedAt, "connected_at should reset on reconnect")
        assertNull(account.lastAuthErrorCode)
        assertNotNull(repo.latestAccount("google_health"), "should be syncable again")

        // 5. Disconnect
        val t5 = Instant.parse("2026-05-15T13:00:00Z")
        repo.disconnectAccount("google_health", "google-health-user-1", t5)
        account = repo.accountByProviderInstanceForStatus("google_health", "google-health-user-1")!!
        assertEquals(ACCOUNT_STATUS_DISCONNECTED, account.accountStatus)
        assertEquals(t5, account.disconnectedAt)
        assertEquals("", account.accessTokenCiphertext)
        assertEquals("", account.refreshTokenCiphertext)
        assertNull(repo.latestAccount("google_health"))
    }

    private fun freshDatabase(): Database {
        val config = PostgresTestDatabase.config()
        return DatabaseFactory().initialize(config)
    }
}
