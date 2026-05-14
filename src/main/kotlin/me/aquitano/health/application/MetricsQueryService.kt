package me.aquitano.health.application

import kotlinx.coroutines.Dispatchers
import me.aquitano.health.api.dto.*
import me.aquitano.health.domain.BodyMetricTypes
import me.aquitano.health.domain.RequestValidationException
import me.aquitano.health.domain.ValidationIssue
import me.aquitano.health.domain.ValidationIssueCodes
import me.aquitano.health.shared.utcDate
import me.aquitano.health.infrastructure.repositories.BodyMeasurementRow
import me.aquitano.health.infrastructure.repositories.DailyReadFilters
import me.aquitano.health.infrastructure.repositories.HeartRateSampleRow
import me.aquitano.health.infrastructure.repositories.MetricsReadRepository
import me.aquitano.health.infrastructure.repositories.ReadFilters
import me.aquitano.health.infrastructure.repositories.SleepSessionRow
import me.aquitano.health.infrastructure.repositories.SleepStageRow
import me.aquitano.health.infrastructure.repositories.SourceMetadata
import org.jetbrains.exposed.sql.Database
import org.jetbrains.exposed.sql.transactions.experimental.newSuspendedTransaction
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

class MetricsQueryService(
    private val database: Database,
    private val metricsReadRepository: MetricsReadRepository,
) {
    suspend fun listStepSamples(params: QueryParams): StepSamplesResponse =
        dbQuery {
            val (rows, sourceMetadata) = metricsReadRepository.listStepSamples(
                params.readFilters()
            )
            StepSamplesResponse(
                items = rows.map {
                    StepSampleResponse(
                        id = it.id,
                        startAt = it.startAt,
                        endAt = it.endAt,
                        steps = it.steps,
                        source = sourceMetadata[it.sourceInstanceId].toResponse(),
                    )
                },
            )
        }

    suspend fun listStepDailySummaries(
        params: QueryParams,
        now: Instant
    ): StepDailySummariesResponse =
        dbQuery {
            val filters = params.dailyReadFilters(now)
            val (rows, sourceMetadata) = metricsReadRepository.listStepDailySummaries(
                filters
            )
            StepDailySummariesResponse(
                items = rows.map {
                    StepDailySummaryResponse(
                        date = it.date,
                        steps = it.steps,
                        sampleCount = it.sampleCount,
                        source = sourceMetadata[it.sourceInstanceId].toResponse(),
                    )
                },
            )
        }

    suspend fun listSleepSessions(params: QueryParams): SleepSessionsResponse =
        dbQuery {
            val latest = params.boolean("latest", default = false)
            val (sessions, stagesBySession, sourceMetadata) = if (latest) {
                val (session, stages, metadata) = metricsReadRepository.latestSleepSession(
                    params.readFilters(limitOverride = 1)
                )
                Triple(listOfNotNull(session), stages, metadata)
            } else {
                metricsReadRepository.listSleepSessions(params.readFilters())
            }
            SleepSessionsResponse(
                items = sessions.map { session ->
                    session.toResponse(stagesBySession, sourceMetadata)
                },
            )
        }

    suspend fun listBodyMeasurements(params: QueryParams): BodyMeasurementsResponse {
        val metricType = params.optional("metricType")
        if (metricType != null && metricType !in BodyMetricTypes.supported) {
            throw RequestValidationException(
                listOf(
                    ValidationIssue(
                        field = "metricType",
                        code = ValidationIssueCodes.UnsupportedValue,
                        message = "unsupported body metric type",
                    )
                )
            )
        }
        return dbQuery {
            val latest = params.boolean("latest", default = false)
            val (rows, sourceMetadata) = if (latest) {
                val (row, metadata) = metricsReadRepository.latestBodyMeasurement(
                    params.readFilters(limitOverride = 1),
                    metricType
                )
                listOfNotNull(row) to metadata
            } else {
                metricsReadRepository.listBodyMeasurements(
                    params.readFilters(),
                    metricType
                )
            }
            BodyMeasurementsResponse(
                items = rows.map { it.toResponse(sourceMetadata) },
            )
        }
    }

    suspend fun listHeartRateSamples(params: QueryParams): HeartRateSamplesResponse =
        dbQuery {
            val latest = params.boolean("latest", default = false)
            val (rows, sourceMetadata) = if (latest) {
                val (row, metadata) = metricsReadRepository.latestHeartRateSample(
                    params.readFilters(limitOverride = 1)
                )
                listOfNotNull(row) to metadata
            } else {
                metricsReadRepository.listHeartRateSamples(params.readFilters())
            }
            HeartRateSamplesResponse(
                items = rows.map { it.toResponse(sourceMetadata) },
            )
        }

    suspend fun dashboardSummary(
        params: QueryParams,
        now: Instant,
    ): DashboardSummaryResponse {
        val fromDate = params.requiredDate("fromDate")
        val toDate = params.requiredDate("toDate")
        if (fromDate.isAfter(toDate)) {
            throw RequestValidationException(
                listOf(
                    ValidationIssue(
                        field = "fromDate",
                        code = ValidationIssueCodes.InvalidRange,
                        message = "must be on or before toDate",
                    )
                )
            )
        }
        val includeSource = params.boolean("includeSource", default = false)
        val fromInstant = fromDate.atStartOfDay().toInstant(ZoneOffset.UTC)
        val toInstant = toDate.plusDays(1).atStartOfDay().toInstant(ZoneOffset.UTC)
        return dbQuery {
            val dailyFilters = DailyReadFilters(
                fromDate = fromDate,
                toDate = toDate,
                provider = params.optional("provider"),
                providerInstanceId = params.optional("providerInstanceId"),
                includeSource = false,
                limit = 1,
            )
            val instantFilters = ReadFilters(
                from = fromInstant,
                to = toInstant,
                provider = params.optional("provider"),
                providerInstanceId = params.optional("providerInstanceId"),
                includeSource = includeSource,
                limit = 1,
            )
            val steps = metricsReadRepository.sumStepDailySummaries(dailyFilters)
            val (weight, weightSourceMetadata) = metricsReadRepository.latestBodyMeasurement(
                instantFilters,
                BodyMetricTypes.WEIGHT
            )
            val (heartRate, heartRateSourceMetadata) =
                metricsReadRepository.latestHeartRateSample(instantFilters)
            val (sleep, sleepStagesBySession, sleepSourceMetadata) =
                metricsReadRepository.latestSleepSession(instantFilters)
            DashboardSummaryResponse(
                fromDate = fromDate.toString(),
                toDate = toDate.toString(),
                steps = DashboardStepsSummaryResponse(
                    steps = steps.steps,
                    sampleCount = steps.sampleCount,
                ),
                latestWeight = weight?.toResponse(weightSourceMetadata),
                latestHeartRate = heartRate?.toResponse(heartRateSourceMetadata),
                lastSleepSession = sleep?.toResponse(
                    sleepStagesBySession,
                    sleepSourceMetadata
                ),
            )
        }
    }

    private fun QueryParams.readFilters(limitOverride: Int? = null): ReadFilters {
        val from = instant("from")
        val to = instant("to")
        validateRange(from, to, "from", "to")
        return ReadFilters(
            from = from,
            to = to,
            provider = optional("provider"),
            providerInstanceId = optional("providerInstanceId"),
            includeSource = boolean("includeSource", default = false),
            limit = limitOverride ?: limit(default = 500, max = 5000),
        )
    }

    private fun QueryParams.dailyReadFilters(now: Instant): DailyReadFilters {
        val exactDate = dateOrToday("date", now)
        if (exactDate != null && (optional("fromDate") != null || optional("toDate") != null)) {
            throw RequestValidationException(
                listOf(
                    ValidationIssue(
                        field = "date",
                        code = ValidationIssueCodes.InvalidState,
                        message = "cannot be combined with fromDate or toDate",
                    )
                )
            )
        }
        val fromDate = exactDate ?: date("fromDate")
        val toDate = exactDate ?: date("toDate")
        if (fromDate != null && toDate != null && fromDate.isAfter(toDate)) {
            throw RequestValidationException(
                listOf(
                    ValidationIssue(
                        field = "fromDate",
                        code = ValidationIssueCodes.InvalidRange,
                        message = "must be on or before toDate",
                    )
                )
            )
        }
        return DailyReadFilters(
            fromDate = fromDate,
            toDate = toDate,
            provider = optional("provider"),
            providerInstanceId = optional("providerInstanceId"),
            includeSource = boolean("includeSource", default = false),
            limit = if (exactDate != null) 1 else limit(default = 500, max = 5000),
        )
    }

    private suspend fun <T> dbQuery(block: () -> T): T =
        newSuspendedTransaction(Dispatchers.IO, db = database) {
            block()
        }
}

