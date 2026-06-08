package me.aquitano.health.application

import me.aquitano.health.api.dto.IngestionBatchRequest
import me.aquitano.health.api.dto.IngestionSummaryResponse
import me.aquitano.health.api.dto.MetricCreatedCountsResponse
import me.aquitano.health.api.dto.MetricSkippedCountsResponse
import me.aquitano.health.application.metric.common.MetricWriteService
import me.aquitano.health.domain.*
import me.aquitano.health.infrastructure.repositories.IngestionRepository
import me.aquitano.health.infrastructure.repositories.SupportRepository
import me.aquitano.health.shared.AppJson
import org.jetbrains.exposed.v1.jdbc.Database
import org.jetbrains.exposed.v1.jdbc.transactions.suspendTransaction
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
) {
    suspend fun findExistingBatch(
        provider: String,
        providerInstanceId: String,
        batchExternalId: String,
        now: Instant,
    ) =
        suspendTransaction(db = database) {
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
            suspendTransaction(db = database) {
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
                    return@suspendTransaction IngestionTransactionResult.Success(
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
                                bloodPressureMeasurements = 0,
                                cardiovascularMeasurements = 0,
                                extendedBodyMeasurements = 0,
                            ),
                            metricsSkipped = MetricSkippedCountsResponse(
                                duplicates = 0
                            ),
                            affectedStepSummaryDates = emptyList(),
                        ),
                        DerivedRebuildRequest(
                            sourceInstanceId = sourceInstance.id,
                            stepSummaryDates = emptySet(),
                            sleepNightDates = emptySet(),
                            sleepSessionCanonicalDates = emptySet(),
                            heartRateCanonicalDates = emptySet(),
                            respiratoryRateCanonicalDates = emptySet(),
                            hrvCanonicalDates = emptySet(),
                            bodyMeasurementCanonicalDates = emptySet(),
                            sleepSummaryCanonicalDates = emptySet(),
                            activitySummaryCanonicalDates = emptySet(),
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
                val affectedStepDates = linkedSetOf<LocalDate>()
                val affectedSleepNightDates = linkedSetOf<LocalDate>()
                val affectedSleepSessionCanonicalDates = linkedSetOf<LocalDate>()
                val affectedHeartRateCanonicalDates = linkedSetOf<LocalDate>()
                val affectedRespiratoryRateCanonicalDates = linkedSetOf<LocalDate>()
                val affectedHrvCanonicalDates = linkedSetOf<LocalDate>()
                val affectedBodyMeasurementCanonicalDates = linkedSetOf<LocalDate>()
                val affectedSleepSummaryCanonicalDates = linkedSetOf<LocalDate>()
                val affectedActivitySummaryCanonicalDates = linkedSetOf<LocalDate>()

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
                        affectedStepDates.addAll(result.affectedStepSummaryDates)
                        affectedSleepNightDates.addAll(result.affectedSleepNightDates)
                        affectedSleepSessionCanonicalDates.addAll(result.affectedSleepSessionCanonicalDates)
                        affectedHeartRateCanonicalDates.addAll(result.affectedHeartRateCanonicalDates)
                        affectedRespiratoryRateCanonicalDates.addAll(result.affectedRespiratoryRateCanonicalDates)
                        affectedHrvCanonicalDates.addAll(result.affectedHrvCanonicalDates)
                        affectedBodyMeasurementCanonicalDates.addAll(result.affectedBodyMeasurementCanonicalDates)
                        affectedSleepSummaryCanonicalDates.addAll(result.affectedSleepSummaryCanonicalDates)
                        affectedActivitySummaryCanonicalDates.addAll(result.affectedActivitySummaryCanonicalDates)
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
                    return@suspendTransaction IngestionTransactionResult.Failure(
                        exception
                    )
                }

                val response = IngestionSummaryResponse(
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
                        bloodPressureMeasurements = created.bloodPressureMeasurements,
                        cardiovascularMeasurements = created.cardiovascularMeasurements,
                        extendedBodyMeasurements = created.extendedBodyMeasurements,
                    ),
                    metricsSkipped = MetricSkippedCountsResponse(
                        duplicates = duplicateSkipped
                    ),
                    affectedStepSummaryDates = affectedStepDates.map { it.toString() },
                )
                val rebuildRequest = DerivedRebuildRequest(
                    sourceInstanceId = sourceInstance.id,
                    stepSummaryDates = affectedStepDates.toSet(),
                    sleepNightDates = affectedSleepNightDates.toSet(),
                    sleepSessionCanonicalDates = affectedSleepSessionCanonicalDates.toSet(),
                    heartRateCanonicalDates = affectedHeartRateCanonicalDates.toSet(),
                    respiratoryRateCanonicalDates = affectedRespiratoryRateCanonicalDates.toSet(),
                    hrvCanonicalDates = affectedHrvCanonicalDates.toSet(),
                    bodyMeasurementCanonicalDates = affectedBodyMeasurementCanonicalDates.toSet(),
                    sleepSummaryCanonicalDates = affectedSleepSummaryCanonicalDates.toSet(),
                    activitySummaryCanonicalDates = affectedActivitySummaryCanonicalDates.toSet(),
                )
                IngestionTransactionResult.Success(
                    response,
                    rebuildRequest,
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
                        suspendTransaction(db = database) {
                            ingestionRepository.markDerivedRebuildFailed(
                                response.batchId,
                                now,
                                exception.message ?: "Unknown derived rebuild error",
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
                        "stepSamplesCreated" to response.metricsCreated.stepSamples,
                        "sleepSessionsCreated" to response.metricsCreated.sleepSessions,
                        "sleepStagesCreated" to response.metricsCreated.sleepStages,
                        "bodyMeasurementsCreated" to response.metricsCreated.bodyMeasurements,
                        "heartRateSamplesCreated" to response.metricsCreated.heartRateSamples,
                        "activitySummariesCreated" to response.metricsCreated.activitySummaries,
                        "sleepSummariesCreated" to response.metricsCreated.sleepSummaries,
                        "respiratoryRateSamplesCreated" to response.metricsCreated.respiratoryRateSamples,
                        "hrvSamplesCreated" to response.metricsCreated.hrvSamples,
                        "bloodPressureCreated" to response.metricsCreated.bloodPressureMeasurements,
                        "cardiovascularCreated" to response.metricsCreated.cardiovascularMeasurements,
                        "extendedBodyMeasurementsCreated" to response.metricsCreated.extendedBodyMeasurements,
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
    ) :
        IngestionTransactionResult

    data class Failure(val throwable: Throwable) : IngestionTransactionResult
}
