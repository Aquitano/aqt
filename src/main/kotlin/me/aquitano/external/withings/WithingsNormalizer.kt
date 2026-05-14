package me.aquitano.external.withings

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import me.aquitano.health.api.dto.BodyMeasurementDto
import me.aquitano.health.api.dto.HeartRateDto
import me.aquitano.health.api.dto.IngestionRecordDto
import me.aquitano.health.api.dto.SleepSessionDto
import me.aquitano.health.api.dto.SleepStageDto
import me.aquitano.health.api.dto.StepIntervalDto
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
        records.mapNotNull { record ->
            val date = record.string("date")?.let { runCatching { LocalDate.parse(it) }.getOrNull() }
                ?: return@mapNotNull null
            val steps = record.int("steps") ?: return@mapNotNull null
            if (steps <= 0) return@mapNotNull null
            StepIntervalDto(
                providerRecordId = "withings:activity:$date",
                startAt = date.atStartOfDay().toInstant(ZoneOffset.UTC).toString(),
                endAt = date.plusDays(1).atStartOfDay().toInstant(ZoneOffset.UTC).toString(),
                steps = steps,
            )
        }

    private fun normalizeMeasures(records: List<JsonObject>): List<IngestionRecordDto> =
        buildList {
            records.forEach { group ->
                val measuredAt = group.long("date") ?: group.long("created") ?: return@forEach
                val measuredAtString = Instant.ofEpochSecond(measuredAt).toString()
                val grpid = group.string("grpid") ?: group.long("grpid")?.toString()
                    ?: "at-$measuredAt"
                val measures = group["measures"] as? JsonArray ?: return@forEach
                var weightKg: Double? = null
                var bodyFatPercent: Double? = null
                var muscleKg: Double? = null
                var visceralFatRating: Double? = null
                var heartPulse: Int? = null

                measures.mapNotNull { it as? JsonObject }.forEach { measure ->
                    val type = measure.int("type") ?: return@forEach
                    val value = measure.double("value") ?: return@forEach
                    val unit = measure.int("unit") ?: 0
                    val realValue = value * 10.0.pow(unit)
                    when (type) {
                        1 -> if (realValue > 0.0) weightKg = realValue
                        6 -> if (realValue in 0.0..100.0) bodyFatPercent = realValue
                        11 -> if (realValue.toInt() in 25..250) heartPulse = realValue.toInt()
                        76 -> if (realValue > 0.0) muscleKg = realValue
                        170 -> if (realValue > 0.0) visceralFatRating = realValue
                    }
                }

                if (weightKg != null || bodyFatPercent != null || muscleKg != null || visceralFatRating != null) {
                    add(
                        BodyMeasurementDto(
                            providerRecordId = "withings:measure:$grpid:body",
                            measuredAt = measuredAtString,
                            weightKg = weightKg,
                            bodyFatPercent = bodyFatPercent,
                            muscleKg = muscleKg,
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
        records.mapNotNull { record ->
            val start = record.long("startdate") ?: return@mapNotNull null
            val end = record.long("enddate") ?: return@mapNotNull null
            if (start >= end) return@mapNotNull null
            SleepSessionDto(
                providerRecordId = "withings:sleep-summary:$start:$end",
                startAt = Instant.ofEpochSecond(start).toString(),
                endAt = Instant.ofEpochSecond(end).toString(),
                stages = emptyList(),
            )
        }

    private fun normalizeSleep(records: List<JsonObject>): List<IngestionRecordDto> {
        val segments = records.mapNotNull { record ->
            val start = record.sleepInstant("startdate") ?: return@mapNotNull null
            val end = record.sleepInstant("enddate") ?: return@mapNotNull null
            val stage = mapSleepStage(record.sleepState()) ?: return@mapNotNull null
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

        if (segments.isNotEmpty()) {
            val sessions = splitSleepSegments(segments).mapNotNull { sessionSegments ->
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
            return sessions + heartRates
        }

        val sorted = records.mapNotNull { record ->
            val instant = record.sleepInstant("timestamp")
                ?: record.sleepInstant("startdate")
                ?: return@mapNotNull null
            instant to record
        }.sortedBy { it.first }
        val sessions = splitSleepSessions(sorted).mapNotNull { sessionRecords ->
            val stages = sessionRecords.zipWithNext().mapNotNull { (current, next) ->
                val stage = mapSleepStage(current.second.sleepState()) ?: return@mapNotNull null
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
        return sessions + heartRates
    }

    private fun splitSleepSegments(segments: List<SleepSegment>): List<List<SleepSegment>> =
        buildList {
            var current = mutableListOf<SleepSegment>()
            segments.forEach { segment ->
                val previous = current.lastOrNull()
                if (previous != null && Duration.between(previous.end, segment.start) > sleepSessionGap) {
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
                if (previous != null && Duration.between(previous.first, record.first) > sleepSessionGap) {
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

    private fun JsonObject.sleepInstant(key: String): Instant? =
        instant(key) ?: (this["data"] as? JsonObject)?.instant(key)
}
