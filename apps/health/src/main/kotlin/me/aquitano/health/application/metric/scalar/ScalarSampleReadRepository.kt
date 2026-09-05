package me.aquitano.health.application.metric.scalar

import me.aquitano.health.application.metric.common.keysetFetchLimit
import me.aquitano.health.application.metric.common.repository.ReadFilters
import me.aquitano.health.application.metric.common.repository.SourceMetadata
import me.aquitano.health.infrastructure.database.tables.CanonicalScalarSamplesView
import me.aquitano.health.infrastructure.database.tables.ScalarSamplesTable
import me.aquitano.health.infrastructure.database.toDbTimestamp
import me.aquitano.health.application.metric.common.repository.BaseMetricReadRepository
import me.aquitano.health.application.metric.common.repository.TimeFilterMode
import org.jetbrains.exposed.v1.core.Expression
import org.jetbrains.exposed.v1.core.Function
import org.jetbrains.exposed.v1.core.Op
import org.jetbrains.exposed.v1.core.QueryBuilder
import org.jetbrains.exposed.v1.core.ResultRow
import org.jetbrains.exposed.v1.core.SortOrder
import org.jetbrains.exposed.v1.core.and
import org.jetbrains.exposed.v1.core.avg
import org.jetbrains.exposed.v1.core.count
import org.jetbrains.exposed.v1.core.eq
import org.jetbrains.exposed.v1.core.inList
import org.jetbrains.exposed.v1.core.less
import org.jetbrains.exposed.v1.core.max
import org.jetbrains.exposed.v1.core.min
import org.jetbrains.exposed.v1.core.stringLiteral
import org.jetbrains.exposed.v1.javatime.JavaLocalDateColumnType
import org.jetbrains.exposed.v1.jdbc.select
import org.jetbrains.exposed.v1.jdbc.selectAll
import java.time.Instant
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId

/**
 * Reads for all point-in-time scalar metrics. `canonical = true` reads through the
 * canonical_scalar_samples view (cross-provider dedup per 30s bin); `canonical = false`
 * reads every stored sample.
 */
class ScalarSampleReadRepository : BaseMetricReadRepository() {
    fun list(
        filters: ReadFilters,
        metricTypes: Set<String>,
        canonical: Boolean,
    ): Pair<List<ScalarSampleRow>, Map<Int, SourceMetadata>> {
        val table = source(canonical)
        val where = timestampConditions(
            filters = filters,
            sourceInstanceIdColumn = table.sourceInstanceId,
            fromColumn = table.measuredAt,
        ).whereOrNull() ?: return emptyReadResult()

        val keyset = timestampKeyset(filters.cursor, filters.order, table.measuredAt, table.idColumn)
        val rows = table.query
            .selectAll()
            .where(where and (table.metricType inList metricTypes) and (keyset ?: Op.TRUE))
            .orderBy(
                table.measuredAt to filters.sortOrder(),
                table.idColumn to filters.sortOrder(),
            )
            .limit(keysetFetchLimit(filters.limit))
            .map(table::toRow)
        return rows to sourceMetadata(
            rows.map { it.sourceInstanceId }.toSet(),
            filters.includeSource,
        )
    }

    fun latest(
        filters: ReadFilters,
        metricTypes: Set<String>,
        canonical: Boolean,
        mode: TimeFilterMode = TimeFilterMode.START_AT_IN_RANGE,
    ): Pair<ScalarSampleRow?, Map<Int, SourceMetadata>> {
        val table = source(canonical)
        val where = timestampConditions(
            filters = filters,
            sourceInstanceIdColumn = table.sourceInstanceId,
            fromColumn = table.measuredAt,
            mode = mode,
        ).whereOrNull() ?: return emptyLatestResult()

        // Honor filters.order: desc -> most recent (the common "latest"), asc -> earliest. Callers
        // that want the latest pass order = desc; previously this was hardcoded DESC, so an asc
        // caller silently got the newest sample instead of the earliest.
        val order = filters.sortOrder()
        val row = table.query
            .selectAll()
            .where(where and (table.metricType inList metricTypes))
            .orderBy(
                table.measuredAt to order,
                table.idColumn to order,
            )
            .limit(1)
            .map(table::toRow)
            .singleOrNull()
        return row to sourceMetadata(
            listOfNotNull(row?.sourceInstanceId).toSet(),
            filters.includeSource,
        )
    }

