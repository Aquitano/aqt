package me.aquitano.external.withings

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import me.aquitano.health.api.dto.BodyMeasurement
import me.aquitano.health.api.dto.HeartRate
import me.aquitano.health.api.dto.ActivitySummary
import me.aquitano.health.api.dto.Hrv
import me.aquitano.health.api.dto.RespiratoryRate
import me.aquitano.health.api.dto.SleepSummary
import me.aquitano.health.api.dto.SleepSession
import me.aquitano.health.api.dto.StepInterval
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

        val body = assertIs<BodyMeasurement>(result.records.single())
        assertEquals("withings:measure:123:body", body.providerRecordId)
        assertEquals(80.136, body.weightKg!!, 0.000001)
        assertEquals(21.4, body.bodyFatPercent!!, 0.000001)
        assertEquals(40.2, body.muscleKg!!, 0.000001)
        assertEquals(50.1, body.bodyWaterPercent!!, 0.000001)
        assertEquals(9.0, body.visceralFatRating!!, 0.000001)
    }

    @Test
    fun activityCreatesSummaryFieldsAlongsideSteps() {
        val result = normalizer.normalize(
            fetchResult(
                "activity",
                buildJsonObject {
                    put("date", "2026-04-01")
                    put("steps", 1234)
                    put("distance", 800.5)
                    put("calories", 310.0)
                    put("totalcalories", 2100.0)
                    put("elevation", 15.0)
                    put("soft", 20)
                    put("moderate", 30)
                    put("intense", 10)
                    put("active", 60)
                    put("hr_average", 74)
                    put("hr_min", 58)
                    put("hr_max", 132)
                }
            )
        )

        val summary = assertIs<ActivitySummary>(
            result.records.filterIsInstance<ActivitySummary>().single()
        )
        assertEquals("withings:activity:2026-04-01:summary", summary.providerRecordId)
        assertEquals(800.5, summary.distanceMeters!!, 0.000001)
        assertEquals(310.0, summary.activeEnergyKcal!!, 0.000001)
        assertEquals(2100.0, summary.totalEnergyKcal!!, 0.000001)
        assertEquals(15.0, summary.elevationMeters!!, 0.000001)
        assertEquals(60, summary.activeMinutes)
        assertEquals(74, summary.averageHeartRateBpm)
        assertEquals(1, result.records.filterIsInstance<StepInterval>().size)
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

        val heartRate = assertIs<HeartRate>(result.records.single())
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

        val steps = assertIs<StepInterval>(
            result.records.filterIsInstance<StepInterval>().single()
        )
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

        val sleep = assertIs<SleepSession>(
            result.records.filterIsInstance<SleepSession>().single()
        )
        assertEquals("withings:sleep-summary:1775001600:1775023200", sleep.providerRecordId)
        assertEquals("2026-04-01T00:00:00Z", sleep.startAt)
        assertEquals("2026-04-01T06:00:00Z", sleep.endAt)
        assertTrue(sleep.stages.isEmpty())
    }

    @Test
    fun sleepSummaryCreatesAggregateSleepMetrics() {
        val result = normalizer.normalize(
            fetchResult(
                "sleep-summary",
                buildJsonObject {
                    put("startdate", 1775001600)
                    put("enddate", 1775023200)
                    putJsonObject("data") {
                        put("total_timeinbed", 21600)
                        put("total_sleep_time", 18000)
                        put("lightsleepduration", 9000)
                        put("deepsleepduration", 3600)
                        put("remsleepduration", 5400)
                        put("sleep_efficiency", 83.3)
                        put("sleep_latency", 600)
                        put("wakeup_latency", 120)
                        put("wakeupduration", 900)
                        put("wakeupcount", 2)
                        put("waso", 300)
                        put("sleep_score", 88)
                    }
                }
            )
        )

        val summary = assertIs<SleepSummary>(
            result.records.filterIsInstance<SleepSummary>().single()
        )
        assertEquals("withings:sleep-summary:1775001600:1775023200:summary", summary.providerRecordId)
        assertEquals(21600, summary.timeInBedSeconds)
        assertEquals(18000, summary.totalSleepSeconds)
        assertEquals(83.3, summary.sleepEfficiencyPercent!!, 0.000001)
        assertEquals(88, summary.sleepScore)
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
                    put("rr", 14)
                    put("rmssd", 42.5)
                },
                buildJsonObject {
                    put("timestamp", 1775005200)
                    put("state", 2)
                    put("hr", 56)
                },
            )
        )

        val sleep = assertIs<SleepSession>(result.records.first())
        assertEquals(1, sleep.stages.size)
        assertEquals("light", sleep.stages[0].stage)
        val heartRates = result.records.filterIsInstance<HeartRate>()
        assertEquals(2, heartRates.size)
        assertEquals("sleep", heartRates.first().context)
        val respiratoryRate = assertIs<RespiratoryRate>(
            result.records.filterIsInstance<RespiratoryRate>().single()
        )
        assertEquals("withings:sleep:rr:1775001600", respiratoryRate.providerRecordId)
        assertEquals(14, respiratoryRate.breathsPerMinute)
        val hrv = assertIs<Hrv>(result.records.filterIsInstance<Hrv>().single())
        assertEquals("withings:sleep:rmssd:1775001600", hrv.providerRecordId)
        assertEquals("rmssd", hrv.metricType)
        assertEquals(42.5, hrv.value, 0.000001)
    }

    @Test
    fun sleepSeriesValueUsesValueAsState() {
        val result = normalizer.normalize(
            fetchResult(
                "sleep",
                buildJsonObject {
                    put("timestamp", 1775001600)
                    put("value", 1)
                },
                buildJsonObject {
                    put("timestamp", 1775005200)
                    put("value", 2)
                },
            )
        )

        val sessions = result.records.filterIsInstance<SleepSession>()
        assertEquals(1, sessions.size)
        assertEquals(1, sessions.first().stages.size)
        assertEquals("light", sessions.first().stages.first().stage)
    }

    @Test
    fun sleepSeriesIgnoresNestedValueObjects() {
        val result = normalizer.normalize(
            fetchResult(
                "sleep",
                buildJsonObject {
                    put("timestamp", 1775001600)
                    put("value", buildJsonObject {
                        put("state", 1)
                    })
                    put("data", buildJsonObject {
                        put("hr", 58)
                    })
                },
                buildJsonObject {
                    put("timestamp", 1775005200)
                    put("value", 2)
                },
            )
        )

        val sessions = result.records.filterIsInstance<SleepSession>()
        assertEquals(1, sessions.size)
        assertEquals("light", sessions.first().stages.first().stage)
        assertEquals(1, result.records.filterIsInstance<HeartRate>().size)
    }

    @Test
    fun sleepSeriesUsesStartDateAsTimestampWhenEndDateMissing() {
        val result = normalizer.normalize(
            fetchResult(
                "sleep",
                buildJsonObject {
                    put("startdate", 1775001600)
                    put("state", 1)
                },
                buildJsonObject {
                    put("startdate", 1775005200)
                    put("state", 2)
                },
            )
        )

        val sessions = result.records.filterIsInstance<SleepSession>()
        assertEquals(1, sessions.size)
        assertEquals(1, sessions.first().stages.size)
        assertEquals("light", sessions.first().stages.first().stage)
    }

    @Test
    fun sleepSegmentsCreateSessionsFromStartAndEndDates() {
        val result = normalizer.normalize(
            fetchResult(
                "sleep",
                buildJsonObject {
                    put("startdate", 1775001600)
                    put("enddate", 1775005200)
                    put("state", 1)
                },
                buildJsonObject {
                    put("startdate", 1775005200)
                    put("enddate", 1775008800)
                    put("state", 2)
                },
            )
        )

        val sessions = result.records.filterIsInstance<SleepSession>()
        assertEquals(1, sessions.size)
        assertEquals("2026-04-01T00:00:00Z", sessions.first().startAt)
        assertEquals("2026-04-01T02:00:00Z", sessions.first().endAt)
        assertEquals(2, sessions.first().stages.size)
        assertEquals("light", sessions.first().stages[0].stage)
        assertEquals("deep", sessions.first().stages[1].stage)
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

        val sessions = result.records.filterIsInstance<SleepSession>()
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
