package me.aquitano.health.application

import kotlinx.coroutines.Dispatchers
import me.aquitano.health.api.dto.*
import me.aquitano.health.domain.BodyMetricTypes
import me.aquitano.health.domain.RequestValidationException
import me.aquitano.health.domain.ValidationIssue
import me.aquitano.health.domain.ValidationIssueCodes
import me.aquitano.health.infrastructure.repositories.*
import org.jetbrains.exposed.sql.Database
import org.jetbrains.exposed.sql.transactions.experimental.newSuspendedTransaction
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

data class HealthDayQueryContext(
    val date: LocalDate,
    val timezone: ZoneId,
    val from: Instant,
    val to: Instant,
    val provider: String?,
    val providerInstanceId: String?,
    val includeSource: Boolean,
)

interface HealthDayModule<T> {
    val name: String
    fun read(context: HealthDayQueryContext): T
}

class HealthDayModuleRegistry(
    modules: List<HealthDayModule<*>>
) {
    private val byName = modules.associateBy { it.name }

    fun resolve(names: List<String>): List<HealthDayModule<*>> {
        val unsupported = names.filterNot { it in byName.keys }
        if (unsupported.isNotEmpty()) {
            throw RequestValidationException(
                unsupported.map {
                    ValidationIssue(
                        field = "modules",
                        code = ValidationIssueCodes.UnsupportedValue,
                        message = "unsupported module $it",
                    )
                }
            )
        }
        return names.map { byName.getValue(it) }
    }
}

class HealthDayQueryService(
    private val database: Database,
    private val registry: HealthDayModuleRegistry,
) {
    suspend fun getHealthDay(params: QueryParams, now: Instant): HealthDayResponse {
        val timezone = params.timezone()
        val date = params.dateOrToday("date", now, timezone)
            ?: throw RequestValidationException(
                listOf(
                    ValidationIssue(
                        field = "date",
                        code = ValidationIssueCodes.Required,
                        message = "is required",
                    )
                )
            )
        val moduleNames = parseModules(params.required("modules"))
        val moduleKeys = moduleNames.map { it.wireName }
        val modules = registry.resolve(moduleKeys)
        val from = date.atStartOfDay(timezone).toInstant()
        val to = date.plusDays(1).atStartOfDay(timezone).toInstant()
        val context = HealthDayQueryContext(
            date = date,
            timezone = timezone,
            from = from,
            to = to,
            provider = params.optional("provider"),
            providerInstanceId = params.optional("providerInstanceId"),
            includeSource = params.boolean("includeSource", default = false),
        )

        return newSuspendedTransaction(Dispatchers.IO, db = database) {
            val results = modules.associate { it.name to it.read(context) }
            HealthDayResponse(
                date = date.toString(),
                timezone = timezone.id,
                from = from.toString(),
                to = to.toString(),
                modules = moduleNames,
                steps = results["steps"] as? HealthDayStepsResponse,
                heartRate = results["heartRate"] as? HealthDayHeartRateResponse,
                weight = results["weight"] as? HealthDayWeightResponse,
                sleep = results["sleep"] as? HealthDaySleepResponse,
            )
        }
    }

    private fun parseModules(value: String): List<HealthDayModuleName> {
        val modules = value.split(",").map { it.trim() }.filter { it.isNotEmpty() }
            .distinct()
        if (modules.isEmpty()) {
            throw RequestValidationException(
                listOf(
                    ValidationIssue(
                        field = "modules",
                        code = ValidationIssueCodes.Required,
                        message = "must contain at least one module",
                    )
                )
            )
        }
        val unsupported = modules.filter { HealthDayModuleName.fromWireName(it) == null }
        if (unsupported.isNotEmpty()) {
            throw RequestValidationException(
                unsupported.map {
                    ValidationIssue(
                        field = "modules",
                        code = ValidationIssueCodes.UnsupportedValue,
                        message = "unsupported module $it",
                    )
                }
            )
        }
        return modules.map { HealthDayModuleName.fromWireName(it)!! }
    }
}

class StepsDayModule(
    private val metricsReadRepository: MetricsReadRepository,
) : HealthDayModule<HealthDayStepsResponse> {
    override val name = "steps"

    override fun read(context: HealthDayQueryContext): HealthDayStepsResponse {
        val (rows) = metricsReadRepository.listStepSamplesForWindow(context.filters())
        val buckets = buckets(context)
        val values = DoubleArray(buckets.size)
        val counts = IntArray(buckets.size)

        rows.forEach { row ->
            val sampleStart = Instant.parse(row.startAt)
            val sampleEnd = Instant.parse(row.endAt)
            val sampleSeconds = Duration.between(sampleStart, sampleEnd).seconds
            if (sampleSeconds <= 0) return@forEach
            buckets.forEachIndexed { index, bucket ->
                val overlap = overlapSeconds(sampleStart, sampleEnd, bucket.first, bucket.second)
                if (overlap > 0) {
                    values[index] += row.steps * (overlap.toDouble() / sampleSeconds.toDouble())
                    counts[index] += 1
                }
            }
        }

        return HealthDayStepsResponse(
            total = values.sum().toInt(),
            sampleCount = rows.size,
            buckets = buckets.mapIndexed { index, (start, end) ->
                HealthDayBucketResponse(
                    startAt = start.toString(),
                    endAt = end.toString(),
                    value = if (counts[index] == 0) null else values[index],
                    count = counts[index],
                )
            },
        )
    }
}