class QueryParams(
    private val values: Map<String, String?>,
) {
    fun optional(name: String): String? =
        values[name]?.takeIf { it.isNotBlank() }

    fun instant(name: String): Instant? {
        val value = optional(name) ?: return null
        return runCatching { Instant.parse(value) }.getOrElse {
            throw RequestValidationException(
                listOf(
                    ValidationIssue(
                        field = name,
                        code = ValidationIssueCodes.InvalidFormat,
                        message = "must be an ISO-8601 instant",
                    )
                )
            )
        }
    }

    fun date(name: String): LocalDate? {
        val value = optional(name) ?: return null
        return runCatching { LocalDate.parse(value) }.getOrElse {
            throw RequestValidationException(
                listOf(
                    ValidationIssue(
                        field = name,
                        code = ValidationIssueCodes.InvalidFormat,
                        message = "must be an ISO-8601 date",
                    )
                )
            )
        }
    }

    fun dateOrToday(name: String, now: Instant): LocalDate? {
        val value = optional(name) ?: return null
        if (value == "today") return now.utcDate()
        return runCatching { LocalDate.parse(value) }.getOrElse {
            throw RequestValidationException(
                listOf(
                    ValidationIssue(
                        field = name,
                        code = ValidationIssueCodes.InvalidFormat,
                        message = "must be an ISO-8601 date or today",
                    )
                )
            )
        }
    }

    fun requiredDate(name: String): LocalDate =
        date(name) ?: throw RequestValidationException(
            listOf(
                ValidationIssue(
                    field = name,
                    code = ValidationIssueCodes.Required,
                    message = "is required",
                )
            )
        )

    fun boolean(name: String, default: Boolean): Boolean {
        val value = optional(name) ?: return default
        return when (value.lowercase()) {
            "true" -> true
            "false" -> false
            else -> throw RequestValidationException(
                listOf(
                    ValidationIssue(
                        field = name,
                        code = ValidationIssueCodes.InvalidFormat,
                        message = "must be true or false",
                    )
                )
            )
        }
    }

    fun limit(default: Int, max: Int): Int {
        val value = optional("limit") ?: return default
        val parsed = value.toIntOrNull()
            ?: throw RequestValidationException(
                listOf(
                    ValidationIssue(
                        field = "limit",
                        code = ValidationIssueCodes.InvalidFormat,
                        message = "must be an integer",
                    )
                )
            )
        if (parsed !in 1..max) {
            throw RequestValidationException(
                listOf(
                    ValidationIssue(
                        field = "limit",
                        code = ValidationIssueCodes.OutOfRange,
                        message = "must be between 1 and $max",
                    )
                )
            )
        }
        return parsed
    }
}

