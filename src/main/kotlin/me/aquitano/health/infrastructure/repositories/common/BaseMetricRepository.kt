package me.aquitano.health.infrastructure.repositories.common

import me.aquitano.health.application.metric.common.MetricReadRepository
import me.aquitano.health.application.metric.common.repository.DailyReadFilters
import me.aquitano.health.application.metric.common.repository.ReadFilters
import me.aquitano.health.application.metric.common.repository.SleepNightReadFilters
import me.aquitano.health.application.metric.common.repository.SourceMetadata
import me.aquitano.health.domain.RequestValidationException
import me.aquitano.health.domain.ValidationIssue
import me.aquitano.health.domain.ValidationIssueCodes
import me.aquitano.health.infrastructure.database.tables.SourceInstancesTable
import me.aquitano.health.infrastructure.database.tables.SourcesTable
import me.aquitano.health.infrastructure.database.toDbTimestamp
import me.aquitano.health.shared.Cursor
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.jdbc.select
import java.time.Instant
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneOffset

/**
 * Base class for metric-specific read repositories.
 *
 * Extracts the common query-building helpers that every metric repository needs
 * (source metadata resolution, provider filtering, condition composition, sort
 * order conversion) so that concrete repositories only contain table-specific
 * query logic.
 */
abstract class BaseMetricRepository : MetricReadRepository {

    override fun sourceMetadataFor(sourceIds: Set<Int>): Map<Int, SourceMetadata> {
        if (sourceIds.isEmpty()) return emptyMap()
        return SourceInstancesTable
            .innerJoin(SourcesTable)
            .select(
                SourceInstancesTable.id,
                SourcesTable.code,
                SourceInstancesTable.providerInstanceId,
            )
            .where { SourceInstancesTable.id inList sourceIds }
            .associate {
                it[SourceInstancesTable.id].value to SourceMetadata(
                    provider = it[SourcesTable.code],
                    providerInstanceId = it[SourceInstancesTable.providerInstanceId],
                )
            }
    }

    /**
     * Resolves source instance IDs that match the optional [provider] and
     * [providerInstanceId] filters.
     *
     * Returns `null` when neither filter is supplied, signalling that no
     * source filtering should be applied.
     */
    protected fun sourceInstanceIds(
        provider: String?,
        providerInstanceId: String?
    ): List<Int>? {
        if (provider == null && providerInstanceId == null) return null
        return SourceInstancesTable
            .innerJoin(SourcesTable)
            .select(SourceInstancesTable.id)
            .where {
                val conditions = mutableListOf<Op<Boolean>>()
                provider?.let { conditions.add(SourcesTable.code eq it) }
                providerInstanceId?.let {
                    conditions.add(SourceInstancesTable.providerInstanceId eq it)
                }
                combineConditions(conditions)
            }
            .map { it[SourceInstancesTable.id].value }
    }

    protected fun ReadFilters.sourceInstanceIds(): List<Int>? =
        sourceInstanceIds(provider, providerInstanceId)

    protected fun DailyReadFilters.sourceInstanceIds(): List<Int>? =
        sourceInstanceIds(provider, providerInstanceId)

    protected fun SleepNightReadFilters.sourceInstanceIds(): List<Int>? =
        sourceInstanceIds(provider, providerInstanceId)

    protected fun List<Int>?.hasNoMatchingSources(): Boolean =
        this != null && isEmpty()

    protected fun <T> emptyReadResult(): Pair<List<T>, Map<Int, SourceMetadata>> =
        emptyList<T>() to emptyMap()

    protected fun <T> emptyLatestResult(): Pair<T?, Map<Int, SourceMetadata>> =
        null to emptyMap()

    protected fun <T, S> emptyTripleReadResult(): Triple<List<T>, Map<Int, List<S>>, Map<Int, SourceMetadata>> =
        Triple(emptyList(), emptyMap(), emptyMap())

