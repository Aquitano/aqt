package me.aquitano.external.withings

import kotlinx.serialization.json.*
import me.aquitano.health.api.dto.*
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import kotlin.math.pow

class WithingsNormalizer {
    private val sleepSessionGap = Duration.ofHours(2)

    fun normalize(fetchResult: WithingsFetchResult): WithingsNormalizedBatch {
        val records = when (fetchResult.dataType) {
            "activity" -> normalizeActivity(fetchResult.records)
            "measures" -> normalizeMeasures(fetchResult.records)
            "sleep-summary" -> normalizeSleepSummary(fetchResult.records)
            "sleep" -> normalizeSleep(fetchResult.records)
            else -> emptyList()
        }
        val sourcePayload = buildJsonObject {
            put("dataType", fetchResult.dataType)
            put(
                "pages",
                JsonArray(
                    fetchResult.pages.map {
                        buildJsonObject {
                            put("endpoint", it.endpoint)
                            put("action", it.action)
                            put("pageIndex", it.pageIndex)
                            put("payload", it.payload)
                        }
                    }
                )
            )
            put("records", JsonArray(fetchResult.records))
        }
        return WithingsNormalizedBatch(sourcePayload, records)
    }

    private fun normalizeActivity(records: List<JsonObject>): List<IngestionRecordDto> =
        buildList {
            records.forEach { record ->
                val date = record.string("date")
                    ?.let { runCatching { LocalDate.parse(it) }.getOrNull() }
                    ?: return@forEach
                val steps = record.int("steps")
                if (steps != null && steps > 0) {
                    add(
                        StepIntervalDto(
                            providerRecordId = "withings:activity:$date",
                            startAt = date.atStartOfDay()
                                .toInstant(ZoneOffset.UTC)
                                .toString(),
                            endAt = date.plusDays(1)
                                .atStartOfDay()
                                .toInstant(ZoneOffset.UTC)
                                .toString(),
                            steps = steps,
                        )
                    )
                }

                val summary = record.toActivitySummary(date)
                if (summary.hasAnyMetric()) add(summary)
            }
        }

    private fun normalizeMeasures(records: List<JsonObject>): List<IngestionRecordDto> =
        buildList {
            records.forEach { group ->
                val measuredAt = group.long("date") ?: group.long("created")
                ?: return@forEach
                val measuredAtString =
                    Instant.ofEpochSecond(measuredAt).toString()
                val grpid =
                    group.string("grpid") ?: group.long("grpid")?.toString()
                    ?: "at-$measuredAt"
                val measures = group["measures"] as? JsonArray ?: return@forEach
                var weightKg: Double? = null
                var bodyFatPercent: Double? = null
                var muscleKg: Double? = null
                var waterPercent: Double? = null
                var visceralFatRating: Double? = null
                var heartPulse: Int? = null

                measures.mapNotNull { it as? JsonObject }.forEach { measure ->
                    val type = measure.int("type") ?: return@forEach
                    val value = measure.double("value") ?: return@forEach
                    val unit = measure.int("unit") ?: 0
                    val realValue = value * 10.0.pow(unit)
                    when (type) {
                        1 -> if (realValue > 0.0) weightKg = realValue
                        6 -> if (realValue in 0.0..100.0) bodyFatPercent =
                            realValue

                        11 -> if (realValue.toInt() in 25..250) heartPulse =
                            realValue.toInt()

                        76 -> if (realValue > 0.0) muscleKg = realValue
                        77 -> if (realValue in 0.0..100.0) waterPercent = realValue
                        170 -> if (realValue > 0.0) visceralFatRating = realValue
                    }
                }

                if (
                    weightKg != null ||
                    bodyFatPercent != null ||
                    muscleKg != null ||
                    waterPercent != null ||
                    visceralFatRating != null
                ) {
                    add(
                        BodyMeasurementDto(
                            providerRecordId = "withings:measure:$grpid:body",
                            measuredAt = measuredAtString,
                            weightKg = weightKg,
                            bodyFatPercent = bodyFatPercent,
                            muscleKg = muscleKg,
                            bodyWaterPercent = waterPercent,
                            visceralFatRating = visceralFatRating,
                        )
                    )
                }
                heartPulse?.let {
                    add(
                        HeartRateDto(
                            providerRecordId = "withings:measure:$grpid:heart-pulse",
                            measuredAt = measuredAtString,
                            bpm = it,
                            context = "general",
                        )
                    )
                }
            }
        }

