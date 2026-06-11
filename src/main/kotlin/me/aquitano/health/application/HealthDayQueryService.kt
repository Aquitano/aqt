package me.aquitano.health.application

import me.aquitano.health.api.dto.*
import me.aquitano.health.application.metric.common.QueryParams
import me.aquitano.health.domain.BodyMetricTypes
import me.aquitano.health.domain.RequestValidationException
import me.aquitano.health.domain.ValidationIssue
import me.aquitano.health.domain.ValidationIssueCodes
import me.aquitano.health.application.metric.steps.derived.CANONICAL_STEP_ALGORITHM_VERSION
import me.aquitano.health.application.metric.steps.repository.CanonicalStepDerivationRepository
import me.aquitano.health.application.metric.common.repository.SleepNightReadFilters
import me.aquitano.health.application.metric.scalar.ScalarSampleReadRepository
import me.aquitano.health.application.metric.scalar.ScalarSampleRow
import me.aquitano.health.application.metric.scalar.toBodyMeasurementResponse
import me.aquitano.health.application.metric.scalar.toHeartRateResponse
import me.aquitano.health.application.metric.sleep.repository.SleepRepository
import me.aquitano.health.application.metric.sleep.repository.SleepSessionRow
import me.aquitano.health.application.metric.sleep.repository.SleepStageRow
import me.aquitano.health.application.metric.common.repository.SourceMetadata
import me.aquitano.health.domain.ScalarMetricTypes
import me.aquitano.health.application.metric.common.repository.ReadFilters
import me.aquitano.health.application.metric.common.sourceInstanceIds
import org.jetbrains.exposed.v1.jdbc.Database
import org.jetbrains.exposed.v1.jdbc.transactions.suspendTransaction
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import kotlin.math.roundToInt

data class HealthDayQueryContext(
    val date: LocalDate,
    val timezone: ZoneId,
    val from: Instant,
    val to: Instant,
    val provider: String?,
    val providerInstanceId: String?,
    val includeSource: Boolean,
    val computedAt: Instant,
)

interface HealthDayModule<T> {
    val name: String
    suspend fun read(context: HealthDayQueryContext): T
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
            computedAt = now,
        )

        return suspendTransaction(db = database) {
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
    private val canonicalRepository: CanonicalStepDerivationRepository = CanonicalStepDerivationRepository(),
) : HealthDayModule<HealthDayStepsResponse> {
    override val name = "steps"

    override suspend fun read(context: HealthDayQueryContext): HealthDayStepsResponse {
        val filters = context.filters()
        val (rows, sourceMetadata) = canonicalRepository.listCanonicalStepSamples(
            filters,
            CANONICAL_STEP_ALGORITHM_VERSION,
            overlapsWindow = true,
        )
        val buckets = buckets(context)
        val values = DoubleArray(buckets.size)
        val counts = IntArray(buckets.size)

        val byStart = buckets.mapIndexed { index, bucket -> bucket.first to index }.toMap()
        canonicalRepository.listBucketContributions(filters, CANONICAL_STEP_ALGORITHM_VERSION)
            .forEach { contribution ->
                val index = byStart[Instant.parse(contribution.bucketStartAt)]
                if (index != null) {
                    values[index] += contribution.value
                    counts[index] += 1
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
            source = rows.singleSource(context.includeSource, sourceMetadata) { it.sourceInstanceId },
        )
    }
}

class HeartRateDayModule(
    private val scalarRepository: ScalarSampleReadRepository = ScalarSampleReadRepository(),
) : HealthDayModule<HealthDayHeartRateResponse> {
    override val name = "heartRate"

    private val metricTypes = setOf(ScalarMetricTypes.HEART_RATE)

    override suspend fun read(context: HealthDayQueryContext): HealthDayHeartRateResponse {
        val filters = context.filters()
        val (samples, sourceMetadata) = scalarRepository.list(
            filters.copy(limit = Int.MAX_VALUE, sort = "measuredAt", order = "asc"),
            metricTypes,
            canonical = true,
        )
        val summary = scalarRepository.summarize(filters, metricTypes, canonical = true)
        val latest = samples.maxWithOrNull(compareBy<ScalarSampleRow> { it.measuredAt }.thenBy { it.id })
        val buckets = buckets(context)
        val totals = DoubleArray(buckets.size)
        val counts = IntArray(buckets.size)

        samples.forEach { sample ->
            val index = Duration.between(context.from, sample.measuredAt).toMinutes().toInt() / 15
            if (index in buckets.indices) {
                totals[index] += sample.value
                counts[index] += 1
            }
        }

        return HealthDayHeartRateResponse(
            count = summary.count,
            minBpm = summary.minValue?.roundToInt(),
            maxBpm = summary.maxValue?.roundToInt(),
            avgBpm = summary.avgValue,
            latest = latest?.toHeartRateResponse(sourceMetadata),
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
    private val scalarRepository: ScalarSampleReadRepository = ScalarSampleReadRepository(),
) : HealthDayModule<HealthDayWeightResponse> {
    override val name = "weight"

    private val metricTypes = setOf(BodyMetricTypes.WEIGHT)

    override suspend fun read(context: HealthDayQueryContext): HealthDayWeightResponse {
        val filters = context.filters()
        val (points, pointSourceMetadata) = scalarRepository.list(filters, metricTypes, canonical = true)
        val (previous, previousSourceMetadata) =
            scalarRepository.latestBefore(filters, metricTypes, canonical = true)
        val latest = points.maxWithOrNull(compareBy<ScalarSampleRow> { it.measuredAt }.thenBy { it.id })
        val sourceMetadata = pointSourceMetadata + previousSourceMetadata

        return HealthDayWeightResponse(
            latest = latest?.toBodyMeasurementResponse(sourceMetadata),
            previous = previous?.toBodyMeasurementResponse(sourceMetadata),
            delta = if (latest != null && previous != null) latest.value - previous.value else null,
            points = points.map { it.toBodyMeasurementResponse(sourceMetadata) },
        )
    }
}

class SleepDayModule(
    private val sleepRepository: SleepRepository = SleepRepository(),
    private val sleepNightService: SleepNightService,
) : HealthDayModule<HealthDaySleepResponse> {
    override val name = "sleep"

    override suspend fun read(context: HealthDayQueryContext): HealthDaySleepResponse {
        val filters = SleepNightReadFilters(
            fromDate = context.date,
            toDate = context.date.plusDays(1),
            timezone = context.timezone,
            provider = context.provider,
            providerInstanceId = context.providerInstanceId,
            includeSource = context.includeSource,
            limit = Int.MAX_VALUE,
            sort = "date",
            order = "asc",
        )
        sleepNightService.materializeCanonical(filters, context.computedAt)

        val (nights, stagesBySession, sourceMetadata) =
            sleepRepository.listCanonicalSleepNights(filters)
        val sessions = nights
            .map { it.session }
            .filter { session ->
                Instant.parse(session.startAt).isBefore(context.to) &&
                    Instant.parse(session.endAt).isAfter(context.from)
            }
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
