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
     * Public provider discovery metadata.
     */
    val descriptor: HealthProviderDescriptor

    /**
     * Stable instance ID used until the provider can return an account-specific identifier.
     */
    val defaultProviderInstanceId: String

    /**
     * Generates the URL to redirect the user to for authentication.
     */
    fun getAuthUrl(state: String): String

    /**
     * Exchanges an authorization code and stores the resulting provider account.
     */
    suspend fun connect(code: String, now: Instant): ProviderConnection

    /**
     * Synchronizes health data for a specific account and time range.
     */
    suspend fun sync(
        request: ProviderSyncRequest,
        now: Instant
    ): ProviderSyncSummary
}

data class HealthProviderDescriptor(
    val providerCode: String,
    val displayName: String,
    val authType: ProviderAuthType,
    val requiresAuthentication: Boolean,
    val supportedDataTypes: List<String>,
    val defaultDataTypes: List<String>,
    val maxSyncRangeDays: Int,
    val supportsPageSize: Boolean,
    val workflowEndpoints: ProviderWorkflowEndpoints,
    val aliases: List<String> = emptyList(),
)

enum class ProviderAuthType {
    OAUTH,
    NONE,
}

data class ProviderWorkflowEndpoints(
    val oauthStart: String? = null,
    val oauthCallback: String? = null,
    val sync: String,
)

data class ProviderConnection(
    val providerCode: String,
    val providerInstanceId: String,
    val connected: Boolean,
)

data class ProviderSyncRequest(
    val providerInstanceId: String? = null,
    val from: Instant,
    val to: Instant,
    val dataTypes: List<String>? = null,
    val pageSize: Int? = null,
)

data class ProviderSyncSummary(
    val providerCode: String,
    val providerInstanceId: String,
    val requestedFrom: Instant,
    val requestedTo: Instant,
    val status: String, // "processed", "failed", "partial_failed"
    val batches: List<ProviderSyncBatch>,
    val errors: List<ProviderSyncError>,
    val emptyDataTypes: List<ProviderSyncEmptyDataType> = emptyList(),
)

data class ProviderSyncBatch(
    val dataType: String,
    val batchId: Int,
    val duplicateBatch: Boolean,
    val recordsReceived: Int,
    val ingestionRecordsStored: Int,
    val metricsCreated: MetricCreatedCounts,
    val duplicateMetricsSkipped: Int,
    val affectedStepSummaryDates: List<String>,
)

data class ProviderSyncError(
    val dataType: String,
    val code: String,
    val message: String,
)

data class ProviderSyncEmptyDataType(
    val dataType: String,
    val pagesFetched: Int,
    val sourceRecordsReceived: Int,
    val normalizedRecords: Int,
)