    fun latestBefore(
        filters: ReadFilters,
        metricTypes: Set<String>,
        canonical: Boolean,
    ): Pair<ScalarSampleRow?, Map<Int, SourceMetadata>> =
        latest(filters, metricTypes, canonical, mode = TimeFilterMode.BEFORE_FROM)

    /** Unfiltered "latest sample strictly before" lookup used by trend computations. */
    fun latestBefore(before: Instant, metricType: String): ScalarSampleRow? =
        ScalarSamplesTable
            .selectAll()
            .where {
                (ScalarSamplesTable.measuredAt less before.toDbTimestamp()) and
                    (ScalarSamplesTable.metricType eq metricType)
            }
            .orderBy(
                ScalarSamplesTable.measuredAt to SortOrder.DESC,
                ScalarSamplesTable.id to SortOrder.DESC,
            )
            .limit(1)
            .map { rawSource.toRow(it) }
            .singleOrNull()

    fun summarize(
        filters: ReadFilters,
        metricTypes: Set<String>,
        canonical: Boolean,
    ): ScalarSummaryRow {
        val table = source(canonical)
        val where = timestampConditions(
            filters = filters,
            sourceInstanceIdColumn = table.sourceInstanceId,
            fromColumn = table.measuredAt,
        ).whereOrNull() ?: return ScalarSummaryRow(0, null, null, null)

        val countExpression = table.valueColumn.count()
        val minExpression = table.valueColumn.min()
        val maxExpression = table.valueColumn.max()
        val avgExpression = table.valueColumn.avg()
        return table.query
            .select(countExpression, minExpression, maxExpression, avgExpression)
            .where(where and (table.metricType inList metricTypes))
            .single()
            .let {
                ScalarSummaryRow(
                    count = it[countExpression].toInt(),
                    minValue = it[minExpression],
                    maxValue = it[maxExpression],
                    avgValue = it[avgExpression]?.toDouble(),
                )
            }
    }

    /**
     * Per-day min/max/avg/count for the range, bucketed by the calendar day of [zone]. Callers pass
     * UTC to reproduce the day boundaries the frontend derives from `dateOnlyToUtcInstant`.
     */
    fun summarizeDaily(
        filters: ReadFilters,
        metricTypes: Set<String>,
        canonical: Boolean,
        zone: ZoneId,
    ): List<ScalarDailySummaryRow> {
        val table = source(canonical)
        val where = timestampConditions(
            filters = filters,
            sourceInstanceIdColumn = table.sourceInstanceId,
            fromColumn = table.measuredAt,
        ).whereOrNull() ?: return emptyList()

        val dayExpression = LocalDayOf(table.measuredAt, zone.id)
        val countExpression = table.valueColumn.count()
        val minExpression = table.valueColumn.min()
        val maxExpression = table.valueColumn.max()
        val avgExpression = table.valueColumn.avg()
        return table.query
            .select(dayExpression, countExpression, minExpression, maxExpression, avgExpression)
            .where(where and (table.metricType inList metricTypes))
            .groupBy(dayExpression)
            .orderBy(dayExpression to SortOrder.ASC)
            .map {
                ScalarDailySummaryRow(
                    date = it[dayExpression],
                    count = it[countExpression].toInt(),
                    minValue = it[minExpression],
                    maxValue = it[maxExpression],
                    avgValue = it[avgExpression]?.toDouble(),
                )
            }
    }

