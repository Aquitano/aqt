package me.aquitano.health.application

import io.github.oshai.kotlinlogging.KotlinLogging
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import me.aquitano.health.api.dto.IngestionRecordDto
import me.aquitano.health.api.dto.ReplayJobStatus
import me.aquitano.health.api.dto.ReplayJobStartResponse
import me.aquitano.health.api.dto.ReplayJobStatusResponse
import me.aquitano.health.api.dto.ReplayRequest
import me.aquitano.health.application.metric.common.MetricWriteService
import me.aquitano.health.application.metric.common.affectedUtcDates
import me.aquitano.health.domain.DerivedKind
import me.aquitano.health.domain.NotFoundException
import me.aquitano.health.domain.RecordTypes
import me.aquitano.health.domain.RequestValidationException
import me.aquitano.health.domain.ValidationIssue
import me.aquitano.health.domain.ValidationIssueCodes
import me.aquitano.health.infrastructure.logging.infoWithContext
import me.aquitano.health.infrastructure.logging.warnWithContext
import me.aquitano.health.infrastructure.repositories.IngestionRepository
import me.aquitano.health.infrastructure.repositories.ProjectionWipeRepository
import me.aquitano.health.infrastructure.repositories.ReplayJobRecord
import me.aquitano.health.infrastructure.repositories.ReplayJobRepository
import me.aquitano.health.infrastructure.repositories.ReplayRecordRow
import me.aquitano.health.infrastructure.time.UtcClock
import me.aquitano.health.shared.AppJson
import me.aquitano.health.shared.utcDate
import org.jetbrains.exposed.v1.jdbc.Database
import org.jetbrains.exposed.v1.jdbc.transactions.suspendTransaction
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.util.UUID
import java.util.concurrent.CancellationException

private val replayLogger = KotlinLogging.logger {}

object ReplayScopes {
    const val PROJECTIONS = "projections"
    const val DERIVED = "derived"
    const val ALL = "all"

    val supported = setOf(PROJECTIONS, DERIVED, ALL)
}

private val replayableRecordTypes = setOf(
    RecordTypes.STEP_INTERVAL,
    RecordTypes.SLEEP_SESSION,
    RecordTypes.BODY_MEASUREMENT,
    RecordTypes.HEART_RATE,
    RecordTypes.ACTIVITY_SUMMARY,
    RecordTypes.SLEEP_SUMMARY,
    RecordTypes.RESPIRATORY_RATE,
    RecordTypes.HRV,
    RecordTypes.BLOOD_PRESSURE,
    RecordTypes.CARDIOVASCULAR,
    RecordTypes.EXTENDED_BODY_MEASUREMENT,
    RecordTypes.SCALAR,
)

/**
 * Rebuilds metric projections from the raw event log (ingestion_records) for any date range.
 * The post-ingestion incremental derived rebuild is the special case of this operation that
 * runs for the dates touched by a single batch.
 */
