package me.aquitano.health.api.dto

import io.ktor.openapi.*
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import me.aquitano.health.domain.SyncJobStatus
import me.aquitano.health.domain.SyncStatus

@Serializable
data class ProviderCatalogResponse(
    val items: List<ProviderDescriptorResponse>,
)

@Serializable
data class ProviderDescriptorResponse(
    val providerCode: String,
    val displayName: String,
    val authType: String,
    val requiresAuthentication: Boolean,
    val supportedDataTypes: List<String>,
    val defaultDataTypes: List<String>,
    val maxSyncRangeDays: Int,
    val supportsPageSize: Boolean,
    val workflowEndpoints: ProviderWorkflowEndpointsResponse,
    val aliases: List<String> = emptyList(),
)

@Serializable
data class ProviderWorkflowEndpointsResponse(
    val oauthStart: String? = null,
    val oauthCallback: String? = null,
    val accounts: String? = null,
    val disconnect: String? = null,
    val reconnect: String? = null,
    val sync: String,
)

@Serializable
data class ProviderStatusCatalogResponse(
    val items: List<ProviderStatusResponse>,
)

@Serializable
data class ProviderStatusResponse(
    val providerCode: String,
    val displayName: String,
    val configured: Boolean,
    val connected: Boolean,
    val needsAuthentication: Boolean,
    val canSync: Boolean,
    val nextAction: ProviderNextAction,
    val accounts: List<ProviderAccountStatusResponse>,
)

@Serializable
data class ProviderAccountStatusResponse(
    val providerInstanceId: String,
    val status: ProviderAccountLifecycleStatus,
    @JsonSchema.Format("date-time")
    val connectedAt: String? = null,
    @JsonSchema.Format("date-time")
    val disconnectedAt: String? = null,
    @JsonSchema.Format("date-time")
    val lastSyncAt: String? = null,
    val tokenStatus: ProviderTokenStatus,
    @JsonSchema.Format("date-time")
    val expiresAt: String? = null,
    @JsonSchema.Format("date-time")
    val lastTokenRefreshAt: String? = null,
    val lastTokenRefreshStatus: String? = null,
    val lastAuthErrorCode: String? = null,
    val lastAuthErrorMessage: String? = null,
)

@Serializable
data class ProviderAccountListResponse(
    val provider: String,
    val accounts: List<ProviderAccountStatusResponse>,
)

@Serializable
data class ProviderDisconnectResponse(
    val provider: String,
    val providerInstanceId: String,
    val disconnected: Boolean,
    val status: ProviderAccountLifecycleStatus,
)

@Serializable
enum class ProviderNextAction {
    @SerialName("configure")
    Configure,

    @SerialName("connect")
    Connect,

    @SerialName("reconnect")
    Reconnect,

    @SerialName("sync")
    Sync,
}

@Serializable
enum class ProviderAccountLifecycleStatus {
    @SerialName("not_connected")
    NotConnected,

    @SerialName("connected")
    Connected,

    @SerialName("needs_reauth")
    NeedsReauth,

    @SerialName("disconnected")
    Disconnected,

    @SerialName("configuration_error")
    ConfigurationError,
}

@Serializable
enum class ProviderTokenStatus {
    @SerialName("valid")
    Valid,

    @SerialName("expired")
    Expired,

    @SerialName("missing")
    Missing,

    @SerialName("unknown")
    Unknown,
}

@Serializable
data class ProviderOAuthStartResponse(
    val provider: String,
    val authorizationUrl: String,
    @JsonSchema.Format("date-time")
    val expiresAt: String,
)

@Serializable
data class ProviderOAuthCallbackResponse(
    val provider: String,
    val providerInstanceId: String,
    val connected: Boolean,
)

@Serializable
data class ProviderSyncRequest(
    val providerInstanceId: String? = null,
    @JsonSchema.Format("date-time")
    val from: String? = null,
    @JsonSchema.Format("date-time")
    val to: String? = null,
    val dataTypes: List<String>? = null,
    @JsonSchema.Minimum(1.0)
    val pageSize: Int? = null,
)

@Serializable
data class ProviderSyncResponse(
    val providerCode: String,
    val providerInstanceId: String,
    @JsonSchema.Format("date-time")
    val requestedFrom: String,
    @JsonSchema.Format("date-time")
    val requestedTo: String,
    val status: SyncStatus,
    val batches: List<ProviderSyncBatchResponse>,
    val emptyDataTypes: List<ProviderSyncEmptyDataTypeResponse>,
    val errors: List<ProviderSyncErrorResponse>,
)

