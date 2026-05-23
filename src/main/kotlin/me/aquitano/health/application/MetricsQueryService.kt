package me.aquitano.health.application

import me.aquitano.health.api.dto.*
import me.aquitano.health.domain.BodyMetricTypes
import me.aquitano.health.domain.HrvMetricTypes
import me.aquitano.health.domain.RequestValidationException
import me.aquitano.health.domain.ValidationIssue
import me.aquitano.health.domain.ValidationIssueCodes
import me.aquitano.health.infrastructure.repositories.*
import me.aquitano.health.shared.utcDate
import org.jetbrains.exposed.v1.jdbc.Database
import org.jetbrains.exposed.v1.jdbc.transactions.suspendTransaction
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset

class MetricsQueryService(
    private val database: Database,
    private val metricsReadRepository: MetricsReadRepository,
    private val canonicalMetricsService: CanonicalMetricsService,
) {
    suspend fun listActivitySummaries(
        params: QueryParams,
        now: Instant,
    ): ActivitySummariesResponse =
        dbQuery {
            val filters = params.dailyReadFilters(now)
            val canonical = params.canonical(default = false)
            val (rawRows, sourceMetadata) =
                metricsReadRepository.listActivitySummaries(filters)
            val rows = if (canonical) {
                canonicalMetricsService.canonicalActivitySummaries(
                    rawRows,
                    metricsReadRepository.sourceMetadataFor(rawRows.sourceIds { it.sourceInstanceId }),
                )
            } else {
                rawRows
            }
            ActivitySummariesResponse(
                items = rows.map { it.toResponse(sourceMetadata) },
                meta = rows.meta(filters),
            )
        }

    suspend fun latestActivitySummary(
        params: QueryParams,
        now: Instant,
    ): ActivitySummaryLatestResponse =
        dbQuery {
            val filters = params.dailyLatestReadFilters(now)
            val canonical = params.canonical(default = true)
            val (row, sourceMetadata) = if (canonical) {
                val (rows, metadata) = metricsReadRepository.listActivitySummaries(
                    filters.copy(limit = Int.MAX_VALUE)
                )
                val canonicalRows = canonicalMetricsService.canonicalActivitySummaries(
                    rows,
                    metricsReadRepository.sourceMetadataFor(rows.sourceIds { it.sourceInstanceId }),
                )
                canonicalRows.maxWithOrNull(compareBy<ActivitySummaryRow> { it.date }.thenBy { it.id }) to metadata
            } else {
                metricsReadRepository.latestActivitySummary(filters)
            }
            ActivitySummaryLatestResponse(
                item = row?.toResponse(sourceMetadata),
            )
        }

    suspend fun listStepSamples(params: QueryParams): StepSamplesResponse =
        dbQuery {
            val canonical = params.canonical(default = params.boolean("latest", default = false))
            val filters = params.readFilters(
                defaultSort = SortFields.START_AT,
                allowedSorts = setOf(SortFields.START_AT),
                latestSupported = true,
            )
            val (rawRows, sourceMetadata) = metricsReadRepository.listStepSamples(
                filters
            )
            val rows = if (canonical) {
                canonicalMetricsService.canonicalStepSamples(
                    rawRows,
                    metricsReadRepository.sourceMetadataFor(rawRows.sourceIds { it.sourceInstanceId }),
                )
            } else {
                rawRows
            }
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
            val canonical = params.canonical(default = false)
            val (rawRows, sourceMetadata) = metricsReadRepository.listStepDailySummaries(
                filters
            )
            val rows = if (canonical) {
                canonicalMetricsService.canonicalStepDailySummaries(
                    rawRows,
                    metricsReadRepository.sourceMetadataFor(rawRows.sourceIds { it.sourceInstanceId }),
                )
            } else {
                rawRows
            }
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
            val canonical = params.canonical(default = params.boolean("latest", default = false))
            val filters = params.readFilters(
                defaultSort = SortFields.START_AT,
                allowedSorts = setOf(SortFields.START_AT),
                latestSupported = true,
            )
            val (rawSessions, stagesBySession, sourceMetadata) =
                metricsReadRepository.listSleepSessions(filters)
            val sessions = if (canonical) {
                canonicalMetricsService.canonicalSleepSessions(
                    rawSessions,
                    stagesBySession,
                    metricsReadRepository.sourceMetadataFor(rawSessions.sourceIds { it.sourceInstanceId }),
                )
            } else {
                rawSessions
            }
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
            val canonical = params.canonical(default = false)
            val (rawNights, stagesBySession, sourceMetadata) =
                metricsReadRepository.listSleepNights(filters)
            val canonicalSessionIds = if (canonical) {
                canonicalMetricsService.canonicalSleepSessions(
                    rawNights.map { it.session },
                    stagesBySession,
                    metricsReadRepository.sourceMetadataFor(rawNights.map { it.session }.sourceIds { it.sourceInstanceId }),
                ).map { it.id }.toSet()
            } else {
                rawNights.map { it.session.id }.toSet()
            }
            val nights = rawNights.filter { it.session.id in canonicalSessionIds }
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
            val canonical = params.canonical(default = params.boolean("latest", default = false))
            val filters = params.readFilters(
                defaultSort = SortFields.MEASURED_AT,
                allowedSorts = setOf(SortFields.MEASURED_AT),
                latestSupported = true,
            )
            val (rawRows, sourceMetadata) = metricsReadRepository.listBodyMeasurements(
                filters,
                metricType
            )
            val rows = if (canonical) {
                canonicalMetricsService.canonicalBodyMeasurements(
                    rawRows,
                    metricsReadRepository.sourceMetadataFor(rawRows.sourceIds { it.sourceInstanceId }),
                )
            } else {
                rawRows
            }
            BodyMeasurementsResponse(
                items = rows.map { it.toResponse(sourceMetadata) },
                meta = rows.meta(filters),
            )
        }
    }

    suspend fun listHeartRateSamples(params: QueryParams): HeartRateSamplesResponse =
        dbQuery {
            val canonical = params.canonical(default = params.boolean("latest", default = false))
            val filters = params.readFilters(
                defaultSort = SortFields.MEASURED_AT,
                allowedSorts = setOf(SortFields.MEASURED_AT),
                latestSupported = true,
            )
            val (rawRows, sourceMetadata) =
                metricsReadRepository.listHeartRateSamples(filters)
            val rows = if (canonical) {
                canonicalMetricsService.canonicalHeartRateSamples(
                    rawRows,
                    metricsReadRepository.sourceMetadataFor(rawRows.sourceIds { it.sourceInstanceId }),
                )
            } else {
                rawRows
            }
            HeartRateSamplesResponse(
                items = rows.map { it.toResponse(sourceMetadata) },
                meta = rows.meta(filters),
            )
        }

    suspend fun listRespiratoryRateSamples(params: QueryParams): RespiratoryRateSamplesResponse =
        dbQuery {
            val canonical = params.canonical(default = params.boolean("latest", default = false))
            val filters = params.readFilters(
                defaultSort = SortFields.MEASURED_AT,
                allowedSorts = setOf(SortFields.MEASURED_AT),
                latestSupported = true,
            )
            val (rawRows, sourceMetadata) =
                metricsReadRepository.listRespiratoryRateSamples(filters)
            val rows = if (canonical) {
                canonicalMetricsService.canonicalRespiratoryRateSamples(
                    rawRows,
                    metricsReadRepository.sourceMetadataFor(rawRows.sourceIds { it.sourceInstanceId }),
                )
            } else {
                rawRows
            }
            RespiratoryRateSamplesResponse(
                items = rows.map { it.toResponse(sourceMetadata) },
                meta = rows.meta(filters),
            )
        }

    suspend fun respiratoryRateSummary(params: QueryParams): RespiratoryRateSummaryResponse =
        dbQuery {
            val filters = params.summaryFilters(SortFields.MEASURED_AT)
            val canonical = params.canonical(default = true)
            val (summary, latest, sourceMetadata) = if (canonical) {
                val (rows, metadata) = metricsReadRepository.listRespiratoryRateSamples(
                    filters.copy(limit = Int.MAX_VALUE, order = Orders.ASC)
                )
                val canonicalRows = canonicalMetricsService.canonicalRespiratoryRateSamples(
                    rows,
                    metricsReadRepository.sourceMetadataFor(rows.sourceIds { it.sourceInstanceId }),
                )
                Triple(
                    canonicalRows.respiratoryRateSummary(),
                    canonicalRows.maxWithOrNull(compareBy<RespiratoryRateSampleRow> { it.measuredAt }.thenBy { it.id }),
                    metadata,
                )
            } else {
                val (latest, metadata) = metricsReadRepository.latestRespiratoryRateSample(filters)
                Triple(metricsReadRepository.summarizeRespiratoryRate(filters), latest, metadata)
            }
            RespiratoryRateSummaryResponse(
                count = summary.count,
                minBreathsPerMinute = summary.minBreathsPerMinute,
                maxBreathsPerMinute = summary.maxBreathsPerMinute,
                avgBreathsPerMinute = summary.avgBreathsPerMinute,
                latest = latest?.toResponse(sourceMetadata),
            )
        }

    suspend fun listHrvSamples(params: QueryParams): HrvSamplesResponse {
        val metricType = params.optional("metricType") ?: HrvMetricTypes.RMSSD
        validateHrvMetricType(metricType)
        return dbQuery {
            val canonical = params.canonical(default = params.boolean("latest", default = false))
            val filters = params.readFilters(
                defaultSort = SortFields.MEASURED_AT,
                allowedSorts = setOf(SortFields.MEASURED_AT),
                latestSupported = true,
            )
            val (rawRows, sourceMetadata) =
                metricsReadRepository.listHrvSamples(filters, metricType)
            val rows = if (canonical) {
                canonicalMetricsService.canonicalHrvSamples(
                    rawRows,
                    metricsReadRepository.sourceMetadataFor(rawRows.sourceIds { it.sourceInstanceId }),
                )
            } else {
                rawRows
            }
            HrvSamplesResponse(
                items = rows.map { it.toResponse(sourceMetadata) },
                meta = rows.meta(filters),
            )
        }
    }

    suspend fun hrvSummary(params: QueryParams): HrvSummaryResponse {
        val metricType = params.optional("metricType") ?: HrvMetricTypes.RMSSD
        validateHrvMetricType(metricType)
        return dbQuery {
            val filters = params.summaryFilters(SortFields.MEASURED_AT)
            val canonical = params.canonical(default = true)
            val (summary, latest, sourceMetadata) = if (canonical) {
                val (rows, metadata) = metricsReadRepository.listHrvSamples(
                    filters.copy(limit = Int.MAX_VALUE, order = Orders.ASC),
                    metricType,
                )
                val canonicalRows = canonicalMetricsService.canonicalHrvSamples(
                    rows,
                    metricsReadRepository.sourceMetadataFor(rows.sourceIds { it.sourceInstanceId }),
                )
                Triple(
                    canonicalRows.hrvSummary(),
                    canonicalRows.maxWithOrNull(compareBy<HrvSampleRow> { it.measuredAt }.thenBy { it.id }),
                    metadata,
                )
            } else {
                val (latest, metadata) = metricsReadRepository.latestHrvSample(filters, metricType)
                Triple(metricsReadRepository.summarizeHrv(filters, metricType), latest, metadata)
            }
            HrvSummaryResponse(
                count = summary.count,
                metricType = metricType,
                minValue = summary.minValue,
                maxValue = summary.maxValue,
                avgValue = summary.avgValue,
                latest = latest?.toResponse(sourceMetadata),
            )
        }
    }

    suspend fun latestBodyMeasurement(params: QueryParams): BodyMeasurementLatestResponse {
        val metricType = params.required("metricType")
        validateBodyMetricType(metricType)
        return dbQuery {
            val filters = params.summaryFilters(SortFields.MEASURED_AT)
            val canonical = params.canonical(default = true)
            val (row, sourceMetadata) = if (canonical) {
                val (rows, metadata) = metricsReadRepository.listBodyMeasurements(
                    filters.copy(limit = Int.MAX_VALUE, order = Orders.ASC),
                    metricType,
                )
                val canonicalRows = canonicalMetricsService.canonicalBodyMeasurements(
                    rows,
                    metricsReadRepository.sourceMetadataFor(rows.sourceIds { it.sourceInstanceId }),
                )
                canonicalRows.maxWithOrNull(compareBy<BodyMeasurementRow> { it.measuredAt }.thenBy { it.id }) to metadata
            } else {
                metricsReadRepository.latestBodyMeasurement(filters, metricType)
            }
            BodyMeasurementLatestResponse(
                item = row?.toResponse(sourceMetadata),
            )
        }
    }

    suspend fun heartRateSummary(params: QueryParams): HeartRateSummaryResponse =
        dbQuery {
            val filters = params.summaryFilters(SortFields.MEASURED_AT)
            val canonical = params.canonical(default = true)
            val (summary, latest, sourceMetadata) = if (canonical) {
                val (rows, metadata) = metricsReadRepository.listHeartRateSamples(
                    filters.copy(limit = Int.MAX_VALUE, order = Orders.ASC)
                )
                val canonicalRows = canonicalMetricsService.canonicalHeartRateSamples(
                    rows,
                    metricsReadRepository.sourceMetadataFor(rows.sourceIds { it.sourceInstanceId }),
                )
                Triple(
                    canonicalRows.heartRateSummary(),
                    canonicalRows.maxWithOrNull(compareBy<HeartRateSampleRow> { it.measuredAt }.thenBy { it.id }),
                    metadata,
                )
            } else {
                val (latest, metadata) = metricsReadRepository.latestHeartRateSample(filters)
                Triple(metricsReadRepository.summarizeHeartRate(filters), latest, metadata)
            }
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
        val canonical = params.canonical(default = true)
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
            val steps = if (canonical) {
                val (rows) = metricsReadRepository.listStepDailySummaries(
                    dailyFilters.copy(limit = Int.MAX_VALUE)
                )
                val canonicalRows = canonicalMetricsService.canonicalStepDailySummaries(
                    rows,
                    metricsReadRepository.sourceMetadataFor(rows.sourceIds { it.sourceInstanceId }),
                )
                DashboardStepsSummaryResponse(
                    steps = canonicalRows.sumOf { it.steps },
                    sampleCount = canonicalRows.sumOf { it.sampleCount },
                    source = canonicalRows.singleSource(
                        includeSource,
                        metricsReadRepository,
                    ) { it.sourceInstanceId },
                )
            } else {
                metricsReadRepository.sumStepDailySummaries(dailyFilters).let {
                    DashboardStepsSummaryResponse(
                        steps = it.steps,
                        sampleCount = it.sampleCount,
                    )
                }
            }
            val (weight, weightSourceMetadata) = if (canonical) {
                val (rows, metadata) = metricsReadRepository.listBodyMeasurements(
                    instantFilters.copy(limit = Int.MAX_VALUE, order = Orders.ASC),
                    BodyMetricTypes.WEIGHT,
                )
                val canonicalRows = canonicalMetricsService.canonicalBodyMeasurements(
                    rows,
                    metricsReadRepository.sourceMetadataFor(rows.sourceIds { it.sourceInstanceId }),
                )
                canonicalRows.maxWithOrNull(compareBy<BodyMeasurementRow> { it.measuredAt }.thenBy { it.id }) to metadata
            } else {
                metricsReadRepository.latestBodyMeasurement(
                    instantFilters,
                    BodyMetricTypes.WEIGHT
                )
            }
            val (heartRate, heartRateSourceMetadata) = if (canonical) {
                val (rows, metadata) = metricsReadRepository.listHeartRateSamples(
                    instantFilters.copy(limit = Int.MAX_VALUE, order = Orders.ASC)
                )
                val canonicalRows = canonicalMetricsService.canonicalHeartRateSamples(
                    rows,
                    metricsReadRepository.sourceMetadataFor(rows.sourceIds { it.sourceInstanceId }),
                )
                canonicalRows.maxWithOrNull(compareBy<HeartRateSampleRow> { it.measuredAt }.thenBy { it.id }) to metadata
            } else {
                metricsReadRepository.latestHeartRateSample(instantFilters)
            }
            val (sleepNights, sleepStagesBySession, sleepSourceMetadata) =
                metricsReadRepository.listSleepNights(
                    sleepNightFilters.copy(limit = if (canonical) Int.MAX_VALUE else sleepNightFilters.limit)
                )
            val sleep = if (canonical) {
                canonicalMetricsService.canonicalSleepSessions(
                    sleepNights.map { it.session },
                    sleepStagesBySession,
                    metricsReadRepository.sourceMetadataFor(sleepNights.map { it.session }.sourceIds { it.sourceInstanceId }),
                ).maxWithOrNull(compareBy<SleepSessionRow> { it.endAt }.thenBy { it.id })
            } else {
                sleepNights.firstOrNull()?.session
            }
            DashboardSummaryResponse(
                fromDate = fromDate.toString(),
                toDate = toDate.toString(),
                steps = steps,
                latestWeight = weight?.toResponse(weightSourceMetadata),
                latestHeartRate = heartRate?.toResponse(heartRateSourceMetadata),
                lastSleepSession = sleep?.toResponse(
                    sleepStagesBySession,
                    sleepSourceMetadata
                ),
            )
        }
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
        val (fromDate, toDate) = dailyDateRange(now)
        return DailyReadFilters(
            fromDate = fromDate,
            toDate = toDate,
            provider = optional("provider"),
            providerInstanceId = optional("providerInstanceId"),
            includeSource = boolean("includeSource", default = false),
            limit = if (optional("date") != null) 1 else limit(
                default = 500,
                max = 5000
            ),
            sort = sort(setOf(SortFields.DATE), SortFields.DATE),
            order = order(),
        )
    }

    private fun QueryParams.dailyLatestReadFilters(now: Instant): DailyReadFilters {
        rejectLatestEndpointOverrides()
        val (fromDate, toDate) = dailyDateRange(now)
        return DailyReadFilters(
            fromDate = fromDate,
            toDate = toDate,
            provider = optional("provider"),
            providerInstanceId = optional("providerInstanceId"),
            includeSource = boolean("includeSource", default = false),
            limit = 1,
            sort = SortFields.DATE,
            order = Orders.DESC,
        )
    }

    private fun QueryParams.dailyDateRange(now: Instant): Pair<LocalDate?, LocalDate?> {
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
        return fromDate to toDate
    }

    private suspend fun <T> dbQuery(block: () -> T): T =
        suspendTransaction(db = database) {
            block()
        }
}

