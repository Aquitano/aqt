package me.aquitano.health.application.metric.scalar

import me.aquitano.health.domain.ScalarSampleRecord
import me.aquitano.health.infrastructure.database.tables.ScalarSamplesTable
import me.aquitano.health.infrastructure.database.toDbTimestamp
import org.jetbrains.exposed.v1.jdbc.insertIgnoreAndGetId
import java.time.Instant

class ScalarSampleWriteRepository {
    /** Returns the number of values actually inserted (duplicates are skipped). */
    fun insertScalarSamples(
        sourceInstanceId: Int,
        ingestionRecordId: Int,
        record: ScalarSampleRecord,
        now: Instant,
    ): List<String> {
        val insertedTypes = mutableListOf<String>()
        record.values.forEach { value ->
            val inserted = ScalarSamplesTable.insertIgnoreAndGetId {
                it[this.sourceInstanceId] = sourceInstanceId
                it[this.ingestionRecordId] = ingestionRecordId
                it[providerRecordId] = record.providerRecordId
                it[measuredAt] = record.measuredAt.toDbTimestamp()
                it[metricType] = value.metricType
                it[this.value] = value.value
                it[unit] = value.unit
                it[context] = value.context
                it[segment] = value.segment
                it[createdAt] = now.toDbTimestamp()
            } != null
            if (inserted) insertedTypes += value.metricType
        }
        return insertedTypes
    }
}
