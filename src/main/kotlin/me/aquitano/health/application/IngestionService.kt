package me.aquitano.health.application

import me.aquitano.health.api.dto.BatchStatus
import me.aquitano.health.api.dto.IngestionBatchRequest
import me.aquitano.health.api.dto.IngestionSummaryResponse
import me.aquitano.health.api.dto.MetricSkippedCountsResponse
import me.aquitano.health.application.metric.common.MetricWriteService
import me.aquitano.health.domain.*
import me.aquitano.health.infrastructure.repositories.IngestionRepository
import me.aquitano.health.infrastructure.repositories.PendingDerivedRebuildRepository
import me.aquitano.health.infrastructure.repositories.SupportRepository
import me.aquitano.health.shared.AppJson
import org.jetbrains.exposed.v1.jdbc.Database
import me.aquitano.health.infrastructure.database.suspendDbTransaction
import io.github.oshai.kotlinlogging.KotlinLogging
import me.aquitano.health.infrastructure.logging.*
import java.time.Instant
import java.time.LocalDate
import java.util.concurrent.CancellationException

private val logger = KotlinLogging.logger {}

class IngestionService(
    private val database: Database,
    private val mappingService: IngestionMappingService,
    private val supportRepository: SupportRepository,
    private val ingestionRepository: IngestionRepository,
    private val metricWriteService: MetricWriteService,
    private val derivedRebuildExecutor: DerivedRebuildExecutor,
    private val pendingDerivedRebuildRepository: PendingDerivedRebuildRepository,
) {
    suspend fun findExistingBatch(
        provider: String,
        providerInstanceId: String,
        batchExternalId: String,
        now: Instant,
    ) =
        suspendDbTransaction(db = database) {
            val sourceInstance =
                supportRepository.resolveOrCreateSourceInstanceInTransaction(
                    provider = provider,
                    providerInstanceId = providerInstanceId,
                    now = now,
                )
            ingestionRepository.findBatchByExternalId(
                sourceInstance.id,
                batchExternalId,
            )
        }

    suspend fun ingestBatch(
        request: IngestionBatchRequest,
        now: Instant
    ): IngestionSummaryResponse {
        val validated = mappingService.validateAndMap(request)
        logger.infoWithContext(
            "ingestion_batch_received",
            "provider" to validated.provider,
            "providerInstanceId" to validated.providerInstanceId,
            "recordCount" to validated.records.size,
            "hasExternalId" to (validated.batchExternalId != null),
        )
        val transactionResult =
            suspendDbTransaction(db = database) {
                val sourceInstance =
                    supportRepository.resolveOrCreateSourceInstanceInTransaction(
                        provider = validated.provider,
                        providerInstanceId = validated.providerInstanceId,
                        now = now,
                    )

                val existingBatch = validated.batchExternalId
                    ?.let {
                        ingestionRepository.findBatchByExternalId(
                            sourceInstance.id,
                            it
                        )
                    }
                if (existingBatch?.status == "processed") {
                    logger.infoWithContext(
                        "ingestion_batch_duplicate",
                        "batchId" to existingBatch.id,
                        "recordCount" to validated.records.size,
                    )
                    return@suspendDbTransaction IngestionTransactionResult.Success(
                        IngestionSummaryResponse(
                            batchId = existingBatch.id,
                            status = BatchStatus.fromStored(existingBatch.status),
                            duplicateBatch = true,
                            recordsReceived = validated.records.size,
                            ingestionRecordsStored = 0,
                            metricsCreated = emptyMap(),
                            metricsSkipped = MetricSkippedCountsResponse(
                                duplicates = 0
                            ),
                            affectedStepSummaryDates = emptyList(),
                        ),
                        DerivedRebuildRequest(sourceInstanceId = sourceInstance.id),
                        MetricCreatedCounts(),
                    )
                }
                if (existingBatch?.status == "failed") {
                    val existingBatchExternalId = existingBatch.batchExternalId
                        ?: throw ConflictException(
                            "ingestion_batch_invalid_state",
                            "Failed batch '${existingBatch.id}' does not have an external ID",
                        )
                    ingestionRepository.releaseFailedBatchExternalId(
                        batchId = existingBatch.id,
                        batchExternalId = existingBatchExternalId,
                        releasedAt = now,
                    )
                    logger.infoWithContext(
                        "ingestion_batch_failed_external_id_released",
                        "batchId" to existingBatch.id,
                        "batchExternalId" to existingBatchExternalId,
                    )
                } else if (existingBatch != null) {
                    throw ConflictException(
                        "ingestion_batch_in_progress",
                        "Batch '${validated.batchExternalId}' already exists with status '${existingBatch.status}'",
                    )
                }

                val batchId = ingestionRepository.insertBatch(
                    sourceInstanceId = sourceInstance.id,
                    batchExternalId = validated.batchExternalId,
                    sourcePayloadJson = AppJson.encodeToString(validated.sourcePayload),
                    normalizedPayloadJson = validated.normalizedPayloadJson,
                    ingestedAt = validated.ingestedAt,
                    receivedAt = now,
                )
                val ingestionRecords = ingestionRepository.insertRecords(
                    batchId,
                    validated.records,
                    now
                )

                var created = MetricCreatedCounts()
                var duplicateSkipped = 0
                val affectedDates = mutableMapOf<DerivedKind, MutableSet<LocalDate>>()

                try {
                    ingestionRecords.forEach { ingestionRecord ->
                        val result = metricWriteService.write(
                            provider = validated.provider,
                            sourceInstanceId = sourceInstance.id,
                            ingestionRecordId = ingestionRecord.id,
                            record = ingestionRecord.record,
                            now = now,
                        )
                        created += result.created
                        duplicateSkipped += result.duplicateSkipped
                        result.affectedDates.forEach { (kind, dates) ->
                            affectedDates.getOrPut(kind) { linkedSetOf() }.addAll(dates)
                        }
                    }
                    ingestionRepository.markProcessed(batchId, now)
                } catch (exception: Exception) {
                    if (exception is CancellationException) throw exception
                    ingestionRepository.markFailed(
                        batchId,
                        now,
                        exception.message ?: "Unknown ingestion error"
                    )
                    logger.errorWithContext(
                        "ingestion_batch_failed",
                        "batchId" to batchId,
                        throwable = exception,
                    )
                    return@suspendDbTransaction IngestionTransactionResult.Failure(
                        exception
                    )
                }

                val response = IngestionSummaryResponse(
                    batchId = batchId,
                    status = BatchStatus.Processed,
                    duplicateBatch = false,
                    recordsReceived = validated.records.size,
                    ingestionRecordsStored = ingestionRecords.size,
                    metricsCreated = created.counts,
                    metricsSkipped = MetricSkippedCountsResponse(
                        duplicates = duplicateSkipped
                    ),
                    affectedStepSummaryDates = affectedDates[DerivedKind.STEP_SUMMARY]
                        .orEmpty()
                        .map { it.toString() },
                )
                val rebuildRequest = DerivedRebuildRequest(
                    sourceInstanceId = sourceInstance.id,
                    affectedDates = affectedDates.mapValues { it.value.toSet() },
                )
                IngestionTransactionResult.Success(
                    response,
                    rebuildRequest,
                    created,
                )
            }

        return when (transactionResult) {
            is IngestionTransactionResult.Success -> {
                val response = transactionResult.response
                if (!response.duplicateBatch) {
                    try {
                        derivedRebuildExecutor.rebuild(
                            transactionResult.derivedRebuildRequest,
                            now,
                        )
                    } catch (exception: Exception) {
                        if (exception is CancellationException) throw exception
                        val rebuildError = exception.message ?: "Unknown derived rebuild error"
                        suspendDbTransaction(db = database) {
                            ingestionRepository.markDerivedRebuildFailed(
                                response.batchId,
                                now,
                                rebuildError,
                            )
                            pendingDerivedRebuildRepository.enqueueInTransaction(
                                transactionResult.derivedRebuildRequest,
                                error = rebuildError,
                                now = now,
                            )
                        }
                        logger.errorWithContext(
                            "ingestion_derived_rebuild_failed",
                            "batchId" to response.batchId,
                            throwable = exception,
                        )
                    }
                    logger.infoWithContext(
                        "ingestion_batch_processed",
                        "batchId" to response.batchId,
                        "recordsStored" to response.ingestionRecordsStored,
                        "metricsCreated" to transactionResult.createdCounts.counts,
                        "duplicateSkips" to response.metricsSkipped.duplicates,
                    )
                }
                response
            }

            is IngestionTransactionResult.Failure -> throw transactionResult.throwable
        }
    }
}

private sealed interface IngestionTransactionResult {
    data class Success(
        val response: IngestionSummaryResponse,
        val derivedRebuildRequest: DerivedRebuildRequest,
        val createdCounts: MetricCreatedCounts,
    ) :
        IngestionTransactionResult

    data class Failure(val throwable: Throwable) : IngestionTransactionResult
}