    private fun normalizeSleepSummary(records: List<JsonObject>): List<IngestionRecordDto> =
        buildList {
            records.forEach { record ->
                val start = record.long("startdate") ?: return@forEach
                val end = record.long("enddate") ?: return@forEach
                if (start >= end) return@forEach
                add(
                    SleepSessionDto(
                        providerRecordId = "withings:sleep-summary:$start:$end",
                        startAt = Instant.ofEpochSecond(start).toString(),
                        endAt = Instant.ofEpochSecond(end).toString(),
                        stages = emptyList(),
                    )
                )

                val data = record["data"] as? JsonObject ?: record
                val totalSleepSeconds =
                    data.nonNegativeLong("total_sleep_time")
                        ?: data.nonNegativeLong("asleepduration")
                val sleepLatencySeconds =
                    data.nonNegativeLong("sleep_latency")
                        ?: data.nonNegativeLong("durationtosleep")
                val wakeupLatencySeconds =
                    data.nonNegativeLong("wakeup_latency")
                        ?: data.nonNegativeLong("durationtowakeup")
                val sleepScore = data.int("sleep_score")?.takeIf { it in 0..100 }
                val summary = SleepSummaryDto(
                    providerRecordId = "withings:sleep-summary:$start:$end:summary",
                    startAt = Instant.ofEpochSecond(start).toString(),
                    endAt = Instant.ofEpochSecond(end).toString(),
                    timeInBedSeconds = data.nonNegativeLong("total_timeinbed"),
                    totalSleepSeconds = totalSleepSeconds,
                    lightSleepSeconds = data.nonNegativeLong("lightsleepduration"),
                    deepSleepSeconds = data.nonNegativeLong("deepsleepduration"),
                    remSleepSeconds = data.nonNegativeLong("remsleepduration"),
                    sleepEfficiencyPercent = data.nonNegativeDouble("sleep_efficiency")
                        ?.takeIf { it in 0.0..100.0 },
                    sleepLatencySeconds = sleepLatencySeconds,
                    wakeupLatencySeconds = wakeupLatencySeconds,
                    wakeupDurationSeconds = data.nonNegativeLong("wakeupduration"),
                    wakeupCount = data.nonNegativeInt("wakeupcount"),
                    wasoSeconds = data.nonNegativeLong("waso"),
                    sleepScore = sleepScore,
                )
                if (summary.hasAnyMetric()) add(summary)
            }
        }

