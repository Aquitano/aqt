package me.aquitano.health.domain

import java.time.Instant

/**
 * Common interface for all health data providers.
 * Unifies authentication, token management, and data synchronization.
 */
interface HealthProvider {
    /**
     * Unique identifier for the provider (e.g., "google_health", "apple_health").
     */
    val providerCode: String

    /**
     * Generates the URL to redirect the user to for authentication.
     */
    fun getAuthUrl(state: String): String

    /**
     * Exchanges an authorization code for access and refresh tokens.
     */
    suspend fun exchangeCode(code: String, now: Instant): ProviderAuthTokens

    /**
     * Synchronizes health data for a specific account and time range.
     */
    suspend fun sync(
        providerInstanceId: String,
        from: Instant,
        to: Instant,
        now: Instant
    ): ProviderSyncSummary
}

data class ProviderAuthTokens(
    val accessToken: String,
    val refreshToken: String?,
    val tokenType: String,
    val expiresAt: Instant,
    val scope: String?,
)

data class ProviderSyncSummary(
    val providerCode: String,
    val providerInstanceId: String,
    val status: String, // "processed", "failed", "partial_failed"
    val batches: List<ProviderSyncBatch>,
    val errors: List<ProviderSyncError>,
)

data class ProviderSyncBatch(
    val batchId: Int,
    val recordCount: Int,
)

data class ProviderSyncError(
    val code: String,
    val message: String,
)
