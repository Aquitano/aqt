package me.aquitano.external.google

import kotlinx.serialization.json.*
import me.aquitano.health.api.dto.*
import me.aquitano.health.shared.AppJson
import java.security.MessageDigest
import java.util.*

class GoogleHealthNormalizer {
    fun normalize(fetchResult: GoogleHealthFetchResult): GoogleHealthNormalizedBatch {
        val records = fetchResult.dataPoints.mapNotNull {
            normalizeDataPoint(
                fetchResult.dataType,
                it
            )
        }
        val sourcePayload = buildJsonObject {
            put("dataType", fetchResult.dataType)
            put(
                "pages",
                JsonArray(
                    fetchResult.pages.map {
                        buildJsonObject {
                            put("pageIndex", it.pageIndex)
                            put("payload", it.payload)
                        }
                    }
                )
            )
        }
        return GoogleHealthNormalizedBatch(sourcePayload, records)
    }

    private fun normalizeDataPoint(
        dataType: String,
        dataPoint: JsonObject
    ): IngestionRecordDto? {
        val point = (dataPoint["dataPoint"] as? JsonObject) ?: dataPoint
        return when (dataType) {
            "steps" -> normalizeSteps(dataType, point)
            "sleep" -> normalizeSleep(dataType, point)
            "heart-rate" -> normalizeHeartRate(dataType, point)
            "weight" -> normalizeWeight(dataType, point)
            "body-fat" -> normalizeBodyFat(dataType, point)
            else -> null
        }
    }

    private fun normalizeSteps(
        dataType: String,
        point: JsonObject
    ): StepIntervalDto? {
        val steps = point.obj("steps") ?: return null
        val interval = steps.obj("interval") ?: return null
        val startAt = interval.string("startTime") ?: return null
        val endAt = interval.string("endTime") ?: return null
        val count = steps.long("count") ?: return null
        if (count <= 0) return null
        return StepIntervalDto(
            providerRecordId = providerRecordId(
                dataType,
                point,
                startAt,
                endAt
            ),
            startAt = startAt,
            endAt = endAt,
            steps = count.toInt()
        )
    }

    private fun normalizeSleep(
        dataType: String,
        point: JsonObject
    ): SleepSessionDto? {
        val sleep = point.obj("sleep") ?: return null
        val interval = sleep.obj("interval") ?: return null
        val startAt = interval.string("startTime") ?: return null
        val endAt = interval.string("endTime") ?: return null
        val stages = sleep["stages"]?.jsonArray?.mapNotNull { element ->
            val stage = element as? JsonObject ?: return@mapNotNull null
            val mapped =
                mapSleepStage(stage.string("type")) ?: return@mapNotNull null
            val stageStart = stage.string("startTime") ?: return@mapNotNull null
            val stageEnd = stage.string("endTime") ?: return@mapNotNull null
            SleepStageDto(
                stage = mapped,
                startAt = stageStart,
                endAt = stageEnd
            )
        }.orEmpty()

        return SleepSessionDto(
            providerRecordId = providerRecordId(
                dataType,
                point,
                startAt,
                endAt
            ),
            startAt = startAt,
            endAt = endAt,
            stages = stages
        )
    }

    private fun normalizeHeartRate(
        dataType: String,
        point: JsonObject
    ): HeartRateDto? {
        val heartRate =
            point.obj("heartRate") ?: point.obj("heart_rate") ?: return null
        val sampleTime = heartRate.obj("sampleTime") ?: return null
        val measuredAt = sampleTime.string("physicalTime") ?: return null
        val bpm = heartRate.long("beatsPerMinute") ?: heartRate.long("bpm")
        ?: return null
        if (bpm !in 25..250) return null
        return HeartRateDto(
            providerRecordId = providerRecordId(
                dataType,
                point,
                measuredAt,
                null
            ),
            measuredAt = measuredAt,
            bpm = bpm.toInt(),
            context = mapHeartRateContext(
                heartRate.obj("metadata")?.string("motionContext")
            )
        )
    }

    private fun normalizeWeight(
        dataType: String,
        point: JsonObject
    ): BodyMeasurementDto? {
        val weight = point.obj("weight") ?: return null
        val sampleTime = weight.obj("sampleTime") ?: return null
        val measuredAt = sampleTime.string("physicalTime") ?: return null
        val grams = weight.double("weightGrams") ?: return null
        if (grams <= 0.0) return null
        return BodyMeasurementDto(
            providerRecordId = providerRecordId(
                dataType,
                point,
                measuredAt,
                null
            ),
            measuredAt = measuredAt,
            weightKg = grams / 1000.0
        )
    }

    private fun normalizeBodyFat(
        dataType: String,
        point: JsonObject
    ): BodyMeasurementDto? {
        val bodyFat =
            point.obj("bodyFat") ?: point.obj("body_fat") ?: return null
        val sampleTime = bodyFat.obj("sampleTime") ?: return null
        val measuredAt = sampleTime.string("physicalTime") ?: return null
        val percentage = bodyFat.double("percentage") ?: return null
        if (percentage !in 0.0..100.0) return null
        return BodyMeasurementDto(
            providerRecordId = providerRecordId(
                dataType,
                point,
                measuredAt,
                null
            ),
            measuredAt = measuredAt,
            bodyFatPercent = percentage
        )
    }

    private fun providerRecordId(
        dataType: String,
        point: JsonObject,
        startOrMeasuredAt: String,
        endAt: String?,
    ): String =
        point.string("name")?.takeIf { it.isNotBlank() }
            ?: "$dataType:$startOrMeasuredAt:${endAt ?: "none"}:${point.sha256()}"

    private fun mapSleepStage(value: String?): String? =
        when (value?.uppercase()) {
            "AWAKE" -> "awake"
            "RESTLESS" -> "restless"
            "ASLEEP" -> "asleep"
            "LIGHT" -> "light"
            "DEEP" -> "deep"
            "REM" -> "rem"
            else -> null
        }

    private fun mapHeartRateContext(value: String?): String =
        when (value?.uppercase()) {
            "ACTIVE" -> "active"
            "SEDENTARY" -> "resting"
            else -> "unknown"
        }

    private fun JsonObject.obj(key: String): JsonObject? =
        this[key] as? JsonObject

    private fun JsonObject.string(key: String): String? =
        this[key]?.jsonPrimitive?.contentOrNull

    private fun JsonObject.long(key: String): Long? =
        this[key]?.jsonPrimitive?.longOrNull

    private fun JsonObject.double(key: String): Double? =
        this[key]?.jsonPrimitive?.doubleOrNull

    private fun JsonObject.sha256(): String {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(AppJson.encodeToString(this).toByteArray(Charsets.UTF_8))
        return HexFormat.of().formatHex(digest)
    }
}
