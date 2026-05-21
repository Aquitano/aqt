package me.aquitano.health.application

import kotlinx.coroutines.Dispatchers
import me.aquitano.health.api.dto.IngestionBatchRequest
import me.aquitano.health.api.dto.IngestionSummaryResponse
import me.aquitano.health.api.dto.MetricCreatedCountsResponse
import me.aquitano.health.api.dto.MetricSkippedCountsResponse
import me.aquitano.health.domain.*
import me.aquitano.health.infrastructure.repositories.IngestionRepository
import me.aquitano.health.infrastructure.repositories.MetricsWriteRepository
import me.aquitano.health.infrastructure.repositories.SupportRepository
import me.aquitano.health.shared.AppJson
import me.aquitano.health.shared.utcDate
import net.logstash.logback.argument.StructuredArguments.kv
import org.jetbrains.exposed.sql.Database
import org.jetbrains.exposed.sql.transactions.experimental.newSuspendedTransaction
import org.slf4j.LoggerFactory
import java.time.Instant
import java.time.LocalDate
import java.util.concurrent.CancellationException

private val logger = LoggerFactory.getLogger(IngestionService::class.java)

class IngestionService(
    private val database: Database,
    private val mappingService: IngestionMappingService,
    private val supportRepository: SupportRepository,
    private val ingestionRepository: IngestionRepository,
    private val metricsWriteRepository: MetricsWriteRepository,
    private val stepSummaryService: StepSummaryService,
) {
    suspend fun findExistingBatch(
        provider: String,
        providerInstanceId: String,
        batchExternalId: String,
        now: Instant,
    ) =
        newSuspendedTransaction(Dispatchers.IO, db = database) {
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
        logger.info(
            "ingestion_batch_received {} {} {} {}",
            kv("provider", validated.provider),
            kv("providerInstanceId", validated.providerInstanceId),
            kv("recordCount", validated.records.size),
            kv("hasExternalId", validated.batchExternalId != null),
        )
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
                if (existingBatch?.status == "processed") {
                    logger.info(
                        "ingestion_batch_duplicate {} {}",
                        kv("batchId", existingBatch.id),
                        kv("recordCount", validated.records.size),
                    )
                    return@newSuspendedTransaction IngestionTransactionResult.Success(
                        IngestionSummaryResponse(
                            batchId = existingBatch.id,
                            status = existingBatch.status,
                            duplicateBatch = true,
                            recordsReceived = validated.records.size,
                            ingestionRecordsStored = 0,
                            metricsCreated = MetricCreatedCountsResponse(
                                stepSamples = 0,
                                sleepSessions = 0,
                                sleepStages = 0,
                                bodyMeasurements = 0,
                                heartRateSamples = 0,
                                activitySummaries = 0,
                                sleepSummaries = 0,
                                respiratoryRateSamples = 0,
                                hrvSamples = 0,
                            ),
                            metricsSkipped = MetricSkippedCountsResponse(
                                duplicates = 0
                            ),
                            affectedStepSummaryDates = emptyList(),
                        ),
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
                    logger.info(
                        "ingestion_batch_failed_external_id_released {} {}",
                        kv("batchId", existingBatch.id),
                        kv("batchExternalId", existingBatchExternalId),
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
                val affectedDates = linkedSetOf<LocalDate>()

                try {
                    ingestionRecords.forEach { ingestionRecord ->
                        val result =
                            when (val record = ingestionRecord.record) {
                                is StepIntervalRecord -> writeStepInterval(
                                    validated.provider,
                                    sourceInstance.id,
                                    ingestionRecord.id,
                                    record,
                                    now
                                )

                                is SleepSessionRecord -> writeSleepSession(
                                    sourceInstance.id,
                                    ingestionRecord.id,
                                    record,
                                    now
                                )

                                is BodyMeasurementRecord -> writeBodyMeasurement(
                                    sourceInstance.id,
                                    ingestionRecord.id,
                                    record,
                                    now
                                )

                                is HeartRateRecord -> writeHeartRate(
                                    sourceInstance.id,
                                    ingestionRecord.id,
                                    record,
                                    now
                                )

                                is ActivitySummaryRecord -> writeActivitySummary(
                                    sourceInstance.id,
                                    ingestionRecord.id,
                                    record,
                                    now
                                )

                                is SleepSummaryRecord -> writeSleepSummary(
                                    sourceInstance.id,
                                    ingestionRecord.id,
                                    record,
                                    now
                                )

                                is RespiratoryRateRecord -> writeRespiratoryRate(
                                    sourceInstance.id,
                                    ingestionRecord.id,
                                    record,
                                    now
                                )

                                is HrvRecord -> writeHrv(
                                    sourceInstance.id,
                                    ingestionRecord.id,
                                    record,
                                    now
                                )
                            }
                        created += result.created
                        duplicateSkipped += result.duplicateSkipped
                        affectedDates.addAll(result.affectedStepSummaryDates)
                    }
                    stepSummaryService.recompute(
                        sourceInstance.id,
                        affectedDates,
                        now
                    )
                    ingestionRepository.markProcessed(batchId, now)
                } catch (exception: Exception) {
                    if (exception is CancellationException) throw exception
                    ingestionRepository.markFailed(
                        batchId,
                        now,
                        exception.message ?: "Unknown ingestion error"
                    )
                    logger.error(
                        "ingestion_batch_failed {}",
                        kv("batchId", batchId),
                        exception,
                    )
                    return@newSuspendedTransaction IngestionTransactionResult.Failure(
                        exception
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
                            activitySummaries = created.activitySummaries,
                            sleepSummaries = created.sleepSummaries,
                            respiratoryRateSamples = created.respiratoryRateSamples,
                            hrvSamples = created.hrvSamples,
                        ),
                        metricsSkipped = MetricSkippedCountsResponse(
                            duplicates = duplicateSkipped
                        ),
                        affectedStepSummaryDates = affectedDates.map { it.toString() },
                    ),
                )
            }

        return when (transactionResult) {
            is IngestionTransactionResult.Success -> {
                val response = transactionResult.response
                if (!response.duplicateBatch) {
                    logger.info(
                        "ingestion_batch_processed {} {} {} {} {} {} {} {} {} {} {} {}",
                        kv("batchId", response.batchId),
                        kv("recordsStored", response.ingestionRecordsStored),
                        kv(
                            "stepSamplesCreated",
                            response.metricsCreated.stepSamples
                        ),
                        kv(
                            "sleepSessionsCreated",
                            response.metricsCreated.sleepSessions
                        ),
                        kv(
                            "sleepStagesCreated",
                            response.metricsCreated.sleepStages
                        ),
                        kv(
                            "bodyMeasurementsCreated",
                            response.metricsCreated.bodyMeasurements
                        ),
                        kv(
                            "heartRateSamplesCreated",
                            response.metricsCreated.heartRateSamples
                        ),
                        kv(
                            "activitySummariesCreated",
                            response.metricsCreated.activitySummaries
                        ),
                        kv(
                            "sleepSummariesCreated",
                            response.metricsCreated.sleepSummaries
                        ),
                        kv(
                            "respiratoryRateSamplesCreated",
                            response.metricsCreated.respiratoryRateSamples
                        ),
                        kv(
                            "hrvSamplesCreated",
                            response.metricsCreated.hrvSamples
                        ),
                        kv(
                            "duplicateSkips",
                            response.metricsSkipped.duplicates
                        ),
                    )
                }
                response
            }

            is IngestionTransactionResult.Failure -> throw transactionResult.throwable
        }
    }

    private fun writeStepInterval(
        provider: String,
        sourceInstanceId: Int,
        ingestionRecordId: Int,
        record: StepIntervalRecord,
        now: Instant,
    ): MetricWriteResult {
        val inserted = metricsWriteRepository.insertStepSample(
            provider,
            sourceInstanceId,
            ingestionRecordId,
            record,
            now
        )
        return if (inserted) {
            MetricWriteResult(
                created = MetricCreatedCounts(stepSamples = 1),
                affectedStepSummaryDates = affectedUtcDates(
                    record.startAt,
                    record.endAt
                ),
            )
        } else {
            MetricWriteResult(duplicateSkipped = 1)
        }
    }

    private fun writeSleepSession(
        sourceInstanceId: Int,
        ingestionRecordId: Int,
        record: SleepSessionRecord,
        now: Instant,
    ): MetricWriteResult {
        val sessionId = metricsWriteRepository.insertSleepSession(
            sourceInstanceId,
            ingestionRecordId,
            record,
            now
        )
        return if (sessionId != null) {
            MetricWriteResult(
                created = MetricCreatedCounts(
                    sleepSessions = 1,
                    sleepStages = record.stages.size,
                ),
            )
        } else {
            MetricWriteResult(duplicateSkipped = 1)
        }
    }

    private fun writeBodyMeasurement(
        sourceInstanceId: Int,
        ingestionRecordId: Int,
        record: BodyMeasurementRecord,
        now: Instant,
    ): MetricWriteResult {
        val inserted = metricsWriteRepository.insertBodyMeasurements(
            sourceInstanceId,
            ingestionRecordId,
            record,
            now
        )
        return MetricWriteResult(
            created = MetricCreatedCounts(bodyMeasurements = inserted),
            duplicateSkipped = record.measurements.size - inserted,
        )
    }

    private fun writeHeartRate(
        sourceInstanceId: Int,
        ingestionRecordId: Int,
        record: HeartRateRecord,
        now: Instant,
    ): MetricWriteResult {
        val inserted = metricsWriteRepository.insertHeartRateSample(
            sourceInstanceId,
            ingestionRecordId,
            record,
            now
        )
        return if (inserted) {
            MetricWriteResult(created = MetricCreatedCounts(heartRateSamples = 1))
        } else {
            MetricWriteResult(duplicateSkipped = 1)
        }
    }

    private fun writeActivitySummary(
        sourceInstanceId: Int,
        ingestionRecordId: Int,
        record: ActivitySummaryRecord,
        now: Instant,
    ): MetricWriteResult {
        val inserted = metricsWriteRepository.insertActivitySummary(
            sourceInstanceId,
            ingestionRecordId,
            record,
            now
        )
        return if (inserted) {
            MetricWriteResult(created = MetricCreatedCounts(activitySummaries = 1))
        } else {
            MetricWriteResult(duplicateSkipped = 1)
        }
    }

    private fun writeSleepSummary(
        sourceInstanceId: Int,
        ingestionRecordId: Int,
        record: SleepSummaryRecord,
        now: Instant,
    ): MetricWriteResult {
        val inserted = metricsWriteRepository.insertSleepSummary(
            sourceInstanceId,
            ingestionRecordId,
            record,
            now
        )
        return if (inserted) {
            MetricWriteResult(created = MetricCreatedCounts(sleepSummaries = 1))
        } else {
            MetricWriteResult(duplicateSkipped = 1)
        }
    }

    private fun writeRespiratoryRate(
        sourceInstanceId: Int,
        ingestionRecordId: Int,
        record: RespiratoryRateRecord,
        now: Instant,
    ): MetricWriteResult {
        val inserted = metricsWriteRepository.insertRespiratoryRateSample(
            sourceInstanceId,
            ingestionRecordId,
            record,
            now
        )
        return if (inserted) {
            MetricWriteResult(
                created = MetricCreatedCounts(respiratoryRateSamples = 1)
            )
        } else {
            MetricWriteResult(duplicateSkipped = 1)
        }
    }

    private fun writeHrv(
        sourceInstanceId: Int,
        ingestionRecordId: Int,
        record: HrvRecord,
        now: Instant,
    ): MetricWriteResult {
        val inserted = metricsWriteRepository.insertHrvSample(
            sourceInstanceId,
            ingestionRecordId,
            record,
            now
        )
        return if (inserted) {
            MetricWriteResult(created = MetricCreatedCounts(hrvSamples = 1))
        } else {
            MetricWriteResult(duplicateSkipped = 1)
        }
    }
}

private data class MetricWriteResult(
    val created: MetricCreatedCounts = MetricCreatedCounts(),
    val duplicateSkipped: Int = 0,
    val affectedStepSummaryDates: Set<LocalDate> = emptySet(),
)

private sealed interface IngestionTransactionResult {
    data class Success(val response: IngestionSummaryResponse) :
        IngestionTransactionResult

    data class Failure(val throwable: Throwable) : IngestionTransactionResult
}

private fun affectedUtcDates(
    start: Instant,
    exclusiveEnd: Instant
): Set<LocalDate> {
    val lastIncludedDate = exclusiveEnd.minusNanos(1).utcDate()
    val dates = linkedSetOf<LocalDate>()
    var cursor = start.utcDate()
    while (!cursor.isAfter(lastIncludedDate)) {
        dates.add(cursor)
        cursor = cursor.plusDays(1)
    }
    return dates
}
