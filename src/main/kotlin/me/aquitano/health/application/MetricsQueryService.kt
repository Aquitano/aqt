package me.aquitano.health.application

import kotlinx.coroutines.Dispatchers
import me.aquitano.health.api.dto.*
import me.aquitano.health.domain.BodyMetricTypes
import me.aquitano.health.domain.RequestValidationException
import me.aquitano.health.domain.ValidationIssue
import me.aquitano.health.infrastructure.repositories.DailyReadFilters
import me.aquitano.health.infrastructure.repositories.MetricsReadRepository
import me.aquitano.health.infrastructure.repositories.ReadFilters
import me.aquitano.health.infrastructure.repositories.SourceMetadata
import org.jetbrains.exposed.sql.Database
import org.jetbrains.exposed.sql.transactions.experimental.newSuspendedTransaction
import java.time.Instant
import java.time.LocalDate

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

    suspend fun listStepDailySummaries(params: QueryParams): StepDailySummariesResponse =
        dbQuery {
            val (rows, sourceMetadata) = metricsReadRepository.listStepDailySummaries(
                params.dailyReadFilters()
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
            val (sessions, stagesBySession, sourceMetadata) = metricsReadRepository.listSleepSessions(
                params.readFilters()
            )
            SleepSessionsResponse(
                items = sessions.map { session ->
                    SleepSessionResponse(
                        id = session.id,
                        startAt = session.startAt,
                        endAt = session.endAt,
                        durationSeconds = session.durationSeconds,
                        stages = stagesBySession[session.id].orEmpty().map {
                            SleepStageResponse(
                                stage = it.stage,
                                startAt = it.startAt,
                                endAt = it.endAt,
                                durationSeconds = it.durationSeconds,
                            )
                        },
                        source = sourceMetadata[session.sourceInstanceId].toResponse(),
                    )
                },
            )
        }

    suspend fun listBodyMeasurements(params: QueryParams): BodyMeasurementsResponse {
        val metricType = params.optional("metricType")
        if (metricType != null && metricType !in BodyMetricTypes.supported) {
            throw RequestValidationException(
                listOf(
                    ValidationIssue(
                        "metricType",
                        "unsupported body metric type"
                    )
                )
            )
        }
        return dbQuery {
            val (rows, sourceMetadata) = metricsReadRepository.listBodyMeasurements(
                params.readFilters(),
                metricType
            )
            BodyMeasurementsResponse(
                items = rows.map {
                    BodyMeasurementResponse(
                        id = it.id,
                        measuredAt = it.measuredAt,
                        metricType = it.metricType,
                        value = it.value,
                        unit = it.unit,
                        source = sourceMetadata[it.sourceInstanceId].toResponse(),
                    )
                },
            )
        }
    }

    suspend fun listHeartRateSamples(params: QueryParams): HeartRateSamplesResponse =
        dbQuery {
            val (rows, sourceMetadata) = metricsReadRepository.listHeartRateSamples(
                params.readFilters()
            )
            HeartRateSamplesResponse(
                items = rows.map {
                    HeartRateSampleResponse(
                        id = it.id,
                        measuredAt = it.measuredAt,
                        bpm = it.bpm,
                        context = it.context,
                        source = sourceMetadata[it.sourceInstanceId].toResponse(),
                    )
                },
            )
        }

    private fun QueryParams.readFilters(): ReadFilters {
        val from = instant("from")
        val to = instant("to")
        validateRange(from, to, "from", "to")
        return ReadFilters(
            from = from,
            to = to,
            provider = optional("provider"),
            providerInstanceId = optional("providerInstanceId"),
            includeSource = boolean("includeSource", default = false),
            limit = limit(default = 500, max = 5000),
        )
    }

    private fun QueryParams.dailyReadFilters(): DailyReadFilters {
        val fromDate = date("fromDate")
        val toDate = date("toDate")
        if (fromDate != null && toDate != null && fromDate.isAfter(toDate)) {
            throw RequestValidationException(
                listOf(
                    ValidationIssue(
                        "fromDate",
                        "must be on or before toDate"
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
            limit = limit(default = 500, max = 5000),
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
                        name,
                        "must be an ISO-8601 instant"
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
                        name,
                        "must be an ISO-8601 date"
                    )
                )
            )
        }
    }

    fun boolean(name: String, default: Boolean): Boolean {
        val value = optional(name) ?: return default
        return when (value.lowercase()) {
            "true" -> true
            "false" -> false
            else -> throw RequestValidationException(
                listOf(
                    ValidationIssue(
                        name,
                        "must be true or false"
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
                        "limit",
                        "must be an integer"
                    )
                )
            )
        if (parsed !in 1..max) {
            throw RequestValidationException(
                listOf(
                    ValidationIssue(
                        "limit",
                        "must be between 1 and $max"
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
                    fromField,
                    "must be before $toField"
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