class ReplayService(
    private val database: Database,
    private val ingestionRepository: IngestionRepository,
    private val mappingService: IngestionMappingService,
    private val metricWriteService: MetricWriteService,
    private val derivedRebuildExecutor: DerivedRebuildExecutor,
    private val replayJobRepository: ReplayJobRepository,
    private val projectionWipeRepository: ProjectionWipeRepository,
    private val clock: UtcClock,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
) {
    fun start(now: Instant) {
        scope.launch {
            replayJobRepository.markInterruptedUnfinishedJobs(now)
        }
    }

    fun stop() {
        scope.cancel()
    }

    suspend fun create(request: ReplayRequest, now: Instant): ReplayJobStartResponse {
        val plan = validate(request)
        val job = replayJobRepository.create(
            id = UUID.randomUUID().toString(),
            scope = plan.scope,
            metricTypes = plan.recordTypes?.toList(),
            fromDate = plan.fromDate,
            toDate = plan.toDate,
            wipe = plan.wipe,
            now = now,
        )

        scope.launch {
            runJob(job.id, plan)
        }

        return ReplayJobStartResponse(
            jobId = job.id,
            status = ReplayJobStatus.fromStored(job.status),
            createdAt = job.createdAt.toString(),
        )
    }

    suspend fun get(jobId: String): ReplayJobStatusResponse =
        replayJobRepository.get(jobId)?.toDto()
            ?: throw NotFoundException("Replay job '$jobId' not found")

    suspend fun latest(): ReplayJobStatusResponse? =
        replayJobRepository.latest()?.toDto()

    private suspend fun runJob(jobId: String, plan: ReplayPlan) {
        try {
            val days = planDays(plan)
            replayJobRepository.markRunning(jobId, days.size, clock.now())
            replayLogger.infoWithContext(
                "replay_job_started",
                "jobId" to jobId,
                "scope" to plan.scope,
                "days" to days.size,
                "wipe" to plan.wipe,
            )

            days.forEach { day ->
                replayJobRepository.markItemStarted(jobId, day.toString(), clock.now())
                val result = replayDay(day, plan)
                replayJobRepository.markItemCompleted(
                    id = jobId,
                    recordsReplayed = result.recordsReplayed,
                    metricsWritten = result.metricsWritten,
                    duplicatesSkipped = result.duplicatesSkipped,
                    mappingFailures = result.mappingFailures,
                    now = clock.now(),
                )
            }

            replayJobRepository.finish(jobId, "completed", null, clock.now())
            replayLogger.infoWithContext(
                "replay_job_completed",
                "jobId" to jobId,
                "days" to days.size,
            )
        } catch (exception: Exception) {
            if (exception is CancellationException) throw exception
            replayJobRepository.finish(
                jobId,
                "failed",
                exception.message ?: "Replay failed.",
                clock.now(),
            )
            replayLogger.warnWithContext(
                "replay_job_failed",
                "jobId" to jobId,
                throwable = exception,
            )
        }
    }

    private suspend fun planDays(plan: ReplayPlan): List<LocalDate> {
        val bounds = suspendTransaction(db = database) {
            ingestionRepository.replayDateBounds(plan.recordTypes)
        } ?: return emptyList()
        val firstDay = maxOf(bounds.first.utcDate(), plan.fromDate ?: bounds.first.utcDate())
        val lastDay = minOf(bounds.second.utcDate(), plan.toDate ?: bounds.second.utcDate())
        if (firstDay.isAfter(lastDay)) return emptyList()
        return generateSequence(firstDay) { it.plusDays(1) }
            .takeWhile { !it.isAfter(lastDay) }
            .toList()
    }

    private suspend fun replayDay(day: LocalDate, plan: ReplayPlan): DayReplayResult {
        val dayStart = day.atStartOfDay(ZoneOffset.UTC).toInstant()
        val dayEnd = day.plusDays(1).atStartOfDay(ZoneOffset.UTC).toInstant()
        val now = clock.now()
        val affectedBySource =
            mutableMapOf<Int, MutableMap<DerivedKind, MutableSet<LocalDate>>>()

        val result = suspendTransaction(db = database) {
            val rows = ingestionRepository.listRecordsForReplay(
                dayStart = dayStart,
                dayEnd = dayEnd,
                recordTypes = plan.recordTypes,
            )

            var recordsReplayed = 0
            var metricsWritten = 0
            var duplicatesSkipped = 0
            var mappingFailures = 0

            if (plan.includesProjections) {
                if (plan.wipe) {
                    projectionWipeRepository.wipeDay(
                        day = day,
                        dayStart = dayStart,
                        dayEnd = dayEnd,
                        recordTypes = plan.recordTypes ?: replayableRecordTypes,
                    )
                }
                rows.forEach { row ->
                    val record = decodeAndMap(row)
                    if (record == null) {
                        mappingFailures += 1
                        return@forEach
                    }
                    val writeResult = metricWriteService.write(
                        provider = row.provider,
                        sourceInstanceId = row.sourceInstanceId,
                        ingestionRecordId = row.id,
                        record = record,
                        now = now,
                    )
                    recordsReplayed += 1
                    metricsWritten += writeResult.created.counts.values.sum()
                    duplicatesSkipped += writeResult.duplicateSkipped
                }
            }

            if (plan.includesDerived) {
                rows.forEach { row ->
                    derivedDatesFor(row).forEach { (kind, dates) ->
                        affectedBySource
                            .getOrPut(row.sourceInstanceId) { mutableMapOf() }
                            .getOrPut(kind) { linkedSetOf() }
                            .addAll(dates)
                    }
                }
            }

            DayReplayResult(recordsReplayed, metricsWritten, duplicatesSkipped, mappingFailures)
        }

        affectedBySource.forEach { (sourceInstanceId, affectedDates) ->
            derivedRebuildExecutor.rebuild(
                DerivedRebuildRequest(
                    sourceInstanceId = sourceInstanceId,
                    affectedDates = affectedDates.mapValues { it.value.toSet() },
                ),
                clock.now(),
            )
        }

        return result
    }

    private fun decodeAndMap(row: ReplayRecordRow) =
        runCatching {
            AppJson.decodeFromString(IngestionRecordDto.serializer(), row.normalizedRecordJson)
        }.getOrElse { exception ->
            replayLogger.warnWithContext(
                "replay_record_decode_failed",
                "ingestionRecordId" to row.id,
                "recordType" to row.recordType,
                throwable = exception,
            )
            null
        }?.let { dto ->
            mappingService.mapRecord(dto).also { record ->
                if (record == null) {
                    replayLogger.warnWithContext(
                        "replay_record_mapping_failed",
                        "ingestionRecordId" to row.id,
                        "recordType" to row.recordType,
                    )
                }
            }
        }

    private fun derivedDatesFor(row: ReplayRecordRow): Map<DerivedKind, Set<LocalDate>> =
        when (row.recordType) {
            RecordTypes.STEP_INTERVAL -> mapOf(
                DerivedKind.STEP_SUMMARY to affectedUtcDates(
                    row.recordStartAt,
                    row.recordEndAt ?: row.recordStartAt.plusNanos(1),
                ),
            )

            RecordTypes.SLEEP_SESSION -> mapOf(
                DerivedKind.SLEEP_NIGHT to setOf((row.recordEndAt ?: row.recordStartAt).utcDate()),
            )

            else -> emptyMap()
        }

    private fun validate(request: ReplayRequest): ReplayPlan {
        val issues = mutableListOf<ValidationIssue>()

        if (request.scope !in ReplayScopes.supported) {
            issues.add(
                ValidationIssue(
                    field = "scope",
                    code = ValidationIssueCodes.UnsupportedValue,
                    message = "must be one of ${ReplayScopes.supported.sorted()}",
                )
            )
        }

        val recordTypes = request.metricTypes?.toSet()
        recordTypes?.minus(replayableRecordTypes)?.forEach { unknown ->
            issues.add(
                ValidationIssue(
                    field = "metricTypes",
                    code = ValidationIssueCodes.UnsupportedValue,
                    message = "unsupported record type '$unknown'",
                )
            )
        }

        val fromDate = request.fromDate?.let { parseDate(it, "fromDate", issues) }
        val toDate = request.toDate?.let { parseDate(it, "toDate", issues) }
        if (fromDate != null && toDate != null && fromDate.isAfter(toDate)) {
            issues.add(
                ValidationIssue(
                    field = "fromDate",
                    code = ValidationIssueCodes.InvalidRange,
                    message = "must not be after toDate",
                )
            )
        }
        if (request.wipe && request.scope == ReplayScopes.DERIVED) {
            issues.add(
                ValidationIssue(
                    field = "wipe",
                    code = ValidationIssueCodes.InvalidState,
                    message = "wipe requires the projections stage",
                )
            )
        }

        if (issues.isNotEmpty()) throw RequestValidationException(issues)

        return ReplayPlan(
            scope = request.scope,
            recordTypes = recordTypes,
            fromDate = fromDate,
            toDate = toDate,
            wipe = request.wipe,
        )
    }

    private fun parseDate(
        value: String,
        field: String,
        issues: MutableList<ValidationIssue>,
    ): LocalDate? =
        runCatching { LocalDate.parse(value) }.getOrElse {
            issues.add(
                ValidationIssue(
                    field = field,
                    code = ValidationIssueCodes.InvalidFormat,
                    message = "must be an ISO-8601 date",
                )
            )
            null
        }

    private fun ReplayJobRecord.toDto(): ReplayJobStatusResponse =
        ReplayJobStatusResponse(
            jobId = id,
            scope = scope,
            metricTypes = metricTypes,
            fromDate = fromDate?.toString(),
            toDate = toDate?.toString(),
            wipe = wipe,
            status = ReplayJobStatus.fromStored(status),
            totalItems = totalItems,
            completedItems = completedItems,
            currentItem = currentItem,
            recordsReplayed = recordsReplayed,
            metricsWritten = metricsWritten,
            duplicatesSkipped = duplicatesSkipped,
            mappingFailures = mappingFailures,
            errorMessage = errorMessage,
            createdAt = createdAt.toString(),
            startedAt = startedAt?.toString(),
            updatedAt = updatedAt.toString(),
            finishedAt = finishedAt?.toString(),
        )
}

private data class ReplayPlan(
    val scope: String,
    val recordTypes: Set<String>?,
    val fromDate: LocalDate?,
    val toDate: LocalDate?,
    val wipe: Boolean,
) {
    val includesProjections: Boolean
        get() = scope == ReplayScopes.PROJECTIONS || scope == ReplayScopes.ALL

    val includesDerived: Boolean
        get() = scope == ReplayScopes.DERIVED || scope == ReplayScopes.ALL
}

private data class DayReplayResult(
    val recordsReplayed: Int,
    val metricsWritten: Int,
    val duplicatesSkipped: Int,
    val mappingFailures: Int,
)
