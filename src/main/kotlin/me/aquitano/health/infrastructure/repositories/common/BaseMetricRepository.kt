package me.aquitano.health.infrastructure.repositories.common

import me.aquitano.health.application.metric.common.MetricReadRepository
import me.aquitano.health.application.metric.common.repository.DailyReadFilters
import me.aquitano.health.application.metric.common.repository.ReadFilters
import me.aquitano.health.application.metric.common.repository.SleepNightReadFilters
import me.aquitano.health.application.metric.common.repository.SourceMetadata
import me.aquitano.health.infrastructure.database.tables.SourceInstancesTable
import me.aquitano.health.infrastructure.database.tables.SourcesTable
import org.jetbrains.exposed.v1.core.Op
import org.jetbrains.exposed.v1.core.SortOrder
import org.jetbrains.exposed.v1.core.and
import org.jetbrains.exposed.v1.core.eq
import org.jetbrains.exposed.v1.core.inList
import org.jetbrains.exposed.v1.jdbc.select
import org.jetbrains.exposed.v1.jdbc.selectAll

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
    protected fun sourceInstanceIds(provider: String?, providerInstanceId: String?): List<Int>? {
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
     * Converts a string order ("asc" / "desc") into an Exposed [SortOrder].
     */
    protected fun sortOrder(order: String): SortOrder =
        if (order.equals("desc", ignoreCase = true)) SortOrder.DESC else SortOrder.ASC

    protected fun ReadFilters.sortOrder(): SortOrder =
        sortOrder(order)

    protected fun DailyReadFilters.sortOrder(): SortOrder =
        sortOrder(order)

    protected fun SleepNightReadFilters.sortOrder(): SortOrder =
        sortOrder(order)
}
