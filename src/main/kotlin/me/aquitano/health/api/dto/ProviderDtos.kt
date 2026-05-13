package me.aquitano.health.api.dto

import kotlinx.serialization.Serializable

@Serializable
data class ProviderOAuthStartResponse(
    val provider: String,
    val authorizationUrl: String,
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
    val from: String? = null,
    val to: String? = null,
    val dataTypes: List<String>? = null,
    val pageSize: Int? = null,
)

@Serializable
data class ProviderSyncResponseDto(
    val providerCode: String,
    val providerInstanceId: String,
    val requestedFrom: String,
    val requestedTo: String,
    val status: String,
    val batches: List<ProviderSyncBatchResponseDto>,
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
