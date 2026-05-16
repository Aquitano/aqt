package me.aquitano.health.api.dto

import io.ktor.openapi.JsonSchema
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

@Serializable
data class IngestionBatchesResponse(
    val items: List<IngestionBatchAdminResponse>,
)

@Serializable
data class IngestionBatchAdminResponse(
    val id: Int,
    val provider: String,
    val providerInstanceId: String,
    val batchExternalId: String?,
    val status: String,
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
    val status: String,
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
