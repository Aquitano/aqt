package me.aquitano.health.application

import me.aquitano.health.api.dto.BodyMeasurementDto
import me.aquitano.health.api.dto.CardiovascularDto
import me.aquitano.health.api.dto.ExtendedBodyMeasurementDto
import me.aquitano.health.api.dto.HeartRateDto
import me.aquitano.health.api.dto.HrvDto
import me.aquitano.health.api.dto.RespiratoryRateDto
import me.aquitano.health.api.dto.ScalarSampleDto
import me.aquitano.health.domain.RecordTypes
import me.aquitano.health.domain.ScalarSampleRecord
import me.aquitano.health.domain.ValidationIssue
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Each legacy scalar record type must validate exactly like the equivalent generic
 * scalar record: the ScalarMetricRegistry descriptor is the single source of truth
 * for ranges, units, and contexts.
 */
class IngestionScalarRecordMappersTest {
    private val measuredAt = "2026-06-01T08:00:00Z"

    private fun scalar(
        metricType: String,
        value: Double,
        unit: String,
        context: String? = null,
        segment: String? = null,
    ): ScalarSampleRecord? {
        val issues = mutableListOf<ValidationIssue>()
        return mapScalar(
            "records[0]",
            ScalarSampleDto(
                measuredAt = measuredAt,
                metricType = metricType,
                value = value,
                unit = unit,
                context = context,
                segment = segment,
            ),
            issues,
        )
    }

    private fun assertMatchesScalar(
        legacy: ScalarSampleRecord?,
        scalar: ScalarSampleRecord?,
        expectedRecordType: String,
    ) {
        if (scalar == null) {
            assertNull(legacy)
            return
        }
        assertNotNull(legacy)
        assertEquals(expectedRecordType, legacy.recordType)
        assertEquals(scalar.values, legacy.values)
    }

    @Test
    fun heartRateBoundariesMatchScalarRecord() {
        fun legacy(bpm: Int): ScalarSampleRecord? {
            val issues = mutableListOf<ValidationIssue>()
            return mapHeartRate(
                "records[0]",
                HeartRateDto(measuredAt = measuredAt, bpm = bpm, context = "resting"),
                issues,
            )
        }
        for (bpm in listOf(25, 250)) {
            assertMatchesScalar(
                legacy(bpm),
                scalar("heart_rate", bpm.toDouble(), "bpm", context = "resting"),
                RecordTypes.HEART_RATE,
            )
        }
        for (bpm in listOf(24, 251)) {
            assertNull(scalar("heart_rate", bpm.toDouble(), "bpm", context = "resting"))
            assertNull(legacy(bpm))
        }
    }

    @Test
    fun respiratoryRateBoundariesMatchScalarRecord() {
        fun legacy(breaths: Int): ScalarSampleRecord? {
            val issues = mutableListOf<ValidationIssue>()
            return mapRespiratoryRate(
                "records[0]",
                RespiratoryRateDto(measuredAt = measuredAt, breathsPerMinute = breaths),
                issues,
            )
        }
        for (breaths in listOf(5, 80)) {
            assertMatchesScalar(
                legacy(breaths),
                scalar("respiratory_rate", breaths.toDouble(), "breaths_per_minute", context = "unknown"),
                RecordTypes.RESPIRATORY_RATE,
            )
        }
        for (breaths in listOf(4, 81)) {
            assertNull(scalar("respiratory_rate", breaths.toDouble(), "breaths_per_minute"))
            assertNull(legacy(breaths))
        }
    }

    @Test
    fun hrvBoundariesMatchScalarRecord() {
        fun legacy(value: Double): ScalarSampleRecord? {
            val issues = mutableListOf<ValidationIssue>()
            return mapHrv(
                "records[0]",
                HrvDto(measuredAt = measuredAt, metricType = "rmssd", value = value, unit = "ms"),
                issues,
            )
        }
        assertMatchesScalar(
            legacy(500.0),
            scalar("hrv_rmssd", 500.0, "ms", context = "unknown"),
            RecordTypes.HRV,
        )
        for (value in listOf(500.1, 0.0)) {
            assertNull(scalar("hrv_rmssd", value, "ms"))
            assertNull(legacy(value))
        }
    }

    @Test
    fun bodyMeasurementBoundariesMatchScalarRecord() {
        fun legacy(bodyFatPercent: Double): ScalarSampleRecord? {
            val issues = mutableListOf<ValidationIssue>()
            return mapBodyMeasurement(
                "records[0]",
                BodyMeasurementDto(measuredAt = measuredAt, bodyFatPercent = bodyFatPercent),
                issues,
            )
        }
        assertMatchesScalar(
            legacy(100.0),
            scalar("body_fat", 100.0, "percent"),
            RecordTypes.BODY_MEASUREMENT,
        )
        assertNull(scalar("body_fat", 100.1, "percent"))
        assertNull(legacy(100.1))
        assertNull(scalar("weight", 0.0, "kg"))
        val issues = mutableListOf<ValidationIssue>()
        assertNull(
            mapBodyMeasurement(
                "records[0]",
                BodyMeasurementDto(measuredAt = measuredAt, weightKg = 0.0),
                issues,
            )
        )
    }

    @Test
    fun cardiovascularBoundariesMatchScalarRecord() {
        fun legacy(value: Double): ScalarSampleRecord? {
            val issues = mutableListOf<ValidationIssue>()
            return mapCardiovascular(
                "records[0]",
                CardiovascularDto(
                    measuredAt = measuredAt,
                    metricType = "pulse_wave_velocity",
                    value = value,
                    unit = "m/s",
                ),
                issues,
            )
        }
        assertMatchesScalar(
            legacy(7.5),
            scalar("pulse_wave_velocity", 7.5, "m/s"),
            RecordTypes.CARDIOVASCULAR,
        )
        assertNull(scalar("pulse_wave_velocity", 0.0, "m/s"))
        assertNull(legacy(0.0))
    }

    @Test
    fun extendedBodyMeasurementBoundariesMatchScalarRecord() {
        fun legacy(metricType: String, value: Double): ScalarSampleRecord? {
            val issues = mutableListOf<ValidationIssue>()
            return mapExtendedBodyMeasurement(
                "records[0]",
                ExtendedBodyMeasurementDto(
                    measuredAt = measuredAt,
                    metricType = metricType,
                    value = value,
                    unit = "kg",
                ),
                issues,
            )
        }
        assertMatchesScalar(
            legacy("fat_mass", 12.3),
            scalar("fat_mass", 12.3, "kg"),
            RecordTypes.EXTENDED_BODY_MEASUREMENT,
        )
        assertNull(scalar("fat_mass", 0.0, "kg"))
        assertNull(legacy("fat_mass", 0.0))
        // Zero is inside the range for cellular water compartments.
        assertMatchesScalar(
            legacy("intracellular_water", 0.0),
            scalar("intracellular_water", 0.0, "kg"),
            RecordTypes.EXTENDED_BODY_MEASUREMENT,
        )
    }

    @Test
    fun legacyRecordTypesOnlyAcceptMetricsOfTheirFamily() {
        val issues = mutableListOf<ValidationIssue>()
        assertNull(
            mapCardiovascular(
                "records[0]",
                CardiovascularDto(
                    measuredAt = measuredAt,
                    metricType = "weight",
                    value = 80.0,
                    unit = "kg",
                ),
                issues,
            )
        )
        assertTrue(issues.any { it.field == "records[0].metricType" })
    }
}
