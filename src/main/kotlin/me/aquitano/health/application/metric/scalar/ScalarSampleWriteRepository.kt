package me.aquitano.health.application.metric.scalar

import me.aquitano.health.domain.ScalarSampleRecord
import me.aquitano.health.domain.ScalarValue
import me.aquitano.health.infrastructure.database.tables.ScalarSamplesTable
import me.aquitano.health.infrastructure.database.toDbTimestamp
import org.jetbrains.exposed.v1.core.and
import org.jetbrains.exposed.v1.core.eq
import org.jetbrains.exposed.v1.core.inList
import org.jetbrains.exposed.v1.jdbc.batchInsert
import org.jetbrains.exposed.v1.jdbc.select
import java.time.Instant

data class ScalarSampleWrite(
    val ingestionRecordId: Int,
    val record: ScalarSampleRecord,
)

class ScalarSampleWriteRepository {
    /** Returns the metric types actually inserted (duplicates are skipped). */
    fun insertScalarSamples(
        sourceInstanceId: Int,
        ingestionRecordId: Int,
        record: ScalarSampleRecord,
        now: Instant,
    ): List<String> =
        insertScalarSamples(
            sourceInstanceId,
            listOf(ScalarSampleWrite(ingestionRecordId, record)),
            now,
        )

    /**
     * Bulk variant: one metric type per value actually inserted (duplicates are skipped).
     * Duplicates are detected against the scalar_samples_provider_record_uq key
     * (source instance, provider record id, metric type, segment) before inserting, because
     * conflict-ignored rows cannot be told apart from inserted ones in a multi-row statement;
     * `ignore = true` stays on the insert only as a guard against concurrent writers.
     */
    fun insertScalarSamples(
        sourceInstanceId: Int,
        writes: List<ScalarSampleWrite>,
        now: Instant,
    ): List<String> {
        val rows = writes.flatMap { write ->
            write.record.values.map { value -> SampleRow(write.ingestionRecordId, write.record, value) }
        }
        val seenKeys = existingKeys(sourceInstanceId, rows)
        val toInsert = rows.filter { row ->
            val key = row.uniqueKey() ?: return@filter true
            seenKeys.add(key)
        }
        toInsert.chunked(INSERT_CHUNK_SIZE).forEach { chunk ->
            ScalarSamplesTable.batchInsert(
                chunk,
                ignore = true,
                shouldReturnGeneratedValues = false,
            ) { row ->
                this[ScalarSamplesTable.sourceInstanceId] = sourceInstanceId
                this[ScalarSamplesTable.ingestionRecordId] = row.ingestionRecordId
                this[ScalarSamplesTable.providerRecordId] = row.record.providerRecordId
                this[ScalarSamplesTable.measuredAt] = row.record.measuredAt.toDbTimestamp()
                this[ScalarSamplesTable.metricType] = row.value.metricType
                this[ScalarSamplesTable.value] = row.value.value
                this[ScalarSamplesTable.unit] = row.value.unit
                this[ScalarSamplesTable.context] = row.value.context
                this[ScalarSamplesTable.segment] = row.value.segment
                this[ScalarSamplesTable.createdAt] = now.toDbTimestamp()
            }
        }
        return toInsert.map { it.value.metricType }
    }

    private fun existingKeys(
        sourceInstanceId: Int,
        rows: List<SampleRow>,
    ): MutableSet<SampleKey> {
        val providerRecordIds = rows.mapNotNullTo(linkedSetOf()) { it.record.providerRecordId }
        if (providerRecordIds.isEmpty()) return hashSetOf()
        return providerRecordIds.toList().chunked(INSERT_CHUNK_SIZE).flatMapTo(hashSetOf()) { chunk ->
            ScalarSamplesTable
                .select(
                    ScalarSamplesTable.providerRecordId,
                    ScalarSamplesTable.metricType,
                    ScalarSamplesTable.segment,
                )
                .where {
                    (ScalarSamplesTable.sourceInstanceId eq sourceInstanceId) and
                            (ScalarSamplesTable.providerRecordId inList chunk)
                }
                .mapNotNull { row ->
                    row[ScalarSamplesTable.providerRecordId]?.let { providerRecordId ->
                        SampleKey(
                            providerRecordId = providerRecordId,
                            metricType = row[ScalarSamplesTable.metricType],
                            segment = row[ScalarSamplesTable.segment] ?: "",
                        )
                    }
                }
        }
    }
}

private data class SampleRow(
    val ingestionRecordId: Int,
    val record: ScalarSampleRecord,
    val value: ScalarValue,
)

/** Mirrors scalar_samples_provider_record_uq, which coalesces NULL segment to ''. */
private data class SampleKey(
    val providerRecordId: String,
    val metricType: String,
    val segment: String,
)

private fun SampleRow.uniqueKey(): SampleKey? =
    record.providerRecordId?.let { providerRecordId ->
        SampleKey(
            providerRecordId = providerRecordId,
            metricType = value.metricType,
            segment = value.segment ?: "",
        )
    }

private const val INSERT_CHUNK_SIZE = 1_000