    protected fun <T, S> emptyTripleLatestResult(): Triple<T?, Map<Int, List<S>>, Map<Int, SourceMetadata>> =
        Triple(null, emptyMap(), emptyMap())

    protected fun timestampConditions(
        filters: ReadFilters,
        sourceInstanceIdColumn: Column<Int>,
        fromColumn: Column<OffsetDateTime>,
        toColumn: Column<OffsetDateTime>? = null,
        mode: TimeFilterMode = TimeFilterMode.START_AT_IN_RANGE,
    ): MetricConditionResult {
        val sourceIds = filters.sourceInstanceIds()

        if (sourceIds != null && sourceIds.isEmpty()) {
            return MetricConditionResult.Empty
        }

        val conditions = mutableListOf<Op<Boolean>>()

        when (mode) {
            TimeFilterMode.START_AT_IN_RANGE -> {
                filters.from?.let {
                    conditions.add(fromColumn greaterEq it.toDbTimestamp())
                }
                filters.to?.let {
                    conditions.add(fromColumn less it.toDbTimestamp())
                }
            }

            TimeFilterMode.OVERLAPS_WINDOW -> {
                requireNotNull(toColumn) {
                    "toColumn is required for OVERLAPS_WINDOW filtering"
                }

                filters.from?.let {
                    conditions.add(toColumn greater it.toDbTimestamp())
                }
                filters.to?.let {
                    conditions.add(fromColumn less it.toDbTimestamp())
                }
            }

            TimeFilterMode.BEFORE_FROM -> {
                filters.from?.let {
                    conditions.add(fromColumn less it.toDbTimestamp())
                }
            }

            TimeFilterMode.OVERLAPS_WINDOW_INCLUSIVE_FROM -> {
                requireNotNull(toColumn) {
                    "toColumn is required for OVERLAPS_WINDOW_INCLUSIVE_FROM filtering"
                }

                filters.from?.let {
                    conditions.add(toColumn greaterEq it.toDbTimestamp())
                }
                filters.to?.let {
                    conditions.add(fromColumn less it.toDbTimestamp())
                }
            }
        }

        sourceIds?.let {
            conditions.add(sourceInstanceIdColumn inList it)
        }

        return MetricConditionResult.Conditions(combineConditions(conditions))
    }

    protected fun dateConditions(
        filters: DailyReadFilters,
        sourceInstanceIdColumn: Column<Int>,
        dateColumn: Column<LocalDate>,
    ): MetricConditionResult {
        val sourceIds = filters.sourceInstanceIds()

        if (sourceIds.hasNoMatchingSources()) {
            return MetricConditionResult.Empty
        }

        val conditions = mutableListOf<Op<Boolean>>()
        filters.fromDate?.let { conditions.add(dateColumn greaterEq it) }
        filters.toDate?.let { conditions.add(dateColumn lessEq it) }
        sourceIds?.let { conditions.add(sourceInstanceIdColumn inList it) }

        return MetricConditionResult.Conditions(combineConditions(conditions))
    }

    protected fun zonedDateTimeConditions(
        filters: SleepNightReadFilters,
        sourceInstanceIdColumn: Column<Int>,
        timestampColumn: Column<OffsetDateTime>,
    ): MetricConditionResult {
        val sourceIds = filters.sourceInstanceIds()

        if (sourceIds.hasNoMatchingSources()) {
            return MetricConditionResult.Empty
        }

        val conditions = mutableListOf<Op<Boolean>>()
        filters.fromDate?.let {
            conditions.add(timestampColumn greaterEq it.atStartOfDay(filters.timezone).toInstant().toDbTimestamp())
        }
        filters.toDate?.let {
            conditions.add(
                timestampColumn less it.plusDays(1)
                    .atStartOfDay(filters.timezone)
                    .toInstant()
                    .toDbTimestamp()
            )
        }
        sourceIds?.let { conditions.add(sourceInstanceIdColumn inList it) }

        return MetricConditionResult.Conditions(combineConditions(conditions))
    }

