package me.aquitano.health.application.metric.scalar

import me.aquitano.health.domain.ScalarSampleRecord
import me.aquitano.health.domain.ScalarValue
import me.aquitano.health.infrastructure.database.tables.ScalarSamplesTable
import me.aquitano.health.infrastructure.database.toDbTimestamp
import org.jetbrains.exposed.v1.core.and
import org.jetbrains.exposed.v1.core.eq
import org.jetbrains.exposed.v1.core.inList
import org.jetbrains.exposed.v1.core.isNull
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
     * Duplicates are detected before inserting (conflict-ignored rows can't be told apart from
     * inserted ones in a multi-row statement), against two keys that mirror the DB unique indexes:
     *  - rows that carry a provider record id -> scalar_samples_provider_record_uq
     *  - rows without one -> scalar_samples_natural_key_uq (source, metric type, measured at, segment)
     * so re-syncs of id-less feeds (derived metrics, some Google data) stop accumulating duplicates.
     * `ignore = true` stays on the insert as a guard against concurrent writers.
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
        val toInsert = rows.filter { row -> seenKeys.add(row.uniqueKey()) }
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
        val keys = hashSetOf<SampleKey>()

        val providerRecordIds = rows.mapNotNullTo(linkedSetOf()) { it.record.providerRecordId }
        providerRecordIds.toList().chunked(INSERT_CHUNK_SIZE).forEach { chunk ->
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
                .forEach { row ->
                    row[ScalarSamplesTable.providerRecordId]?.let { providerRecordId ->
                        keys += SampleKey.ByRecord(
                            providerRecordId = providerRecordId,
                            metricType = row[ScalarSamplesTable.metricType],
                            segment = row[ScalarSamplesTable.segment] ?: "",
                        )
                    }
                }
        }

        // Id-less rows can't use the provider-record key, so dedupe them on the natural key. The
        // DB query keys back to existing NULL-id rows (matching scalar_samples_natural_key_uq) so a
        // re-sync of a feed without stable ids doesn't pile up duplicate samples.
        val measuredAtsWithoutId = rows
            .filter { it.record.providerRecordId == null }
            .mapTo(linkedSetOf()) { it.record.measuredAt }
        measuredAtsWithoutId.toList().chunked(INSERT_CHUNK_SIZE).forEach { chunk ->
            ScalarSamplesTable
                .select(
                    ScalarSamplesTable.measuredAt,
                    ScalarSamplesTable.metricType,
                    ScalarSamplesTable.segment,
                )
                .where {
                    (ScalarSamplesTable.sourceInstanceId eq sourceInstanceId) and
                            ScalarSamplesTable.providerRecordId.isNull() and
                            (ScalarSamplesTable.measuredAt inList chunk.map { it.toDbTimestamp() })
                }
                .forEach { row ->
                    keys += SampleKey.ByNatural(
                        measuredAt = row[ScalarSamplesTable.measuredAt].toInstant(),
                        metricType = row[ScalarSamplesTable.metricType],
                        segment = row[ScalarSamplesTable.segment] ?: "",
                    )
                }
        }
        return keys
    }
}

private data class SampleRow(
    val ingestionRecordId: Int,
    val record: ScalarSampleRecord,
    val value: ScalarValue,
)

/**
 * Dedup key. Rows carrying a provider record id mirror scalar_samples_provider_record_uq; id-less
 * rows fall back to the natural key (scalar_samples_natural_key_uq), both coalescing NULL segment
 * to ''.
 */
private sealed interface SampleKey {
    data class ByRecord(
        val providerRecordId: String,
        val metricType: String,
        val segment: String,
    ) : SampleKey

    data class ByNatural(
        val measuredAt: Instant,
        val metricType: String,
        val segment: String,
    ) : SampleKey
}

private fun SampleRow.uniqueKey(): SampleKey =
    record.providerRecordId?.let { providerRecordId ->
        SampleKey.ByRecord(
            providerRecordId = providerRecordId,
            metricType = value.metricType,
            segment = value.segment ?: "",
        )
    } ?: SampleKey.ByNatural(
        measuredAt = record.measuredAt,
        metricType = value.metricType,
        segment = value.segment ?: "",
    )

private const val INSERT_CHUNK_SIZE = 1_000
