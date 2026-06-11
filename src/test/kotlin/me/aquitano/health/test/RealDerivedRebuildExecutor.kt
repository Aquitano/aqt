package me.aquitano.health.test

import me.aquitano.health.application.DerivedRebuildExecutor
import me.aquitano.health.application.DerivedRebuildModuleRegistry
import me.aquitano.health.application.SleepNightService
import me.aquitano.health.application.StepSummaryService
import me.aquitano.health.application.TransactionalDerivedRebuildExecutor
import me.aquitano.health.application.derivedRebuildModules
import me.aquitano.health.application.metric.activity.derived.CanonicalActivitySummaryDerivationService
import me.aquitano.health.application.metric.activity.repository.CanonicalActivitySummaryDerivationRepository
import me.aquitano.health.application.metric.sleep.derived.CanonicalSleepSessionDerivationService
import me.aquitano.health.application.metric.sleep.derived.CanonicalSleepSummaryDerivationService
import me.aquitano.health.application.metric.sleep.repository.CanonicalSleepSessionDerivationRepository
import me.aquitano.health.application.metric.sleep.repository.CanonicalSleepSummaryDerivationRepository
import me.aquitano.health.application.metric.sleep.repository.SleepNightDerivationRepository
import me.aquitano.health.application.metric.steps.derived.CanonicalStepDerivationService
import me.aquitano.health.application.metric.steps.repository.CanonicalStepDerivationRepository
import me.aquitano.health.application.metric.steps.repository.StepDailySummaryDerivationRepository
import org.jetbrains.exposed.v1.jdbc.Database

/** The production rebuild wiring with default-constructed services, for tests that assert derived tables. */
fun realDerivedRebuildExecutor(database: Database): DerivedRebuildExecutor =
    TransactionalDerivedRebuildExecutor(
        database = database,
        registry = DerivedRebuildModuleRegistry(
            derivedRebuildModules(
                stepSummaryService = StepSummaryService(StepDailySummaryDerivationRepository()),
                canonicalStepService = CanonicalStepDerivationService(CanonicalStepDerivationRepository()),
                sleepNightService = SleepNightService(SleepNightDerivationRepository()),
                canonicalSleepSummaryService = CanonicalSleepSummaryDerivationService(
                    CanonicalSleepSummaryDerivationRepository()
                ),
                canonicalSleepSessionService = CanonicalSleepSessionDerivationService(
                    CanonicalSleepSessionDerivationRepository()
                ),
                canonicalActivitySummaryService = CanonicalActivitySummaryDerivationService(
                    CanonicalActivitySummaryDerivationRepository()
                ),
            )
        ),
    )
