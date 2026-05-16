package me.aquitano.health.api.dto

import io.ktor.openapi.JsonSchema
import kotlinx.serialization.Serializable

@Serializable
data class ProviderCatalogResponseDto(
    val providers: List<ProviderDescriptorResponseDto>,
)

@Serializable
data class ProviderDescriptorResponseDto(
    val providerCode: String,
    val displayName: String,
    val authType: String,
    val requiresAuthentication: Boolean,
    val supportedDataTypes: List<String>,
    val defaultDataTypes: List<String>,
    val maxSyncRangeDays: Int,
    val supportsPageSize: Boolean,
    val workflowEndpoints: ProviderWorkflowEndpointsResponseDto,
    val aliases: List<String> = emptyList(),
)

@Serializable
data class ProviderWorkflowEndpointsResponseDto(
    val oauthStart: String? = null,
    val oauthCallback: String? = null,
    val sync: String,
)

@Serializable
data class ProviderStatusCatalogResponseDto(
    val providers: List<ProviderStatusResponseDto>,
)

@Serializable
data class ProviderStatusResponseDto(
    val providerCode: String,
    val displayName: String,
    val configured: Boolean,
    val connected: Boolean,
    val needsAuthentication: Boolean,
    val canSync: Boolean,
    val nextAction: String,
    val accounts: List<ProviderAccountStatusResponseDto>,
)

@Serializable
data class ProviderAccountStatusResponseDto(
    val providerInstanceId: String,
    @JsonSchema.Format("date-time")
    val connectedAt: String,
    @JsonSchema.Format("date-time")
    val lastSyncAt: String? = null,
    val tokenStatus: String,
    @JsonSchema.Format("date-time")
    val expiresAt: String? = null,
)

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
data class ProviderSyncRequestDto(
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
data class ProviderSyncResponseDto(
    val providerCode: String,
    val providerInstanceId: String,
    @JsonSchema.Format("date-time")
    val requestedFrom: String,
    @JsonSchema.Format("date-time")
    val requestedTo: String,
    val status: String,
    val batches: List<ProviderSyncBatchResponseDto>,
    val emptyDataTypes: List<ProviderSyncEmptyDataTypeResponseDto>,
    val errors: List<ProviderSyncErrorResponseDto>,
)

@Serializable
data class ProviderSyncBatchResponseDto(
    val dataType: String,
    val batchId: Int,
    val duplicateBatch: Boolean,
    val recordsReceived: Int,
    val ingestionRecordsStored: Int,
    val metricsCreated: MetricCreatedCountsResponse,
    val duplicateMetricsSkipped: Int,
    val affectedStepSummaryDates: List<String>,
)

@Serializable
data class ProviderSyncErrorResponseDto(
    val dataType: String,
    val code: String,
    val message: String,
)

@Serializable
data class ProviderSyncEmptyDataTypeResponseDto(
    val dataType: String,
    val pagesFetched: Int,
    val sourceRecordsReceived: Int,
    val normalizedRecords: Int,
)
