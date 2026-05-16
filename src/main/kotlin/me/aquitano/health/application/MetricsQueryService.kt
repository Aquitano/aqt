package me.aquitano.health.application

import kotlinx.coroutines.Dispatchers
import me.aquitano.health.api.dto.*
import me.aquitano.health.domain.BodyMetricTypes
import me.aquitano.health.domain.RequestValidationException
import me.aquitano.health.domain.ValidationIssue
import me.aquitano.health.domain.ValidationIssueCodes
import me.aquitano.health.infrastructure.repositories.*
import me.aquitano.health.shared.utcDate
import org.jetbrains.exposed.sql.Database
import org.jetbrains.exposed.sql.transactions.experimental.newSuspendedTransaction
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset

class MetricsQueryService(
    private val database: Database,
    private val metricsReadRepository: MetricsReadRepository,
) {
    suspend fun listStepSamples(params: QueryParams): StepSamplesResponse =
        dbQuery {
            val filters = params.readFilters(
                defaultSort = SortFields.START_AT,
                allowedSorts = setOf(SortFields.START_AT),
                latestSupported = true,
            )
            val (rows, sourceMetadata) = metricsReadRepository.listStepSamples(
                filters
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
                meta = rows.meta(filters),
            )
        }

    suspend fun listStepDailySummaries(
        params: QueryParams,
        now: Instant
    ): StepDailySummariesResponse =
        dbQuery {
            params.rejectLatest()
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
                meta = rows.meta(filters),
            )
        }

    suspend fun listSleepSessions(params: QueryParams): SleepSessionsResponse =
        dbQuery {
            val filters = params.readFilters(
                defaultSort = SortFields.START_AT,
                allowedSorts = setOf(SortFields.START_AT),
                latestSupported = true,
            )
            val (sessions, stagesBySession, sourceMetadata) =
                metricsReadRepository.listSleepSessions(filters)
            SleepSessionsResponse(
                items = sessions.map { session ->
                    session.toResponse(stagesBySession, sourceMetadata)
                },
                meta = sessions.meta(filters),
            )
        }

    suspend fun listSleepNights(
        params: QueryParams,
        now: Instant,
    ): SleepNightsResponse =
        dbQuery {
            params.rejectLatest()
            val filters = params.sleepNightReadFilters(now)
            val (nights, stagesBySession, sourceMetadata) =
                metricsReadRepository.listSleepNights(filters)
            SleepNightsResponse(
                items = nights.map { night ->
                    night.toResponse(stagesBySession, sourceMetadata)
                },
                meta = nights.meta(filters),
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
            val filters = params.readFilters(
                defaultSort = SortFields.MEASURED_AT,
                allowedSorts = setOf(SortFields.MEASURED_AT),
                latestSupported = true,
            )
            val (rows, sourceMetadata) = metricsReadRepository.listBodyMeasurements(
                filters,
                metricType
            )
            BodyMeasurementsResponse(
                items = rows.map { it.toResponse(sourceMetadata) },
                meta = rows.meta(filters),
            )
        }
    }

    suspend fun listHeartRateSamples(params: QueryParams): HeartRateSamplesResponse =
        dbQuery {
            val filters = params.readFilters(
                defaultSort = SortFields.MEASURED_AT,
                allowedSorts = setOf(SortFields.MEASURED_AT),
                latestSupported = true,
            )
            val (rows, sourceMetadata) =
                metricsReadRepository.listHeartRateSamples(filters)
            HeartRateSamplesResponse(
                items = rows.map { it.toResponse(sourceMetadata) },
                meta = rows.meta(filters),
            )
        }

    suspend fun latestBodyMeasurement(params: QueryParams): BodyMeasurementLatestResponse {
        val metricType = params.required("metricType")
        validateBodyMetricType(metricType)
        return dbQuery {
            val (row, sourceMetadata) = metricsReadRepository.latestBodyMeasurement(
                params.summaryFilters(SortFields.MEASURED_AT),
                metricType,
            )
            BodyMeasurementLatestResponse(
                item = row?.toResponse(sourceMetadata),
            )
        }
    }

    suspend fun heartRateSummary(params: QueryParams): HeartRateSummaryResponse =
        dbQuery {
            val filters = params.summaryFilters(SortFields.MEASURED_AT)
            val summary = metricsReadRepository.summarizeHeartRate(filters)
            val (latest, sourceMetadata) =
                metricsReadRepository.latestHeartRateSample(filters)
            HeartRateSummaryResponse(
                count = summary.count,
                minBpm = summary.minBpm,
                maxBpm = summary.maxBpm,
                avgBpm = summary.avgBpm,
                latest = latest?.toResponse(sourceMetadata),
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
        val toInstant =
            toDate.plusDays(1).atStartOfDay().toInstant(ZoneOffset.UTC)
        return dbQuery {
            val dailyFilters = DailyReadFilters(
                fromDate = fromDate,
                toDate = toDate,
                provider = params.optional("provider"),
                providerInstanceId = params.optional("providerInstanceId"),
                includeSource = false,
                limit = 1,
                sort = SortFields.DATE,
                order = Orders.ASC,
            )
            val instantFilters = ReadFilters(
                from = fromInstant,
                to = toInstant,
                provider = params.optional("provider"),
                providerInstanceId = params.optional("providerInstanceId"),
                includeSource = includeSource,
                limit = 1,
                sort = SortFields.MEASURED_AT,
                order = Orders.DESC,
            )
            val sleepNightFilters = SleepNightReadFilters(
                fromDate = toDate,
                toDate = toDate,
                timezone = params.timezone(),
                provider = params.optional("provider"),
                providerInstanceId = params.optional("providerInstanceId"),
                includeSource = includeSource,
                limit = 1,
                sort = SortFields.DATE,
                order = Orders.ASC,
            )
            val steps =
                metricsReadRepository.sumStepDailySummaries(dailyFilters)
            val (weight, weightSourceMetadata) = metricsReadRepository.latestBodyMeasurement(
                instantFilters,
                BodyMetricTypes.WEIGHT
            )
            val (heartRate, heartRateSourceMetadata) =
                metricsReadRepository.latestHeartRateSample(instantFilters)
            val (sleepNights, sleepStagesBySession, sleepSourceMetadata) =
                metricsReadRepository.listSleepNights(sleepNightFilters)
            val sleep = sleepNights.firstOrNull()?.session
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

    private fun QueryParams.readFilters(
        defaultSort: String,
        allowedSorts: Set<String>,
        latestSupported: Boolean,
    ): ReadFilters {
        val latest = boolean("latest", default = false)
        if (latest && !latestSupported) {
            throw RequestValidationException(
                listOf(
                    ValidationIssue(
                        field = "latest",
                        code = ValidationIssueCodes.UnsupportedValue,
                        message = "latest is not supported for this endpoint",
                    )
                )
            )
        }
        if (latest) {
            validateLatestOverrides()
        }
        val from = instant("from")
        val to = instant("to")
        validateRange(from, to, "from", "to")
        return ReadFilters(
            from = from,
            to = to,
            provider = optional("provider"),
            providerInstanceId = optional("providerInstanceId"),
            includeSource = boolean("includeSource", default = false),
            limit = if (latest) 1 else limit(default = 500, max = 5000),
            sort = if (latest) defaultSort else sort(allowedSorts, defaultSort),
            order = if (latest) Orders.DESC else order(),
        )
    }

    private fun QueryParams.summaryFilters(defaultSort: String): ReadFilters {
        val from = instant("from")
        val to = instant("to")
        validateRange(from, to, "from", "to")
        return ReadFilters(
            from = from,
            to = to,
            provider = optional("provider"),
            providerInstanceId = optional("providerInstanceId"),
            includeSource = boolean("includeSource", default = false),
            limit = 1,
            sort = defaultSort,
            order = Orders.DESC,
        )
    }

    private fun QueryParams.sleepNightReadFilters(now: Instant): SleepNightReadFilters {
        val timezone = timezone()
        val exactDate = dateOrToday("date", now, timezone)
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
        return SleepNightReadFilters(
            fromDate = fromDate,
            toDate = toDate,
            timezone = timezone,
            provider = optional("provider"),
            providerInstanceId = optional("providerInstanceId"),
            includeSource = boolean("includeSource", default = false),
            limit = if (exactDate != null) 1 else limit(
                default = 500,
                max = 5000
            ),
            sort = sort(setOf(SortFields.DATE), SortFields.DATE),
            order = order(),
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
            limit = if (exactDate != null) 1 else limit(
                default = 500,
                max = 5000
            ),
            sort = sort(setOf(SortFields.DATE), SortFields.DATE),
            order = order(),
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

    fun required(name: String): String =
        optional(name) ?: throw RequestValidationException(
            listOf(
                ValidationIssue(
                    field = name,
                    code = ValidationIssueCodes.Required,
                    message = "is required",
                )
            )
        )

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

    fun dateOrToday(name: String, now: Instant, timezone: ZoneId): LocalDate? {
        val value = optional(name) ?: return null
        if (value == "today") return now.atZone(timezone).toLocalDate()
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

    fun timezone(name: String = "timezone"): ZoneId {
        val value = optional(name) ?: return ZoneOffset.UTC
        return runCatching { ZoneId.of(value) }.getOrElse {
            throw RequestValidationException(
                listOf(
                    ValidationIssue(
                        field = name,
                        code = ValidationIssueCodes.InvalidFormat,
                        message = "must be an IANA timezone",
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

    fun order(default: String = Orders.ASC): String {
        val value = optional("order") ?: return default
        val normalized = value.lowercase()
        if (normalized != Orders.ASC && normalized != Orders.DESC) {
            throw RequestValidationException(
                listOf(
                    ValidationIssue(
                        field = "order",
                        code = ValidationIssueCodes.UnsupportedValue,
                        message = "must be asc or desc",
                    )
                )
            )
        }
        return normalized
    }

    fun sort(allowedValues: Set<String>, default: String): String {
        val value = optional("sort") ?: return default
        if (value !in allowedValues) {
            throw RequestValidationException(
                listOf(
                    ValidationIssue(
                        field = "sort",
                        code = ValidationIssueCodes.UnsupportedValue,
                        message = "must be one of ${allowedValues.sorted().joinToString(", ")}",
                    )
                )
            )
        }
        return value
    }

    fun rejectLatest() {
        if (boolean("latest", default = false)) {
            throw RequestValidationException(
                listOf(
                    ValidationIssue(
                        field = "latest",
                        code = ValidationIssueCodes.UnsupportedValue,
                        message = "latest is not supported for this endpoint",
                    )
                )
            )
        }
    }

    fun validateLatestOverrides() {
        val invalidFields = listOf("limit", "sort", "order")
            .filter { optional(it) != null }
        if (invalidFields.isNotEmpty()) {
            throw RequestValidationException(
                invalidFields.map {
                    ValidationIssue(
                        field = it,
                        code = ValidationIssueCodes.InvalidState,
                        message = "cannot be combined with latest=true",
                    )
                }
            )
        }
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

private fun SleepNightRow.toResponse(
    stagesBySession: Map<Int, List<SleepStageRow>>,
    sourceMetadata: Map<Int, SourceMetadata>
): SleepNightResponse =
    SleepNightResponse(
        date = date,
        timezone = timezone,
        session = session.toResponse(stagesBySession, sourceMetadata),
    )

private fun <T> List<T>.meta(filters: ReadFilters): ReadResponseMeta =
    ReadResponseMeta(
        count = size,
        limit = filters.limit,
        sort = filters.sort,
        order = filters.order,
    )

private fun <T> List<T>.meta(filters: DailyReadFilters): ReadResponseMeta =
    ReadResponseMeta(
        count = size,
        limit = filters.limit,
        sort = filters.sort,
        order = filters.order,
    )

private fun <T> List<T>.meta(filters: SleepNightReadFilters): ReadResponseMeta =
    ReadResponseMeta(
        count = size,
        limit = filters.limit,
        sort = filters.sort,
        order = filters.order,
    )

private fun validateBodyMetricType(metricType: String) {
    if (metricType !in BodyMetricTypes.supported) {
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
}

private object SortFields {
    const val START_AT = "startAt"
    const val DATE = "date"
    const val MEASURED_AT = "measuredAt"
}

private object Orders {
    const val ASC = "asc"
    const val DESC = "desc"
}
