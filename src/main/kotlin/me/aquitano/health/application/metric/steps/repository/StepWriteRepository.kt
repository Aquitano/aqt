package me.aquitano.health.application.metric.steps.repository

import me.aquitano.health.domain.StepIntervalRecord
import me.aquitano.health.infrastructure.database.tables.StepSamplesTable
import me.aquitano.health.infrastructure.database.toDbTimestamp
import org.jetbrains.exposed.v1.core.and
import org.jetbrains.exposed.v1.core.eq
import org.jetbrains.exposed.v1.core.greater
import org.jetbrains.exposed.v1.core.less
import org.jetbrains.exposed.v1.jdbc.insertIgnoreAndGetId
import org.jetbrains.exposed.v1.jdbc.selectAll
import java.time.Instant

private const val GOOGLE_HEALTH_PROVIDER_CODE = "google_health"

class StepWriteRepository {
    fun insertStepSample(
        provider: String,
        sourceInstanceId: Int,
        ingestionRecordId: Int,
        record: StepIntervalRecord,
        now: Instant,
    ): Boolean {
        if (provider == GOOGLE_HEALTH_PROVIDER_CODE && stepSampleOverlaps(
                sourceInstanceId,
                record,
            )
        ) return false

        return StepSamplesTable.insertIgnoreAndGetId {
            it[this.sourceInstanceId] = sourceInstanceId
            it[this.ingestionRecordId] = ingestionRecordId
            it[providerRecordId] = record.providerRecordId
            it[startAt] = record.startAt.toDbTimestamp()
            it[endAt] = record.endAt.toDbTimestamp()
            it[steps] = record.steps
            it[createdAt] = now.toDbTimestamp()
        } != null
    }

    private fun stepSampleOverlaps(
        sourceInstanceId: Int,
        record: StepIntervalRecord,
    ): Boolean {
        val candidateStartBefore = record.endAt.plusSeconds(1).toDbTimestamp()
        val candidateEndAfter = record.startAt.minusSeconds(1).toDbTimestamp()
        return StepSamplesTable.selectAll()
            .where {
                (StepSamplesTable.sourceInstanceId eq sourceInstanceId) and
                    (StepSamplesTable.startAt less candidateStartBefore) and
                    (StepSamplesTable.endAt greater candidateEndAfter)
            }
            .any {
                val existingStart = it[StepSamplesTable.startAt].toInstant()
                val existingEnd = it[StepSamplesTable.endAt].toInstant()
                existingStart.isBefore(record.endAt) &&
                    record.startAt.isBefore(existingEnd)
            }
    }
}
