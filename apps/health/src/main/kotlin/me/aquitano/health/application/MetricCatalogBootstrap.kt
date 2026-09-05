package me.aquitano.health.application

import me.aquitano.health.domain.MetricFamilies
import me.aquitano.health.domain.ScalarMetricRegistry
import me.aquitano.health.infrastructure.database.tables.MetricCatalogTable
import me.aquitano.health.infrastructure.database.tables.ProviderRanksTable
import org.jetbrains.exposed.v1.jdbc.Database
import org.jetbrains.exposed.v1.jdbc.transactions.transaction
import org.jetbrains.exposed.v1.jdbc.upsert

/**
 * Source of truth for metric_catalog and provider_ranks is Kotlin: the migration seeds them
 * once, and this bootstrap re-upserts on every startup so adding a scalar metric or changing
 * a provider rank is a registry/policy edit plus restart — no migration.
 */
class MetricCatalogBootstrap(private val database: Database) {
    fun run() {
        transaction(db = database) {
            ScalarMetricRegistry.descriptors.forEach { descriptor ->
                MetricCatalogTable.upsert(MetricCatalogTable.metricType) {
                    it[metricType] = descriptor.metricType
                    it[family] = descriptor.family
                    it[unit] = descriptor.unit
                    it[minValue] = descriptor.valueRange.min
                    it[maxValue] = descriptor.valueRange.max
                    it[supportsSegment] = descriptor.supportsSegment
                }
            }
            providerRanks.forEach { (family, providers) ->
                providers.forEachIndexed { rank, providerCode ->
                    ProviderRanksTable.upsert(
                        ProviderRanksTable.family,
                        ProviderRanksTable.providerCode,
                    ) {
                        it[this.family] = family
                        it[this.providerCode] = providerCode
                        it[this.rank] = rank
                    }
                }
            }
        }
    }

    companion object {
        /** Mirrors CanonicalMetricsPolicy.default(); list order is the rank order (0 wins). */
        val providerRanks: Map<String, List<String>> = mapOf(
            MetricFamilies.STEPS to listOf("google_health", "health_connect", "withings"),
            MetricFamilies.ACTIVITY to listOf("google_health", "health_connect", "withings"),
            MetricFamilies.SLEEP to listOf("withings", "google_health", "health_connect"),
            MetricFamilies.SLEEP_SUMMARY to listOf("withings", "google_health", "health_connect"),
            MetricFamilies.BODY_MEASUREMENT to listOf("withings", "google_health", "health_connect"),
            MetricFamilies.HEART_RATE to listOf("google_health", "health_connect", "withings"),
            MetricFamilies.RESPIRATORY_RATE to listOf("withings", "google_health", "health_connect"),
            MetricFamilies.HRV to listOf("withings", "google_health", "health_connect"),
            MetricFamilies.CARDIOVASCULAR to listOf("withings", "google_health", "health_connect"),
        )
    }
}
