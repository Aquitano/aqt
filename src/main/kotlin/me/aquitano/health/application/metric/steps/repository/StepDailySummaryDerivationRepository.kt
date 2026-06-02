package me.aquitano.health.application.metric.steps.repository

import me.aquitano.health.application.metric.steps.derived.StepDailySummaryOutput
import me.aquitano.health.application.metric.steps.derived.StepDailySummaryRawSample
import me.aquitano.health.infrastructure.database.tables.StepDailySummariesTable
import me.aquitano.health.infrastructure.database.tables.StepSamplesTable
import me.aquitano.health.infrastructure.database.toDbTimestamp
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.jdbc.deleteWhere
import org.jetbrains.exposed.v1.jdbc.selectAll
import org.jetbrains.exposed.v1.jdbc.upsert
import java.time.Instant

class StepDailySummaryDerivationRepository {
    fun listStepSamplesOverlapping(
        sourceInstanceId: Int,
        dayStart: Instant,
        dayEnd: Instant,
    ): List<StepDailySummaryRawSample> =
        StepSamplesTable
            .selectAll()
            .where {
                (StepSamplesTable.sourceInstanceId eq sourceInstanceId) and
                    (StepSamplesTable.startAt less dayEnd.toDbTimestamp()) and
                    (StepSamplesTable.endAt greater dayStart.toDbTimestamp())
            }
            .map {
                StepDailySummaryRawSample(
                    startAt = it[StepSamplesTable.startAt].toInstant(),
                    endAt = it[StepSamplesTable.endAt].toInstant(),
                    steps = it[StepSamplesTable.steps],
                )
            }

    fun upsertStepDailySummary(output: StepDailySummaryOutput): Int {
        if (output.sampleCount == 0) {
            StepDailySummariesTable.deleteWhere {
                (StepDailySummariesTable.sourceInstanceId eq output.sourceInstanceId) and
                    (StepDailySummariesTable.date eq output.date)
            }
            return 0
        }

        StepDailySummariesTable.upsert(
            StepDailySummariesTable.date,
            StepDailySummariesTable.sourceInstanceId,
            onUpdate = {
                it[StepDailySummariesTable.steps] =
                    insertValue(StepDailySummariesTable.steps)
                it[StepDailySummariesTable.sampleCount] =
                    insertValue(StepDailySummariesTable.sampleCount)
                it[StepDailySummariesTable.computedAt] =
                    insertValue(StepDailySummariesTable.computedAt)
            },
        ) {
            it[sourceInstanceId] = output.sourceInstanceId
            it[date] = output.date
            it[steps] = output.steps
            it[sampleCount] = output.sampleCount
            it[computedAt] = output.computedAt.toDbTimestamp()
        }

        return 1
    }
}
