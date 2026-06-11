package me.aquitano.health.infrastructure.repositories

import me.aquitano.health.domain.RecordTypes
import me.aquitano.health.infrastructure.database.tables.ActivitySummariesTable
import me.aquitano.health.infrastructure.database.tables.BloodPressureMeasurementsTable
import me.aquitano.health.infrastructure.database.tables.BodyMeasurementsTable
import me.aquitano.health.infrastructure.database.tables.CardiovascularMeasurementsTable
import me.aquitano.health.infrastructure.database.tables.ExtendedBodyMeasurementsTable
import me.aquitano.health.infrastructure.database.tables.HeartRateSamplesTable
import me.aquitano.health.infrastructure.database.tables.HrvSamplesTable
import me.aquitano.health.infrastructure.database.tables.RespiratoryRateSamplesTable
import me.aquitano.health.infrastructure.database.tables.SleepSessionsTable
import me.aquitano.health.infrastructure.database.tables.SleepSummariesTable
import me.aquitano.health.infrastructure.database.tables.StepSamplesTable
import me.aquitano.health.infrastructure.database.toDbTimestamp
import org.jetbrains.exposed.v1.core.and
import org.jetbrains.exposed.v1.core.eq
import org.jetbrains.exposed.v1.core.greaterEq
import org.jetbrains.exposed.v1.core.less
import org.jetbrains.exposed.v1.jdbc.deleteWhere
import java.time.Instant
import java.time.LocalDate

/**
 * Deletes raw metric projection rows for one replay day so the day can be rebuilt from
 * ingestion_records. Rows are keyed by their primary timestamp (start_at / measured_at / date),
 * matching how replay selects records by record_start_at; canonical and derived rows cascade.
 * Must run inside the replay day transaction.
 */
class ProjectionWipeRepository {
    fun wipeDay(day: LocalDate, dayStart: Instant, dayEnd: Instant, recordTypes: Set<String>) {
        val start = dayStart.toDbTimestamp()
        val end = dayEnd.toDbTimestamp()
        recordTypes.forEach { recordType ->
            when (recordType) {
                RecordTypes.STEP_INTERVAL -> StepSamplesTable.deleteWhere {
                    (startAt greaterEq start) and (startAt less end)
                }

                RecordTypes.SLEEP_SESSION -> SleepSessionsTable.deleteWhere {
                    (startAt greaterEq start) and (startAt less end)
                }

                RecordTypes.BODY_MEASUREMENT -> BodyMeasurementsTable.deleteWhere {
                    (measuredAt greaterEq start) and (measuredAt less end)
                }

                RecordTypes.HEART_RATE -> HeartRateSamplesTable.deleteWhere {
                    (measuredAt greaterEq start) and (measuredAt less end)
                }

                RecordTypes.ACTIVITY_SUMMARY -> ActivitySummariesTable.deleteWhere {
                    date eq day
                }

                RecordTypes.SLEEP_SUMMARY -> SleepSummariesTable.deleteWhere {
                    (startAt greaterEq start) and (startAt less end)
                }

                RecordTypes.RESPIRATORY_RATE -> RespiratoryRateSamplesTable.deleteWhere {
                    (measuredAt greaterEq start) and (measuredAt less end)
                }

                RecordTypes.HRV -> HrvSamplesTable.deleteWhere {
                    (measuredAt greaterEq start) and (measuredAt less end)
                }

                RecordTypes.BLOOD_PRESSURE -> BloodPressureMeasurementsTable.deleteWhere {
                    (measuredAt greaterEq start) and (measuredAt less end)
                }

                RecordTypes.CARDIOVASCULAR -> CardiovascularMeasurementsTable.deleteWhere {
                    (measuredAt greaterEq start) and (measuredAt less end)
                }

                RecordTypes.EXTENDED_BODY_MEASUREMENT -> ExtendedBodyMeasurementsTable.deleteWhere {
                    (measuredAt greaterEq start) and (measuredAt less end)
                }
            }
        }
    }
}
