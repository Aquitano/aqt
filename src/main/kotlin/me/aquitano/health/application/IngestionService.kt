package me.aquitano.health.application

import me.aquitano.health.api.dto.IngestionBatchRequest
import me.aquitano.health.api.dto.IngestionSummaryResponse
import me.aquitano.health.api.dto.MetricCreatedCountsResponse
import me.aquitano.health.api.dto.MetricSkippedCountsResponse
import me.aquitano.health.application.metric.activity.derived.CanonicalActivitySummaryDerivationService
import me.aquitano.health.application.metric.activity.repository.CanonicalActivitySummaryDerivationRepository
import me.aquitano.health.application.metric.body.derived.CanonicalBodyMeasurementDerivationService
import me.aquitano.health.application.metric.body.repository.CanonicalBodyMeasurementDerivationRepository
import me.aquitano.health.application.metric.heart.derived.CanonicalHeartRateDerivationService
import me.aquitano.health.application.metric.heart.repository.CanonicalHeartRateDerivationRepository
import me.aquitano.health.application.metric.hrv.derived.CanonicalHrvDerivationService
import me.aquitano.health.application.metric.hrv.repository.CanonicalHrvDerivationRepository
import me.aquitano.health.application.metric.common.MetricWriteService
import me.aquitano.health.application.metric.respiratory.derived.CanonicalRespiratoryRateDerivationService
import me.aquitano.health.application.metric.respiratory.repository.CanonicalRespiratoryRateDerivationRepository
import me.aquitano.health.application.metric.sleep.derived.CanonicalSleepSessionDerivationService
import me.aquitano.health.application.metric.sleep.repository.CanonicalSleepSessionDerivationRepository
import me.aquitano.health.application.metric.sleep.derived.CanonicalSleepSummaryDerivationService
import me.aquitano.health.application.metric.sleep.repository.CanonicalSleepSummaryDerivationRepository
import me.aquitano.health.application.metric.steps.derived.CanonicalStepDerivationService
import me.aquitano.health.application.metric.steps.repository.CanonicalStepDerivationRepository
import me.aquitano.health.domain.*
import me.aquitano.health.infrastructure.repositories.IngestionRepository
import me.aquitano.health.infrastructure.repositories.SupportRepository
import me.aquitano.health.shared.AppJson
import net.logstash.logback.argument.StructuredArguments.kv
import org.jetbrains.exposed.v1.jdbc.Database
import org.jetbrains.exposed.v1.jdbc.transactions.suspendTransaction
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
    private val metricWriteService: MetricWriteService,
    private val stepSummaryService: StepSummaryService,
    private val sleepNightService: SleepNightService,
    private val canonicalHeartRateService: CanonicalHeartRateDerivationService =
        CanonicalHeartRateDerivationService(CanonicalHeartRateDerivationRepository()),
    private val canonicalRespiratoryRateService: CanonicalRespiratoryRateDerivationService =
        CanonicalRespiratoryRateDerivationService(CanonicalRespiratoryRateDerivationRepository()),
    private val canonicalHrvService: CanonicalHrvDerivationService =
        CanonicalHrvDerivationService(CanonicalHrvDerivationRepository()),
    private val canonicalStepService: CanonicalStepDerivationService =
        CanonicalStepDerivationService(CanonicalStepDerivationRepository()),
    private val canonicalBodyMeasurementService: CanonicalBodyMeasurementDerivationService =
        CanonicalBodyMeasurementDerivationService(CanonicalBodyMeasurementDerivationRepository()),
    private val canonicalSleepSummaryService: CanonicalSleepSummaryDerivationService =
        CanonicalSleepSummaryDerivationService(CanonicalSleepSummaryDerivationRepository()),
    private val canonicalSleepSessionService: CanonicalSleepSessionDerivationService =
        CanonicalSleepSessionDerivationService(CanonicalSleepSessionDerivationRepository()),
    private val canonicalActivitySummaryService: CanonicalActivitySummaryDerivationService =
        CanonicalActivitySummaryDerivationService(CanonicalActivitySummaryDerivationRepository()),
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
        logger.info(
            "ingestion_batch_received {} {} {} {}",
            kv("provider", validated.provider),
            kv("providerInstanceId", validated.providerInstanceId),
            kv("recordCount", validated.records.size),
            kv("hasExternalId", validated.batchExternalId != null),
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
                    logger.info(
                        "ingestion_batch_duplicate {} {}",
                        kv("batchId", existingBatch.id),
                        kv("recordCount", validated.records.size),
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
                    stepSummaryService.recompute(
                        sourceInstance.id,
                        affectedStepDates,
                        now
                    )
                    canonicalStepService.recompute(affectedStepDates, now)
                    sleepNightService.recomputeUtc(
                        sourceInstance.id,
                        affectedSleepNightDates,
                        now
                    )
                    canonicalHeartRateService.recompute(affectedHeartRateCanonicalDates, now)
                    canonicalRespiratoryRateService.recompute(affectedRespiratoryRateCanonicalDates, now)
                    canonicalHrvService.recompute(affectedHrvCanonicalDates, now)
                    canonicalBodyMeasurementService.recompute(affectedBodyMeasurementCanonicalDates, now)
                    canonicalSleepSummaryService.recompute(affectedSleepSummaryCanonicalDates, now)
                    canonicalSleepSessionService.recompute(affectedSleepSessionCanonicalDates, now)
                    canonicalActivitySummaryService.recompute(affectedActivitySummaryCanonicalDates, now)
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
                    return@suspendTransaction IngestionTransactionResult.Failure(
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
                            bloodPressureMeasurements = created.bloodPressureMeasurements,
                            cardiovascularMeasurements = created.cardiovascularMeasurements,
                            extendedBodyMeasurements = created.extendedBodyMeasurements,
                        ),
                        metricsSkipped = MetricSkippedCountsResponse(
                            duplicates = duplicateSkipped
                        ),
                        affectedStepSummaryDates = affectedStepDates.map { it.toString() },
                    ),
                )
            }

        return when (transactionResult) {
            is IngestionTransactionResult.Success -> {
                val response = transactionResult.response
                if (!response.duplicateBatch) {
                    logger.info(
                        "ingestion_batch_processed {} {} {} {} {} {} {} {} {} {} {} {} {} {} {}",
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
                            "bloodPressureCreated",
                            response.metricsCreated.bloodPressureMeasurements
                        ),
                        kv(
                            "cardiovascularCreated",
                            response.metricsCreated.cardiovascularMeasurements
                        ),
                        kv(
                            "extendedBodyMeasurementsCreated",
                            response.metricsCreated.extendedBodyMeasurements
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
}

private sealed interface IngestionTransactionResult {
    data class Success(val response: IngestionSummaryResponse) :
        IngestionTransactionResult

    data class Failure(val throwable: Throwable) : IngestionTransactionResult
}