    private fun normalizeSleep(records: List<JsonObject>): List<IngestionRecordDto> {
        val segments = records.mapNotNull { record ->
            val start =
                record.sleepInstant("startdate") ?: return@mapNotNull null
            val end = record.sleepInstant("enddate") ?: return@mapNotNull null
            val stage =
                mapSleepStage(record.sleepState()) ?: return@mapNotNull null
            if (!start.isBefore(end)) return@mapNotNull null
            SleepSegment(start = start, end = end, stage = stage)
        }.sortedBy { it.start }

        val heartRates = records.mapNotNull { record ->
            val bpm = record.sleepHeartRate() ?: return@mapNotNull null
            if (bpm !in 25..250) return@mapNotNull null
            val instant = record.sleepInstant("timestamp")
                ?: record.sleepInstant("startdate")
                ?: return@mapNotNull null
            HeartRateDto(
                providerRecordId = "withings:sleep:hr:${instant.epochSecond}",
                measuredAt = instant.toString(),
                bpm = bpm,
                context = "sleep",
            )
        }

        val respiratoryRates = records.mapNotNull { record ->
            val breathsPerMinute = record.sleepRespiratoryRate() ?: return@mapNotNull null
            if (breathsPerMinute !in 5..80) return@mapNotNull null
            val instant = record.sleepInstant("timestamp")
                ?: record.sleepInstant("startdate")
                ?: return@mapNotNull null
            RespiratoryRateDto(
                providerRecordId = "withings:sleep:rr:${instant.epochSecond}",
                measuredAt = instant.toString(),
                breathsPerMinute = breathsPerMinute,
                context = "sleep",
            )
        }

        val hrv = records.mapNotNull { record ->
            val rmssd = record.sleepRmssd() ?: return@mapNotNull null
            if (rmssd <= 0.0 || rmssd > 500.0) return@mapNotNull null
            val instant = record.sleepInstant("timestamp")
                ?: record.sleepInstant("startdate")
                ?: return@mapNotNull null
            HrvDto(
                providerRecordId = "withings:sleep:rmssd:${instant.epochSecond}",
                measuredAt = instant.toString(),
                metricType = "rmssd",
                value = rmssd,
                unit = "ms",
                context = "sleep",
            )
        }

        if (segments.isNotEmpty()) {
            val sessions =
                splitSleepSegments(segments).mapNotNull { sessionSegments ->
                    val start = sessionSegments.first().start
                    val end = sessionSegments.last().end
                    if (!start.isBefore(end)) return@mapNotNull null
                    SleepSessionDto(
                        providerRecordId = "withings:sleep:${start.epochSecond}:${end.epochSecond}",
                        startAt = start.toString(),
                        endAt = end.toString(),
                        stages = sessionSegments.map { segment ->
                            SleepStageDto(
                                stage = segment.stage,
                                startAt = segment.start.toString(),
                                endAt = segment.end.toString(),
                            )
                        },
                    )
                }
            return sessions + heartRates + respiratoryRates + hrv
        }

        val sorted = records.mapNotNull { record ->
            val instant = record.sleepInstant("timestamp")
                ?: record.sleepInstant("startdate")
                ?: return@mapNotNull null
            instant to record
        }.sortedBy { it.first }
        val sessions = splitSleepSessions(sorted).mapNotNull { sessionRecords ->
            val stages =
                sessionRecords.zipWithNext().mapNotNull { (current, next) ->
                    val stage = mapSleepStage(current.second.sleepState())
                        ?: return@mapNotNull null
                    if (!current.first.isBefore(next.first)) return@mapNotNull null
                    SleepStageDto(
                        stage = stage,
                        startAt = current.first.toString(),
                        endAt = next.first.toString(),
                    )
                }
            if (stages.isEmpty()) return@mapNotNull null
            val start = sessionRecords.first().first
            val end = sessionRecords.last().first
            if (!start.isBefore(end)) return@mapNotNull null
            SleepSessionDto(
                providerRecordId = "withings:sleep:${start.epochSecond}:${end.epochSecond}",
                startAt = start.toString(),
                endAt = end.toString(),
                stages = stages,
            )
        }
        return sessions + heartRates + respiratoryRates + hrv
    }

    private fun splitSleepSegments(segments: List<SleepSegment>): List<List<SleepSegment>> =
        buildList {
            var current = mutableListOf<SleepSegment>()
            segments.forEach { segment ->
                val previous = current.lastOrNull()
                if (previous != null && Duration.between(
                        previous.end,
                        segment.start
                    ) > sleepSessionGap
                ) {
                    add(current)
                    current = mutableListOf()
                }
                current.add(segment)
            }
            if (current.isNotEmpty()) add(current)
        }

    private data class SleepSegment(
        val start: Instant,
        val end: Instant,
        val stage: String,
    )

    private fun splitSleepSessions(
        sorted: List<Pair<Instant, JsonObject>>,
    ): List<List<Pair<Instant, JsonObject>>> =
        buildList {
            var current = mutableListOf<Pair<Instant, JsonObject>>()
            sorted.forEach { record ->
                val previous = current.lastOrNull()
                if (previous != null && Duration.between(
                        previous.first,
                        record.first
                    ) > sleepSessionGap
                ) {
                    add(current)
                    current = mutableListOf()
                }
                current.add(record)
            }
            if (current.isNotEmpty()) add(current)
        }

    private fun mapSleepStage(value: Int?): String? =
        when (value) {
            0 -> "awake"
            1 -> "light"
            2 -> "deep"
            3 -> "rem"
            null -> null
            else -> "unknown"
        }

