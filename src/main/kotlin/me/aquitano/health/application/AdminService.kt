package me.aquitano.health.application

import me.aquitano.health.api.dto.BatchStatus
import me.aquitano.health.api.dto.IngestionBatchAdminResponse
import me.aquitano.health.api.dto.IngestionBatchDetailResponse
import me.aquitano.health.api.dto.IngestionBatchesResponse
import me.aquitano.health.api.dto.IngestionRecordAdminResponse
import me.aquitano.health.api.dto.ReadResponseMeta
import me.aquitano.health.application.metric.common.QueryParams
import me.aquitano.health.application.metric.common.keysetFetchLimit
import me.aquitano.health.application.metric.common.keysetPage
import me.aquitano.health.application.metric.common.validateRange
import me.aquitano.health.domain.NotFoundException
import me.aquitano.health.domain.RequestValidationException
import me.aquitano.health.domain.ValidationIssue
import me.aquitano.health.domain.ValidationIssueCodes
import me.aquitano.health.infrastructure.repositories.IngestionRepository
import me.aquitano.health.shared.AppJson
import org.jetbrains.exposed.v1.jdbc.Database
import org.jetbrains.exposed.v1.jdbc.transactions.suspendTransaction

class AdminService(
    private val database: Database,
    private val ingestionRepository: IngestionRepository,
) {
    suspend fun listBatches(params: QueryParams): IngestionBatchesResponse {
        val status = params.optional("status")
        if (status != null && status !in setOf(
                "received",
                "processed",
                "failed"
            )
        ) {
            throw RequestValidationException(
                listOf(
                    ValidationIssue(
                        field = "status",
                        code = ValidationIssueCodes.UnsupportedValue,
                        message = "unsupported batch status",
                    )
                )
            )
        }
        val from = params.instant("from")
        val to = params.instant("to")
        validateRange(from, to, "from", "to")
        val sort = "receivedAt"
        val order = "desc"
        val cursor = params.cursor(sort, order)
        val limit = params.limit(default = 100, max = 1000)
        return dbQuery {
            val page = ingestionRepository
                .listBatches(status, from, to, keysetFetchLimit(limit), cursor)
                .keysetPage(
                    limit = limit,
                    sort = sort,
                    order = order,
                    sortValue = { it.receivedAt },
                    id = { it.id.toLong() },
                )
            IngestionBatchesResponse(
                items = page.items
                    .map {
                        IngestionBatchAdminResponse(
                            id = it.id,
                            provider = it.provider,
                            providerInstanceId = it.providerInstanceId,
                            batchExternalId = it.batchExternalId,
                            status = BatchStatus.fromStored(it.status),
                            ingestedAt = it.ingestedAt,
                            receivedAt = it.receivedAt,
                            processedAt = it.processedAt,
                            errorMessage = it.errorMessage,
                            recordCount = it.recordCount,
                        )
                    },
                meta = ReadResponseMeta(
                    count = page.items.size,
                    limit = limit,
                    sort = sort,
                    order = order,
                    nextCursor = page.nextCursor,
                ),
            )
        }
    }

    suspend fun listFailures(params: QueryParams): IngestionBatchesResponse =
        listBatches(QueryParams(params.asMap() + ("status" to "failed")))

    suspend fun getBatchDetail(
        batchIdValue: String?,
        params: QueryParams
    ): IngestionBatchDetailResponse {
        val batchId = batchIdValue?.toIntOrNull()
        if (batchId == null || batchId <= 0) {
            throw RequestValidationException(
                listOf(
                    ValidationIssue(
                        field = "id",
                        code = ValidationIssueCodes.InvalidFormat,
                        message = "must be a positive integer",
                    )
                )
            )
        }
        val includeSourcePayload =
            params.boolean("includeSourcePayload", default = false)
        val includeNormalizedPayload =
            params.boolean("includeNormalizedPayload", default = false)
        return dbQuery {
            val batch = ingestionRepository.findBatchDetail(batchId)
                ?: throw NotFoundException("Ingestion batch not found")
            val records = ingestionRepository.listRecordsForBatch(batchId)
            IngestionBatchDetailResponse(
                id = batch.id,
                provider = batch.provider,
                providerInstanceId = batch.providerInstanceId,
                batchExternalId = batch.batchExternalId,
                status = BatchStatus.fromStored(batch.status),
                ingestedAt = batch.ingestedAt,
                receivedAt = batch.receivedAt,
                processedAt = batch.processedAt,
                errorMessage = batch.errorMessage,
                recordCount = records.size,
                records = records.map {
                    IngestionRecordAdminResponse(
                        id = it.id,
                        recordType = it.recordType,
                        providerRecordId = it.providerRecordId,
                        recordStartAt = it.recordStartAt,
                        recordEndAt = it.recordEndAt,
                        createdAt = it.createdAt,
                        normalizedRecord = if (includeNormalizedPayload) {
                            AppJson.parseToJsonElement(it.normalizedRecordJson)
                        } else {
                            null
                        },
                    )
                },
                sourcePayload = if (includeSourcePayload) {
                    AppJson.parseToJsonElement(batch.sourcePayloadJson)
                } else {
                    null
                },
                normalizedPayload = if (includeNormalizedPayload) {
                    AppJson.parseToJsonElement(batch.normalizedPayloadJson)
                } else {
                    null
                },
            )
        }
    }

    private suspend fun <T> dbQuery(block: () -> T): T =
        suspendTransaction(db = database) {
            block()
        }
}

fun QueryParams.asMap(): Map<String, String?> {
    val names = listOf("status", "from", "to", "limit", "cursor")
    return names.associateWith { optional(it) }
}
