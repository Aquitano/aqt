package me.aquitano.health.application

import kotlinx.coroutines.Dispatchers
import me.aquitano.health.api.dto.MetricCreatedCountsResponse
import me.aquitano.health.api.dto.MetricSkippedCountsResponse
import me.aquitano.health.api.dto.IngestionBatchRequest
import me.aquitano.health.api.dto.IngestionSummaryResponse
import me.aquitano.health.domain.*
import me.aquitano.health.infrastructure.repositories.MetricsWriteRepository
import me.aquitano.health.infrastructure.repositories.IngestionRepository
import me.aquitano.health.infrastructure.repositories.SupportRepository
import me.aquitano.health.shared.AppJson
import me.aquitano.health.shared.utcDate
import org.jetbrains.exposed.sql.Database
import org.jetbrains.exposed.sql.transactions.experimental.newSuspendedTransaction

class IngestionService(
    private val database: Database,
    private val mappingService: IngestionMappingService,
    private val supportRepository: SupportRepository,
    private val ingestionRepository: IngestionRepository,
    private val metricsWriteRepository: MetricsWriteRepository,
    private val stepSummaryService: StepSummaryService,
) {
    suspend fun ingestBatch(
        request: IngestionBatchRequest,
        now: java.time.Instant
    ): IngestionSummaryResponse {
        val validated = mappingService.validateAndMap(request)
        val transactionResult =
            newSuspendedTransaction(Dispatchers.IO, db = database) {
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
                if (existingBatch != null) {
                    return@newSuspendedTransaction IngestionTransactionResult.Success(
                        IngestionSummaryResponse(
                            batchId = existingBatch.id,
                            status = existingBatch.status,
                            duplicateBatch = true,
                            recordsReceived = validated.records.size,
                            ingestionRecordsStored = 0,
                            metricsCreated = MetricCreatedCountsResponse(
                                0,
                                0,
                                0,
                                0,
                                0
                            ),
                            metricsSkipped = MetricSkippedCountsResponse(
                                duplicates = 0
                            ),
                            affectedStepSummaryDates = emptyList(),
                        ),
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
                val affectedDates = linkedSetOf<java.time.LocalDate>()

                try {
                    ingestionRecords.forEach { ingestionRecord ->
                        when (val record = ingestionRecord.record) {
                            is StepIntervalRecord -> {
                                val inserted =
                                    metricsWriteRepository.insertStepSample(
                                        sourceInstance.id,
                                        ingestionRecord.id,
                                        record,
                                        now
                                    )
                                if (inserted) {
                                    created =
                                        created.copy(stepSamples = created.stepSamples + 1)
                                    affectedDates.add(record.startAt.utcDate())
                                } else {
                                    duplicateSkipped += 1
                                }
                            }

                            is SleepSessionRecord -> {
                                val sessionId =
                                    metricsWriteRepository.insertSleepSession(
                                        sourceInstance.id,
                                        ingestionRecord.id,
                                        record,
                                        now
                                    )
                                if (sessionId != null) {
                                    created = created.copy(
                                        sleepSessions = created.sleepSessions + 1,
                                        sleepStages = created.sleepStages + record.stages.size,
                                    )
                                } else {
                                    duplicateSkipped += 1
                                }
                            }

                            is BodyMeasurementRecord -> {
                                val inserted =
                                    metricsWriteRepository.insertBodyMeasurements(
                                        sourceInstance.id,
                                        ingestionRecord.id,
                                        record,
                                        now
                                    )
                                created =
                                    created.copy(bodyMeasurements = created.bodyMeasurements + inserted)
                                duplicateSkipped += record.measurements.size - inserted
                            }

                            is HeartRateRecord -> {
                                val inserted =
                                    metricsWriteRepository.insertHeartRateSample(
                                        sourceInstance.id,
                                        ingestionRecord.id,
                                        record,
                                        now
                                    )
                                if (inserted) {
                                    created =
                                        created.copy(heartRateSamples = created.heartRateSamples + 1)
                                } else {
                                    duplicateSkipped += 1
                                }
                            }
                        }
                    }
                    stepSummaryService.recompute(
                        sourceInstance.id,
                        affectedDates,
                        now
                    )
                    ingestionRepository.markProcessed(batchId, now)
                } catch (throwable: Throwable) {
                    ingestionRepository.markFailed(
                        batchId,
                        now,
                        throwable.message ?: "Unknown ingestion error"
                    )
                    return@newSuspendedTransaction IngestionTransactionResult.Failure(
                        throwable
                    )
                }

                IngestionTransactionResult.Success(
                    IngestionSummaryResponse(
                        batchId = batchId,
                        status = "processed",
                        duplicateBatch = false,
                        recordsReceived = validated.records.size,
                        ingestionRecordsStored = ingestionRecords.size,
                        metricsCreated = MetricCreatedCountsResponse(
                            stepSamples = created.stepSamples,
                            sleepSessions = created.sleepSessions,
                            sleepStages = created.sleepStages,
                            bodyMeasurements = created.bodyMeasurements,
                            heartRateSamples = created.heartRateSamples,
                        ),
                        metricsSkipped = MetricSkippedCountsResponse(
                            duplicates = duplicateSkipped
                        ),
                        affectedStepSummaryDates = affectedDates.map { it.toString() },
                    ),
                )
            }

        return when (transactionResult) {
            is IngestionTransactionResult.Success -> transactionResult.response
            is IngestionTransactionResult.Failure -> throw transactionResult.throwable
        }
    }
}

private sealed interface IngestionTransactionResult {
    data class Success(val response: IngestionSummaryResponse) :
        IngestionTransactionResult

    data class Failure(val throwable: Throwable) : IngestionTransactionResult
}
