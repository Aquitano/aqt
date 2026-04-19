package me.aquitano.health.application

import kotlinx.coroutines.Dispatchers
import kotlinx.serialization.encodeToString
import me.aquitano.health.api.dto.CanonicalCreatedCountsResponse
import me.aquitano.health.api.dto.CanonicalSkippedCountsResponse
import me.aquitano.health.api.dto.IngestionBatchRequest
import me.aquitano.health.api.dto.IngestionSummaryResponse
import me.aquitano.health.domain.BodyMeasurementRecord
import me.aquitano.health.domain.CanonicalCreatedCounts
import me.aquitano.health.domain.HeartRateRecord
import me.aquitano.health.domain.SleepSessionRecord
import me.aquitano.health.domain.StepIntervalRecord
import me.aquitano.health.infrastructure.repositories.CanonicalWriteRepository
import me.aquitano.health.infrastructure.repositories.IngestionRepository
import me.aquitano.health.infrastructure.repositories.SupportRepository
import me.aquitano.health.shared.AppJson
import me.aquitano.health.shared.utcDate
import org.jetbrains.exposed.sql.Database
import org.jetbrains.exposed.sql.transactions.experimental.newSuspendedTransaction

class IngestionService(
    private val database: Database,
    private val derivationService: CanonicalDerivationService,
    private val supportRepository: SupportRepository,
    private val ingestionRepository: IngestionRepository,
    private val canonicalWriteRepository: CanonicalWriteRepository,
    private val stepSummaryService: StepSummaryService,
) {
    suspend fun ingestBatch(request: IngestionBatchRequest, now: java.time.Instant): IngestionSummaryResponse {
        val validated = derivationService.validateAndMap(request)
        val transactionResult = newSuspendedTransaction(Dispatchers.IO, db = database) {
            val sourceInstance = supportRepository.resolveOrCreateSourceInstanceInTransaction(
                provider = validated.provider,
                providerInstanceId = validated.providerInstanceId,
                now = now,
            )

            val existingBatch = validated.batchExternalId
                ?.let { ingestionRepository.findBatchByExternalId(sourceInstance.id, it) }
            if (existingBatch != null) {
                return@newSuspendedTransaction IngestionTransactionResult.Success(
                    IngestionSummaryResponse(
                        batchId = existingBatch.id,
                        status = existingBatch.status,
                        duplicateBatch = true,
                        recordsReceived = validated.records.size,
                        rawRecordsStored = 0,
                        canonicalRecordsCreated = CanonicalCreatedCountsResponse(0, 0, 0, 0, 0),
                        canonicalRecordsSkipped = CanonicalSkippedCountsResponse(duplicates = 0),
                        affectedStepSummaryDates = emptyList(),
                    ),
                )
            }

            val batchId = ingestionRepository.insertBatch(
                sourceInstanceId = sourceInstance.id,
                batchExternalId = validated.batchExternalId,
                rawPayloadJson = AppJson.encodeToString(validated.rawPayload),
                mappedPayloadJson = validated.mappedPayloadJson,
                ingestedAt = validated.ingestedAt,
                receivedAt = now,
            )
            val rawRecords = ingestionRepository.insertRawRecords(batchId, validated.records, now)

            var created = CanonicalCreatedCounts()
            var duplicateSkipped = 0
            val affectedDates = linkedSetOf<java.time.LocalDate>()

            try {
                rawRecords.forEach { rawRecord ->
                    when (val record = rawRecord.record) {
                        is StepIntervalRecord -> {
                            val inserted = canonicalWriteRepository.insertStepSample(sourceInstance.id, rawRecord.id, record, now)
                            if (inserted) {
                                created = created.copy(stepSamples = created.stepSamples + 1)
                                affectedDates.add(record.startAt.utcDate())
                            } else {
                                duplicateSkipped += 1
                            }
                        }
                        is SleepSessionRecord -> {
                            val sessionId = canonicalWriteRepository.insertSleepSession(sourceInstance.id, rawRecord.id, record, now)
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
                            val inserted = canonicalWriteRepository.insertBodyMeasurements(sourceInstance.id, rawRecord.id, record, now)
                            created = created.copy(bodyMeasurements = created.bodyMeasurements + inserted)
                            duplicateSkipped += record.measurements.size - inserted
                        }
                        is HeartRateRecord -> {
                            val inserted = canonicalWriteRepository.insertHeartRateSample(sourceInstance.id, rawRecord.id, record, now)
                            if (inserted) {
                                created = created.copy(heartRateSamples = created.heartRateSamples + 1)
                            } else {
                                duplicateSkipped += 1
                            }
                        }
                    }
                }
                stepSummaryService.recompute(sourceInstance.id, affectedDates, now)
                ingestionRepository.markProcessed(batchId, now)
            } catch (throwable: Throwable) {
                ingestionRepository.markFailed(batchId, now, throwable.message ?: "Unknown ingestion error")
                return@newSuspendedTransaction IngestionTransactionResult.Failure(throwable)
            }

            IngestionTransactionResult.Success(
                IngestionSummaryResponse(
                    batchId = batchId,
                    status = "processed",
                    duplicateBatch = false,
                    recordsReceived = validated.records.size,
                    rawRecordsStored = rawRecords.size,
                    canonicalRecordsCreated = CanonicalCreatedCountsResponse(
                        stepSamples = created.stepSamples,
                        sleepSessions = created.sleepSessions,
                        sleepStages = created.sleepStages,
                        bodyMeasurements = created.bodyMeasurements,
                        heartRateSamples = created.heartRateSamples,
                    ),
                    canonicalRecordsSkipped = CanonicalSkippedCountsResponse(duplicates = duplicateSkipped),
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
    data class Success(val response: IngestionSummaryResponse) : IngestionTransactionResult
    data class Failure(val throwable: Throwable) : IngestionTransactionResult
}
