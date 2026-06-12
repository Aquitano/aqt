package me.aquitano.health.api.dto

import io.ktor.openapi.*
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

@Serializable
data class IngestionBatchesResponse(
    val items: List<IngestionBatchAdminResponse>,
    val meta: ReadResponseMeta,
)

@Serializable
data class IngestionBatchAdminResponse(
    val id: Int,
    val provider: String,
    val providerInstanceId: String,
    val batchExternalId: String?,
    val status: BatchStatus,
    @JsonSchema.Format("date-time")
    val ingestedAt: String,
    @JsonSchema.Format("date-time")
    val receivedAt: String,
    @JsonSchema.Format("date-time")
    val processedAt: String?,
    val errorMessage: String?,
    val recordCount: Int,
)

@Serializable
data class IngestionBatchDetailResponse(
    val id: Int,
    val provider: String,
    val providerInstanceId: String,
    val batchExternalId: String?,
    val status: BatchStatus,
    @JsonSchema.Format("date-time")
    val ingestedAt: String,
    @JsonSchema.Format("date-time")
    val receivedAt: String,
    @JsonSchema.Format("date-time")
    val processedAt: String?,
    val errorMessage: String?,
    val recordCount: Int,
    val records: List<IngestionRecordAdminResponse>,
    val sourcePayload: JsonElement? = null,
    val normalizedPayload: JsonElement? = null,
)

@Serializable
data class IngestionRecordAdminResponse(
    val id: Int,
    val recordType: String,
    val providerRecordId: String?,
    @JsonSchema.Format("date-time")
    val recordStartAt: String?,
    @JsonSchema.Format("date-time")
    val recordEndAt: String?,
    @JsonSchema.Format("date-time")
    val createdAt: String,
    val normalizedRecord: JsonElement? = null,
)

@Serializable
data class ReplayRequest(
    val scope: String = "all",
    val metricTypes: List<String>? = null,
    @JsonSchema.Format("date")
    val fromDate: String? = null,
    @JsonSchema.Format("date")
    val toDate: String? = null,
    val wipe: Boolean = false,
)

@Serializable
data class ReplayJobStartResponse(
    val jobId: String,
    val status: ReplayJobStatus,
    @JsonSchema.Format("date-time")
    val createdAt: String,
)

@Serializable
data class ReplayJobStatusResponse(
    val jobId: String,
    val scope: String,
    val metricTypes: List<String>?,
    @JsonSchema.Format("date")
    val fromDate: String?,
    @JsonSchema.Format("date")
    val toDate: String?,
    val wipe: Boolean,
    val status: ReplayJobStatus,
    val totalItems: Int,
    val completedItems: Int,
    val currentItem: String?,
    val recordsReplayed: Int,
    val metricsWritten: Int,
    val duplicatesSkipped: Int,
    val mappingFailures: Int,
    val errorMessage: String?,
    @JsonSchema.Format("date-time")
    val createdAt: String,
    @JsonSchema.Format("date-time")
    val startedAt: String?,
    @JsonSchema.Format("date-time")
    val updatedAt: String,
    @JsonSchema.Format("date-time")
    val finishedAt: String?,
)
