package me.aquitano.health.application

import me.aquitano.health.application.metric.steps.derived.StepDailySummaryDerivation
import me.aquitano.health.application.metric.steps.repository.StepDailySummaryDerivationRepository
import java.time.Instant
import java.time.LocalDate

class StepSummaryService(
    private val derivation: StepDailySummaryDerivation,
) {
    constructor(repository: StepDailySummaryDerivationRepository) : this(
        StepDailySummaryDerivation(repository)
    )

    suspend fun recompute(
        sourceInstanceId: Int,
        dates: Set<LocalDate>,
        computedAt: Instant
    ) {
        derivation.recompute(sourceInstanceId, dates, computedAt)
    }
}
