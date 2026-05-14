package me.aquitano.external.withings

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import me.aquitano.health.api.dto.BodyMeasurementDto
import me.aquitano.health.api.dto.HeartRateDto
import me.aquitano.health.api.dto.SleepSessionDto
import me.aquitano.health.api.dto.StepIntervalDto
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

class WithingsNormalizerTest {
    private val normalizer = WithingsNormalizer()

    @Test
    fun measuresConvertUnitsAndCreateBodyMeasurementFields() {
        val result = normalizer.normalize(
            fetchResult(
                "measures",
                buildJsonObject {
                    put("grpid", 123)
                    put("date", 1775001600)
                    putJsonArray("measures") {
                        addMeasure(type = 1, value = 80136, unit = -3)
                        addMeasure(type = 6, value = 214, unit = -1)
                        addMeasure(type = 76, value = 402, unit = -1)
                        addMeasure(type = 77, value = 501, unit = -1)
                        addMeasure(type = 170, value = 9, unit = 0)
                    }
                }
            )
        )

        val body = assertIs<BodyMeasurementDto>(result.records.single())
        assertEquals("withings:measure:123:body", body.providerRecordId)
        assertEquals(80.136, body.weightKg!!, 0.000001)
        assertEquals(21.4, body.bodyFatPercent!!, 0.000001)
        assertEquals(40.2, body.muscleKg!!, 0.000001)
        assertEquals(null, body.waterPercent)
        assertEquals(9.0, body.visceralFatRating!!, 0.000001)
    }

    @Test
    fun measurePulseCreatesHeartRate() {
        val result = normalizer.normalize(
            fetchResult(
                "measures",
                buildJsonObject {
                    put("grpid", 456)
                    put("date", 1775001600)
                    putJsonArray("measures") {
                        addMeasure(type = 11, value = 62, unit = 0)
                    }
                }
            )
        )

        val heartRate = assertIs<HeartRateDto>(result.records.single())
        assertEquals("withings:measure:456:heart-pulse", heartRate.providerRecordId)
        assertEquals("2026-04-01T00:00:00Z", heartRate.measuredAt)
        assertEquals(62, heartRate.bpm)
        assertEquals("general", heartRate.context)
    }

    @Test
    fun unsupportedMeasureTypesArePreservedOnlyInSourcePayload() {
        val result = normalizer.normalize(
            fetchResult(
                "measures",
                buildJsonObject {
                    put("grpid", 789)
                    put("date", 1775001600)
                    putJsonArray("measures") {
                        addMeasure(type = 10, value = 120, unit = 0)
                    }
                }
            )
        )

        assertTrue(result.records.isEmpty())
        assertEquals(1, result.sourcePayload["records"]!!.jsonArray.size)
    }

    @Test
    fun activityStepsCreateUtcDayInterval() {
        val result = normalizer.normalize(
            fetchResult(
                "activity",
                buildJsonObject {
                    put("date", "2026-04-01")
                    put("steps", 1234)
                    put("distance", 800)
                }
            )
        )

        val steps = assertIs<StepIntervalDto>(result.records.single())
        assertEquals("withings:activity:2026-04-01", steps.providerRecordId)
        assertEquals("2026-04-01T00:00:00Z", steps.startAt)
        assertEquals("2026-04-02T00:00:00Z", steps.endAt)
        assertEquals(1234, steps.steps)
    }

    @Test
    fun sleepSummaryCreatesSleepSessionWithoutStages() {
        val result = normalizer.normalize(
            fetchResult(
                "sleep-summary",
                buildJsonObject {
                    put("startdate", 1775001600)
                    put("enddate", 1775023200)
                    put("date", "2026-04-01")
                    putJsonObject("data") {
                        put("total_sleep_time", 18000)
                    }
                }
            )
        )

        val sleep = assertIs<SleepSessionDto>(result.records.single())
        assertEquals("withings:sleep-summary:1775001600:1775023200", sleep.providerRecordId)
        assertEquals("2026-04-01T00:00:00Z", sleep.startAt)
        assertEquals("2026-04-01T06:00:00Z", sleep.endAt)
        assertTrue(sleep.stages.isEmpty())
    }

    @Test
    fun highFrequencySleepCreatesSleepHeartRateAndTimestampedStages() {
        val result = normalizer.normalize(
            fetchResult(
                "sleep",
                buildJsonObject {
                    put("timestamp", 1775001600)
                    put("state", 1)
                    put("hr", 58)
                },
                buildJsonObject {
                    put("timestamp", 1775005200)
                    put("state", 2)
                    put("hr", 56)
                },
            )
        )

        val sleep = assertIs<SleepSessionDto>(result.records.first())
        assertEquals(1, sleep.stages.size)
        assertEquals("light", sleep.stages[0].stage)
        val heartRates = result.records.filterIsInstance<HeartRateDto>()
        assertEquals(2, heartRates.size)
        assertEquals("sleep", heartRates.first().context)
    }

    @Test
    fun highFrequencySleepSplitsSessionsAcrossLargeGaps() {
        val result = normalizer.normalize(
            fetchResult(
                "sleep",
                buildJsonObject {
                    put("timestamp", "2026-04-01T00:00:00Z")
                    put("state", 1)
                },
                buildJsonObject {
                    put("timestamp", "2026-04-01T01:00:00Z")
                    put("state", 2)
                },
                buildJsonObject {
                    put("timestamp", "2026-04-02T00:00:00Z")
                    put("state", 1)
                },
                buildJsonObject {
                    put("timestamp", "2026-04-02T01:00:00Z")
                    put("state", 3)
                },
            )
        )

        val sessions = result.records.filterIsInstance<SleepSessionDto>()
        assertEquals(2, sessions.size)
        assertEquals("2026-04-01T00:00:00Z", sessions[0].startAt)
        assertEquals("2026-04-01T01:00:00Z", sessions[0].endAt)
        assertEquals(1, sessions[0].stages.size)
        assertEquals("2026-04-02T00:00:00Z", sessions[1].startAt)
        assertEquals("2026-04-02T01:00:00Z", sessions[1].endAt)
        assertEquals(1, sessions[1].stages.size)
    }

    @Test
    fun invalidAndZeroValuesAreSkipped() {
        val result = normalizer.normalize(
            fetchResult(
                "activity",
                buildJsonObject {
                    put("date", "2026-04-01")
                    put("steps", 0)
                }
            )
        )

        assertTrue(result.records.isEmpty())
    }

    private fun fetchResult(dataType: String, vararg records: kotlinx.serialization.json.JsonObject): WithingsFetchResult =
        WithingsFetchResult(
            dataType = dataType,
            pages = listOf(
                WithingsPage(
                    endpoint = "https://wbsapi.withings.net/v2/test",
                    action = dataType,
                    pageIndex = 0,
                    payload = buildJsonObject { put("status", 0) },
                )
            ),
            records = records.toList(),
        )

    private fun kotlinx.serialization.json.JsonArrayBuilder.addMeasure(type: Int, value: Int, unit: Int) {
        add(
            buildJsonObject {
                put("type", type)
                put("value", value)
                put("unit", unit)
            }
        )
    }
}