    private fun source(canonical: Boolean): ScalarSource =
        if (canonical) canonicalSource else rawSource

    /** Adapts the raw table and the canonical view to one column vocabulary. */
    private interface ScalarSource {
        val query: org.jetbrains.exposed.v1.core.Table
        val sourceInstanceId: org.jetbrains.exposed.v1.core.Column<Int>
        val measuredAt: org.jetbrains.exposed.v1.core.Column<java.time.OffsetDateTime>
        val metricType: org.jetbrains.exposed.v1.core.Column<String>
        val valueColumn: org.jetbrains.exposed.v1.core.Column<Double>
        val idColumn: org.jetbrains.exposed.v1.core.Expression<*>

        fun toRow(row: ResultRow): ScalarSampleRow
    }

    private val rawSource = object : ScalarSource {
        override val query get() = ScalarSamplesTable
        override val sourceInstanceId get() = ScalarSamplesTable.sourceInstanceId
        override val measuredAt get() = ScalarSamplesTable.measuredAt
        override val metricType get() = ScalarSamplesTable.metricType
        override val valueColumn get() = ScalarSamplesTable.value
        override val idColumn get() = ScalarSamplesTable.id

        override fun toRow(row: ResultRow): ScalarSampleRow =
            ScalarSampleRow(
                id = row[ScalarSamplesTable.id].value,
                sourceInstanceId = row[ScalarSamplesTable.sourceInstanceId],
                measuredAt = row[ScalarSamplesTable.measuredAt].toInstant(),
                metricType = row[ScalarSamplesTable.metricType],
                value = row[ScalarSamplesTable.value],
                unit = row[ScalarSamplesTable.unit],
                context = row[ScalarSamplesTable.context],
                segment = row[ScalarSamplesTable.segment],
            )
    }

    private val canonicalSource = object : ScalarSource {
        override val query get() = CanonicalScalarSamplesView
        override val sourceInstanceId get() = CanonicalScalarSamplesView.sourceInstanceId
        override val measuredAt get() = CanonicalScalarSamplesView.measuredAt
        override val metricType get() = CanonicalScalarSamplesView.metricType
        override val valueColumn get() = CanonicalScalarSamplesView.value
        override val idColumn get() = CanonicalScalarSamplesView.id

        override fun toRow(row: ResultRow): ScalarSampleRow =
            ScalarSampleRow(
                id = row[CanonicalScalarSamplesView.id],
                sourceInstanceId = row[CanonicalScalarSamplesView.sourceInstanceId],
                measuredAt = row[CanonicalScalarSamplesView.measuredAt].toInstant(),
                metricType = row[CanonicalScalarSamplesView.metricType],
                value = row[CanonicalScalarSamplesView.value],
                unit = row[CanonicalScalarSamplesView.unit],
                context = row[CanonicalScalarSamplesView.context],
                segment = row[CanonicalScalarSamplesView.segment],
            )
    }
}

/**
 * Truncates a `timestamptz` to the calendar day of [zoneId]. Postgres `date_trunc` runs in the
 * session timezone, so the explicit `AT TIME ZONE` conversion is what keeps a sample on either side
 * of local midnight in the correct day rather than silently misbucketing on the session's zone.
 *
 * The zone is inlined as a literal (not a bound parameter) so the identical expression renders in
 * both SELECT and GROUP BY; a parameter would emit two distinct placeholders that Postgres refuses
 * to treat as the same grouping key. [zoneId] is a validated IANA identifier from `ZoneId.of`.
 */
private class LocalDayOf(
    private val timestamp: Expression<OffsetDateTime>,
    private val zoneId: String,
) : Function<LocalDate>(JavaLocalDateColumnType()) {
    override fun toQueryBuilder(queryBuilder: QueryBuilder) = queryBuilder {
        append("CAST(date_trunc('day', ")
        append(timestamp)
        append(" AT TIME ZONE ")
        append(stringLiteral(zoneId))
        append(") AS DATE)")
    }
}