internal fun QueryParams.readFilters(
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

internal fun QueryParams.summaryFilters(defaultSort: String): ReadFilters {
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

    fun canonical(default: Boolean): Boolean =
        boolean("canonical", default)

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

    fun rejectLatestEndpointOverrides() {
        val invalidFields = listOf("limit", "sort", "order")
            .filter { optional(it) != null }
        if (invalidFields.isNotEmpty()) {
            throw RequestValidationException(
                invalidFields.map {
                    ValidationIssue(
                        field = it,
                        code = ValidationIssueCodes.InvalidState,
                        message = "is not supported for latest endpoints",
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

private fun ActivitySummaryRow.toResponse(
    sourceMetadata: Map<Int, SourceMetadata>
): ActivitySummaryResponse =
    ActivitySummaryResponse(
        id = id,
        date = date,
        distanceMeters = distanceMeters,
        activeEnergyKcal = activeEnergyKcal,
        totalEnergyKcal = totalEnergyKcal,
        elevationMeters = elevationMeters,
        softMinutes = softMinutes,
        moderateMinutes = moderateMinutes,
        intenseMinutes = intenseMinutes,
        activeMinutes = activeMinutes,
        averageHeartRateBpm = averageHeartRateBpm,
        minHeartRateBpm = minHeartRateBpm,
        maxHeartRateBpm = maxHeartRateBpm,
        source = sourceMetadata[sourceInstanceId].toResponse(),
    )

internal fun SleepSummaryRow.toResponse(
    sourceMetadata: Map<Int, SourceMetadata>
): SleepSummaryResponse =
    SleepSummaryResponse(
        id = id,
        startAt = startAt,
        endAt = endAt,
        timeInBedSeconds = timeInBedSeconds,
        totalSleepSeconds = totalSleepSeconds,
        lightSleepSeconds = lightSleepSeconds,
        deepSleepSeconds = deepSleepSeconds,
        remSleepSeconds = remSleepSeconds,
        sleepEfficiencyPercent = sleepEfficiencyPercent,
        sleepLatencySeconds = sleepLatencySeconds,
        wakeupLatencySeconds = wakeupLatencySeconds,
        wakeupDurationSeconds = wakeupDurationSeconds,
        wakeupCount = wakeupCount,
        wasoSeconds = wasoSeconds,
        sleepScore = sleepScore,
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

private fun RespiratoryRateSampleRow.toResponse(
    sourceMetadata: Map<Int, SourceMetadata>
): RespiratoryRateSampleResponse =
    RespiratoryRateSampleResponse(
        id = id,
        measuredAt = measuredAt,
        breathsPerMinute = breathsPerMinute,
        context = context,
        source = sourceMetadata[sourceInstanceId].toResponse(),
    )

private fun HrvSampleRow.toResponse(
    sourceMetadata: Map<Int, SourceMetadata>
): HrvSampleResponse =
    HrvSampleResponse(
        id = id,
        measuredAt = measuredAt,
        metricType = metricType,
        value = value,
        unit = unit,
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

internal fun <T> List<T>.meta(filters: ReadFilters): ReadResponseMeta =
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

private fun List<RespiratoryRateSampleRow>.respiratoryRateSummary(): RespiratoryRateSummaryRow =
    RespiratoryRateSummaryRow(
        count = size,
        minBreathsPerMinute = minOfOrNull { it.breathsPerMinute },
        maxBreathsPerMinute = maxOfOrNull { it.breathsPerMinute },
        avgBreathsPerMinute = if (isEmpty()) null else sumOf { it.breathsPerMinute }.toDouble() / size.toDouble(),
    )

private fun List<HrvSampleRow>.hrvSummary(): HrvSummaryRow =
    HrvSummaryRow(
        count = size,
        minValue = minOfOrNull { it.value },
        maxValue = maxOfOrNull { it.value },
        avgValue = if (isEmpty()) null else sumOf { it.value } / size.toDouble(),
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

internal object SortFields {
    const val START_AT = "startAt"
    const val END_AT = "endAt"
    const val DATE = "date"
    const val MEASURED_AT = "measuredAt"
}

internal object Orders {
    const val ASC = "asc"
    const val DESC = "desc"
}

private fun validateHrvMetricType(metricType: String) {
    if (metricType !in HrvMetricTypes.supported) {
        throw RequestValidationException(
            listOf(
                ValidationIssue(
                    field = "metricType",
                    code = ValidationIssueCodes.UnsupportedValue,
                    message = "unsupported hrv metric type",
                )
            )
        )
    }
}