    protected fun MetricConditionResult.whereOrNull(): Op<Boolean>? =
        when (this) {
            MetricConditionResult.Empty -> null
            is MetricConditionResult.Conditions -> where
        }

    protected fun sourceMetadata(
        sourceInstanceIds: Set<Int>,
        includeSource: Boolean,
    ): Map<Int, SourceMetadata> =
        if (includeSource) sourceMetadataFor(sourceInstanceIds) else emptyMap()

    /**
     * Combines a list of Exposed boolean conditions with `AND`.
     *
     * Returns [Op.TRUE] when the list is empty.
     */
    protected fun combineConditions(conditions: List<Op<Boolean>>): Op<Boolean> =
        conditions.reduceOrNull { left, right -> left and right } ?: Op.TRUE

    /**
     * Keyset predicate for cursor pagination over a timestamp sort column:
     * `(sortCol, id) > (cursor.sortValue, cursor.lastId)` (mirrored for desc).
     */
    protected fun timestampKeyset(
        cursor: Cursor?,
        order: String,
        sortColumn: Column<OffsetDateTime>,
        idExpression: Expression<*>,
    ): Op<Boolean>? {
        if (cursor == null) return null
        val sortValue = runCatching {
            Instant.parse(cursor.sortValue).atOffset(ZoneOffset.UTC)
        }.getOrElse { throw invalidCursor() }
        return keyset(order, sortColumn, LiteralOp(sortColumn.columnType, sortValue), idExpression, cursor.lastId)
    }

    /** Keyset predicate for cursor pagination over a date sort column. */
    protected fun dateKeyset(
        cursor: Cursor?,
        order: String,
        sortColumn: Column<LocalDate>,
        idExpression: Expression<*>,
    ): Op<Boolean>? {
        if (cursor == null) return null
        val sortValue = runCatching { LocalDate.parse(cursor.sortValue) }
            .getOrElse { throw invalidCursor() }
        return keyset(order, sortColumn, LiteralOp(sortColumn.columnType, sortValue), idExpression, cursor.lastId)
    }

    private fun keyset(
        order: String,
        sortExpression: Expression<*>,
        sortValue: Expression<*>,
        idExpression: Expression<*>,
        lastId: Long,
    ): Op<Boolean> {
        val idValue = longParam(lastId)
        return if (sortOrder(order) == SortOrder.DESC) {
            LessOp(sortExpression, sortValue) or
                (EqOp(sortExpression, sortValue) and LessOp(idExpression, idValue))
        } else {
            GreaterOp(sortExpression, sortValue) or
                (EqOp(sortExpression, sortValue) and GreaterOp(idExpression, idValue))
        }
    }

    private fun invalidCursor(): RequestValidationException =
        RequestValidationException(
            listOf(
                ValidationIssue(
                    field = "cursor",
                    code = ValidationIssueCodes.InvalidFormat,
                    message = "is not a valid cursor",
                )
            )
        )

    /**
     * Converts a string order ("asc" / "desc") into an Exposed [SortOrder].
     */
    protected fun sortOrder(order: String): SortOrder =
        if (order.equals(
                "desc",
                ignoreCase = true
            )
        ) SortOrder.DESC else SortOrder.ASC

    protected fun ReadFilters.sortOrder(): SortOrder =
        sortOrder(order)

    protected fun DailyReadFilters.sortOrder(): SortOrder =
        sortOrder(order)

    protected fun SleepNightReadFilters.sortOrder(): SortOrder =
        sortOrder(order)
}

enum class TimeFilterMode {
    START_AT_IN_RANGE,
    OVERLAPS_WINDOW,
    BEFORE_FROM,
    OVERLAPS_WINDOW_INCLUSIVE_FROM,
}

sealed interface MetricConditionResult {
    data object Empty : MetricConditionResult

    data class Conditions(
        val where: Op<Boolean>,
    ) : MetricConditionResult
}
