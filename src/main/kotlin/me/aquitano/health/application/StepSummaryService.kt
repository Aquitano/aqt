package me.aquitano.health.application

import me.aquitano.health.infrastructure.repositories.MetricsWriteRepository
import java.time.Instant
import java.time.LocalDate

class StepSummaryService(
    private val metricsWriteRepository: MetricsWriteRepository,
) {
    fun recompute(
        sourceInstanceId: Int,
        dates: Set<LocalDate>,
        computedAt: Instant
    ) {
        dates.forEach { date ->
            metricsWriteRepository.recomputeStepDailySummary(
                sourceInstanceId,
                date,
                computedAt
            )
        }
    }
}