@Serializable
data class ProviderSyncJobStartResponse(
    val jobId: String,
    val status: SyncJobStatus,
    @JsonSchema.Format("date-time")
    val createdAt: String,
)

@Serializable
data class ProviderSyncJobStatusResponse(
    val jobId: String,
    val providerCode: String,
    val providerInstanceId: String? = null,
    @JsonSchema.Format("date-time")
    val requestedFrom: String,
    @JsonSchema.Format("date-time")
    val requestedTo: String,
    val dataTypes: List<String>? = null,
    val status: SyncJobStatus,
    val totalItems: Int,
    val completedItems: Int,
    val currentItem: ProviderSyncJobItemResponse? = null,
    val lastCompletedItem: ProviderSyncJobItemResponse? = null,
    val batchesCount: Int,
    val emptyCount: Int,
    val errorCount: Int,
    val errorMessage: String? = null,
    @JsonSchema.Format("date-time")
    val createdAt: String,
    @JsonSchema.Format("date-time")
    val startedAt: String? = null,
    @JsonSchema.Format("date-time")
    val updatedAt: String,
    @JsonSchema.Format("date-time")
    val finishedAt: String? = null,
    val summary: ProviderSyncResponse? = null,
)

@Serializable
data class ProviderSyncJobItemResponse(
    val dataType: String,
    @JsonSchema.Format("date-time")
    val from: String,
    @JsonSchema.Format("date-time")
    val to: String,
)

@Serializable
data class ProviderSyncBatchResponse(
    val dataType: String,
    val batchId: Int,
    val duplicateBatch: Boolean,
    val recordsReceived: Int,
    val ingestionRecordsStored: Int,
    /** Created-row counts keyed by structural table kind or scalar metric_type. */
    val metricsCreated: Map<String, Int>,
    val duplicateMetricsSkipped: Int,
    val affectedStepSummaryDates: List<String>,
)

@Serializable
data class ProviderSyncErrorResponse(
    val dataType: String,
    val code: String,
    val message: String,
)

@Serializable
data class ProviderSyncEmptyDataTypeResponse(
    val dataType: String,
    val pagesFetched: Int,
    val sourceRecordsReceived: Int,
    val normalizedRecords: Int,
)

@Serializable
data class ScheduledSyncConfigUpdateRequest(
    val enabled: Boolean? = null,
    val dataTypes: List<String>? = null,
    @JsonSchema.Minimum(15.0)
    val cadenceMinutes: Int? = null,
    @JsonSchema.Minimum(0.0)
    val lookbackDays: Int? = null,
)

@Serializable
data class ScheduledSyncConfigResponse(
    val providerCode: String,
    val providerInstanceId: String,
    val enabled: Boolean,
    val dataTypes: List<String>,
    val cadenceMinutes: Int,
    val lookbackDays: Int,
    @JsonSchema.Format("date-time")
    val lastSuccessfulFrom: String? = null,
    @JsonSchema.Format("date-time")
    val lastSuccessfulTo: String? = null,
    @JsonSchema.Format("date-time")
    val lastSuccessAt: String? = null,
    @JsonSchema.Format("date-time")
    val lastAttemptedAt: String? = null,
    val failureCount: Int,
    @JsonSchema.Format("date-time")
    val nextRunAt: String? = null,
    val lastErrorMessage: String? = null,
    val checkpoints: List<ScheduledSyncCheckpointResponse>,
)

@Serializable
data class ScheduledSyncCheckpointResponse(
    val dataType: String,
    @JsonSchema.Format("date-time")
    val checkpointAt: String? = null,
    @JsonSchema.Format("date-time")
    val lastSuccessfulFrom: String? = null,
    @JsonSchema.Format("date-time")
    val lastSuccessfulTo: String? = null,
)

@Serializable
data class ScheduledSyncRunResponse(
    val providerCode: String,
    val providerInstanceId: String,
    val status: SyncStatus,
    @JsonSchema.Format("date-time")
    val requestedFrom: String? = null,
    @JsonSchema.Format("date-time")
    val requestedTo: String? = null,
    val errors: List<String>,
    val summaries: List<ProviderSyncResponse>,
)