class HeartRateDayModule(
    private val metricsReadRepository: MetricsReadRepository,
) : HealthDayModule<HealthDayHeartRateResponse> {
    override val name = "heartRate"

    override fun read(context: HealthDayQueryContext): HealthDayHeartRateResponse {
        val filters = context.filters()
        val summary = metricsReadRepository.summarizeHeartRateForWindow(filters)
        val (samples, sourceMetadata) =
            metricsReadRepository.listHeartRateSamplesForWindow(filters)
        val latest = samples.maxWithOrNull(compareBy<HeartRateSampleRow> { it.measuredAt }.thenBy { it.id })
        val buckets = buckets(context)
        val totals = DoubleArray(buckets.size)
        val counts = IntArray(buckets.size)

        samples.forEach { sample ->
            val measuredAt = Instant.parse(sample.measuredAt)
            val index = Duration.between(context.from, measuredAt).toMinutes().toInt() / 15
            if (index in buckets.indices) {
                totals[index] += sample.bpm.toDouble()
                counts[index] += 1
            }
        }

        return HealthDayHeartRateResponse(
            count = summary.count,
            minBpm = summary.minBpm,
            maxBpm = summary.maxBpm,
            avgBpm = summary.avgBpm,
            latest = latest?.toResponse(sourceMetadata),
            buckets = buckets.mapIndexed { index, (start, end) ->
                HealthDayBucketResponse(
                    startAt = start.toString(),
                    endAt = end.toString(),
                    value = if (counts[index] == 0) null else totals[index] / counts[index],
                    count = counts[index],
                )
            },
        )
    }
}

class WeightDayModule(
    private val metricsReadRepository: MetricsReadRepository,
) : HealthDayModule<HealthDayWeightResponse> {
    override val name = "weight"

    override fun read(context: HealthDayQueryContext): HealthDayWeightResponse {
        val filters = context.filters()
        val (points, pointSourceMetadata) =
            metricsReadRepository.listBodyMeasurementsForWindow(filters, BodyMetricTypes.WEIGHT)
        val (previous, previousSourceMetadata) =
            metricsReadRepository.latestBodyMeasurementBefore(filters, BodyMetricTypes.WEIGHT)
        val latest = points.maxWithOrNull(compareBy<BodyMeasurementRow> { it.measuredAt }.thenBy { it.id })
        val sourceMetadata = pointSourceMetadata + previousSourceMetadata

        return HealthDayWeightResponse(
            latest = latest?.toResponse(sourceMetadata),
            previous = previous?.toResponse(sourceMetadata),
            delta = if (latest != null && previous != null) latest.value - previous.value else null,
            points = points.map { it.toResponse(sourceMetadata) },
        )
    }
}

class SleepDayModule(
    private val metricsReadRepository: MetricsReadRepository,
) : HealthDayModule<HealthDaySleepResponse> {
    override val name = "sleep"

    override fun read(context: HealthDayQueryContext): HealthDaySleepResponse {
        val (sessions, stagesBySession, sourceMetadata) =
            metricsReadRepository.listSleepSessionsOverlappingWindow(context.filters())
        val timeline = sessions.flatMap { session ->
            stagesBySession[session.id].orEmpty().mapNotNull { stage ->
                val start = maxOf(Instant.parse(stage.startAt), context.from)
                val end = minOf(Instant.parse(stage.endAt), context.to)
                if (!start.isBefore(end)) {
                    null
                } else {
                    HealthDaySleepStageSegmentResponse(
                        stage = stage.stage,
                        startAt = start.toString(),
                        endAt = end.toString(),
                    )
                }
            }
        }.sortedBy { it.startAt }
        val stageTotals = timeline
            .groupingBy { it.stage }
            .fold(0L) { total, segment ->
                total + Duration.between(
                    Instant.parse(segment.startAt),
                    Instant.parse(segment.endAt)
                ).seconds
            }
            .map { (stage, duration) ->
                HealthDaySleepStageTotalResponse(stage, duration)
            }
            .sortedBy { it.stage }

        return HealthDaySleepResponse(
            totalDurationSeconds = stageTotals.sumOf { it.durationSeconds },
            sessions = sessions.map { it.toResponse(stagesBySession, sourceMetadata) },
            stageTotals = stageTotals,
            timeline = timeline,
        )
    }
}

private fun HealthDayQueryContext.filters(): ReadFilters =
    ReadFilters(
        from = from,
        to = to,
        provider = provider,
        providerInstanceId = providerInstanceId,
        includeSource = includeSource,
        limit = Int.MAX_VALUE,
        sort = "startAt",
        order = "asc",
    )

private fun buckets(context: HealthDayQueryContext): List<Pair<Instant, Instant>> {
    val result = mutableListOf<Pair<Instant, Instant>>()
    var start = context.from
    while (start.isBefore(context.to)) {
        val end = minOf(start.plus(Duration.ofMinutes(15)), context.to)
        result += start to end
        start = end
    }
    return result
}

private fun overlapSeconds(
    start: Instant,
    end: Instant,
    windowStart: Instant,
    windowEnd: Instant,
): Long {
    val clippedStart = maxOf(start, windowStart)
    val clippedEnd = minOf(end, windowEnd)
    return if (clippedStart.isBefore(clippedEnd)) {
        Duration.between(clippedStart, clippedEnd).seconds
    } else {
        0
    }
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

private fun SourceMetadata?.toResponse(): SourceMetadataResponse? =
    this?.let {
        SourceMetadataResponse(
            provider = it.provider,
            providerInstanceId = it.providerInstanceId
        )
    }