fun validateRange(
    from: Instant?,
    to: Instant?,
    fromField: String,
    toField: String
) {
    if (from != null && to != null && !from.isBefore(to)) {
        throw RequestValidationException(
            listOf(
                ValidationIssue(
                    field = fromField,
                    code = ValidationIssueCodes.InvalidRange,
                    message = "must be before $toField",
                )
            )
        )
    }
}

private fun SourceMetadata?.toResponse(): SourceMetadataResponse? =
    this?.let {
        SourceMetadataResponse(
            provider = it.provider,
            providerInstanceId = it.providerInstanceId
        )
    }

private fun BodyMeasurementRow.toResponse(
    sourceMetadata: Map<Int, SourceMetadata>
): BodyMeasurementResponse =
    BodyMeasurementResponse(
        id = id,
        measuredAt = measuredAt,
        metricType = metricType,
        value = value,
        unit = unit,
        source = sourceMetadata[sourceInstanceId].toResponse(),
    )

private fun HeartRateSampleRow.toResponse(
    sourceMetadata: Map<Int, SourceMetadata>
): HeartRateSampleResponse =
    HeartRateSampleResponse(
        id = id,
        measuredAt = measuredAt,
        bpm = bpm,
        context = context,
        source = sourceMetadata[sourceInstanceId].toResponse(),
    )

private fun SleepSessionRow.toResponse(
    stagesBySession: Map<Int, List<SleepStageRow>>,
    sourceMetadata: Map<Int, SourceMetadata>
): SleepSessionResponse =
    SleepSessionResponse(
        id = id,
        startAt = startAt,
        endAt = endAt,
        durationSeconds = durationSeconds,
        stages = stagesBySession[id].orEmpty().map {
            SleepStageResponse(
                stage = it.stage,
                startAt = it.startAt,
                endAt = it.endAt,
                durationSeconds = it.durationSeconds,
            )
        },
        source = sourceMetadata[sourceInstanceId].toResponse(),
    )