    private fun JsonObject.toActivitySummary(date: LocalDate): ActivitySummaryDto =
        ActivitySummaryDto(
            providerRecordId = "withings:activity:$date:summary",
            date = date.toString(),
            distanceMeters = nonNegativeDouble("distance"),
            activeEnergyKcal = nonNegativeDouble("calories"),
            totalEnergyKcal = nonNegativeDouble("totalcalories"),
            elevationMeters = nonNegativeDouble("elevation"),
            softMinutes = nonNegativeInt("soft"),
            moderateMinutes = nonNegativeInt("moderate"),
            intenseMinutes = nonNegativeInt("intense"),
            activeMinutes = nonNegativeInt("active"),
            averageHeartRateBpm = validHeartRate("hr_average"),
            minHeartRateBpm = validHeartRate("hr_min"),
            maxHeartRateBpm = validHeartRate("hr_max"),
        )

    private fun ActivitySummaryDto.hasAnyMetric(): Boolean =
        distanceMeters != null ||
            activeEnergyKcal != null ||
            totalEnergyKcal != null ||
            elevationMeters != null ||
            softMinutes != null ||
            moderateMinutes != null ||
            intenseMinutes != null ||
            activeMinutes != null ||
            averageHeartRateBpm != null ||
            minHeartRateBpm != null ||
            maxHeartRateBpm != null

    private fun SleepSummaryDto.hasAnyMetric(): Boolean =
        timeInBedSeconds != null ||
            totalSleepSeconds != null ||
            lightSleepSeconds != null ||
            deepSleepSeconds != null ||
            remSleepSeconds != null ||
            sleepEfficiencyPercent != null ||
            sleepLatencySeconds != null ||
            wakeupLatencySeconds != null ||
            wakeupDurationSeconds != null ||
            wakeupCount != null ||
            wasoSeconds != null ||
            sleepScore != null

    private fun JsonObject.string(key: String): String? =
        this[key]?.jsonPrimitive?.contentOrNull

    private fun JsonObject.int(key: String): Int? {
        val primitive = this[key]?.jsonPrimitive ?: return null
        primitive.intOrNull?.let { return it }
        return primitive.contentOrNull?.toIntOrNull()
    }

    private fun JsonObject.long(key: String): Long? =
        this[key]?.jsonPrimitive?.longOrNull

    private fun JsonObject.double(key: String): Double? =
        this[key]?.jsonPrimitive?.doubleOrNull

    private fun JsonObject.instant(key: String): Instant? {
        val primitive = this[key]?.jsonPrimitive ?: return null
        primitive.longOrNull?.let { return Instant.ofEpochSecond(it) }
        return primitive.contentOrNull?.let { value ->
            value.toLongOrNull()?.let { Instant.ofEpochSecond(it) }
                ?: runCatching { Instant.parse(value) }.getOrNull()
        }
    }

    private fun JsonObject.sleepState(): Int? =
        int("state")
            ?: int("value")
            ?: (this["data"] as? JsonObject)?.int("state")
            ?: (this["data"] as? JsonObject)?.int("value")

    private fun JsonObject.sleepHeartRate(): Int? =
        int("hr") ?: (this["data"] as? JsonObject)?.int("hr")

    private fun JsonObject.sleepRespiratoryRate(): Int? =
        int("rr") ?: (this["data"] as? JsonObject)?.int("rr")

    private fun JsonObject.sleepRmssd(): Double? =
        double("rmssd") ?: (this["data"] as? JsonObject)?.double("rmssd")

    private fun JsonObject.sleepInstant(key: String): Instant? =
        instant(key) ?: (this["data"] as? JsonObject)?.instant(key)

    private fun JsonObject.nonNegativeInt(key: String): Int? =
        int(key)?.takeIf { it >= 0 }

    private fun JsonObject.nonNegativeLong(key: String): Long? =
        long(key)?.takeIf { it >= 0 }

    private fun JsonObject.nonNegativeDouble(key: String): Double? =
        double(key)?.takeIf { it >= 0.0 }

    private fun JsonObject.validHeartRate(key: String): Int? =
        int(key)?.takeIf { it in 25..250 }
}
