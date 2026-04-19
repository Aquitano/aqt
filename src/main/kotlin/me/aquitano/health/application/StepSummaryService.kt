package me.aquitano.health.application

import me.aquitano.health.infrastructure.repositories.CanonicalWriteRepository
import java.time.Instant
import java.time.LocalDate

class StepSummaryService(
    private val canonicalWriteRepository: CanonicalWriteRepository,
) {
    fun recompute(
        sourceInstanceId: Int,
        dates: Set<LocalDate>,
        computedAt: Instant
    ) {
        dates.forEach { date ->
            canonicalWriteRepository.recomputeStepDailySummary(
                sourceInstanceId,
                date,
                computedAt
            )
        }
    }
}
