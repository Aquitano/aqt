package me.aquitano.health.application

import me.aquitano.health.application.metric.common.repository.SleepNightReadFilters
import me.aquitano.health.application.metric.common.sourceInstanceIds
import me.aquitano.health.application.metric.sleep.derived.CANONICAL_SLEEP_NIGHT_ALGORITHM_VERSION
import me.aquitano.health.application.metric.sleep.derived.SLEEP_NIGHT_ALGORITHM_VERSION
import me.aquitano.health.application.metric.sleep.derived.SleepNightDerivation
import me.aquitano.health.application.metric.sleep.repository.SleepNightDerivationRepository
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

class SleepNightService(
    private val repository: SleepNightDerivationRepository,
    private val derivation: SleepNightDerivation = SleepNightDerivation(repository),
) {
    suspend fun recomputeUtc(
        sourceInstanceId: Int,
        dates: Set<LocalDate>,
        computedAt: Instant,
    ) {
        derivation.recompute(
            sourceInstanceIds = setOf(sourceInstanceId),
            dates = dates,
            timezone = ZoneOffset.UTC,
            computedAt = computedAt,
        )
    }

    suspend fun materialize(
        filters: SleepNightReadFilters,
        computedAt: Instant,
    ) {
        val dates = requestedDates(filters) ?: return
        val sourceInstanceIds = repository.sourceInstanceIds(
            provider = filters.provider,
            providerInstanceId = filters.providerInstanceId,
        )
        val datesToRecompute = repository.findDatesNeedingRecompute(
            sourceInstanceIds = sourceInstanceIds,
            dates = dates,
            timezone = filters.timezone,
            algorithmVersion = SLEEP_NIGHT_ALGORITHM_VERSION,
        )
        if (datesToRecompute.isNotEmpty()) {
            derivation.recompute(
                sourceInstanceIds = sourceInstanceIds,
                dates = datesToRecompute,
                timezone = filters.timezone,
                computedAt = computedAt,
            )
        }
    }

    suspend fun materializeCanonical(
        filters: SleepNightReadFilters,
        computedAt: Instant,
    ) {
        materialize(filters, computedAt)
        val dates = requestedDates(filters) ?: return
        val sourceInstanceIds = repository.sourceInstanceIds(
            provider = filters.provider,
            providerInstanceId = filters.providerInstanceId,
        )
        val datesToRecompute = repository.findCanonicalDatesNeedingRecompute(
            sourceInstanceIds = sourceInstanceIds,
            dates = dates,
            timezone = filters.timezone,
            algorithmVersion = CANONICAL_SLEEP_NIGHT_ALGORITHM_VERSION,
        )
        datesToRecompute.forEach { date ->
            val canonicalSessions = repository.listCanonicalSleepSessionsForCanonicalNights(
                sourceInstanceIds = sourceInstanceIds,
                timezone = filters.timezone,
                date = date,
            )
            repository.replaceCanonicalSleepNights(
                date = date,
                timezone = filters.timezone,
                sourceInstanceIds = sourceInstanceIds,
                algorithmVersion = CANONICAL_SLEEP_NIGHT_ALGORITHM_VERSION,
                computedAt = computedAt,
                sessions = canonicalSessions,
            )
        }
    }

    private fun requestedDates(filters: SleepNightReadFilters): Set<LocalDate>? {
        val fromDate = filters.fromDate
        val toDate = filters.toDate
        if (fromDate == null || toDate == null) return null
        return datesBetween(fromDate, toDate)
    }

    private fun datesBetween(
        fromDate: LocalDate,
        toDate: LocalDate,
    ): Set<LocalDate> {
        val dates = linkedSetOf<LocalDate>()
        var cursor = fromDate
        while (!cursor.isAfter(toDate)) {
            dates.add(cursor)
            cursor = cursor.plusDays(1)
        }
        return dates
    }
}
