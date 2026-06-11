package me.aquitano.health.application

import me.aquitano.health.application.metric.activity.derived.CanonicalActivitySummaryDerivationService
import me.aquitano.health.application.metric.sleep.derived.CanonicalSleepSessionDerivationService
import me.aquitano.health.application.metric.sleep.derived.CanonicalSleepSummaryDerivationService
import me.aquitano.health.application.metric.steps.derived.CanonicalStepDerivationService
import me.aquitano.health.domain.DerivedKind
import org.jetbrains.exposed.v1.jdbc.Database
import org.jetbrains.exposed.v1.jdbc.transactions.suspendTransaction
import java.time.Instant
import java.time.LocalDate

interface DerivedRebuildExecutor {
    suspend fun rebuild(request: DerivedRebuildRequest, computedAt: Instant)
}

data class DerivedRebuildRequest(
    val sourceInstanceId: Int,
    val affectedDates: Map<DerivedKind, Set<LocalDate>> = emptyMap(),
) {
    operator fun get(kind: DerivedKind): Set<LocalDate> = affectedDates[kind] ?: emptySet()

    fun hasWork(): Boolean = affectedDates.values.any { it.isNotEmpty() }
}

fun interface DerivedRebuildAction {
    suspend fun rebuild(sourceInstanceId: Int, dates: Set<LocalDate>, computedAt: Instant)
}

class DerivedRebuildModule(
    val kind: DerivedKind,
    val action: DerivedRebuildAction,
)

/**
 * Ordered registry of derived rebuilds, mirroring HealthDayModuleRegistry. Every DerivedKind
 * must be covered so a new kind cannot silently skip its rebuild.
 */
class DerivedRebuildModuleRegistry(val modules: List<DerivedRebuildModule>) {
    init {
        val kinds = modules.map { it.kind }
        require(kinds.size == kinds.toSet().size) {
            "Duplicate DerivedRebuildModule kinds: ${kinds.groupBy { it }.filterValues { it.size > 1 }.keys}"
        }
        val missing = DerivedKind.entries.toSet() - kinds.toSet()
        require(missing.isEmpty()) { "Missing DerivedRebuildModule for: $missing" }
    }
}

/** The canonical post-ingestion rebuild wiring; order is the execution order. */
fun derivedRebuildModules(
    stepSummaryService: StepSummaryService,
    canonicalStepService: CanonicalStepDerivationService,
    sleepNightService: SleepNightService,
    canonicalSleepSummaryService: CanonicalSleepSummaryDerivationService,
    canonicalSleepSessionService: CanonicalSleepSessionDerivationService,
    canonicalActivitySummaryService: CanonicalActivitySummaryDerivationService,
): List<DerivedRebuildModule> =
    listOf(
        DerivedRebuildModule(DerivedKind.STEP_SUMMARY) { sourceInstanceId, dates, computedAt ->
            stepSummaryService.recompute(sourceInstanceId, dates, computedAt)
            canonicalStepService.recompute(dates, computedAt)
        },
        DerivedRebuildModule(DerivedKind.SLEEP_NIGHT) { sourceInstanceId, dates, computedAt ->
            sleepNightService.recomputeUtc(sourceInstanceId, dates, computedAt)
        },
        DerivedRebuildModule(DerivedKind.SLEEP_SUMMARY_CANONICAL) { _, dates, computedAt ->
            canonicalSleepSummaryService.recompute(dates, computedAt)
        },
        DerivedRebuildModule(DerivedKind.SLEEP_SESSION_CANONICAL) { _, dates, computedAt ->
            canonicalSleepSessionService.recompute(dates, computedAt)
        },
        DerivedRebuildModule(DerivedKind.ACTIVITY_SUMMARY_CANONICAL) { _, dates, computedAt ->
            canonicalActivitySummaryService.recompute(dates, computedAt)
        },
    )

class TransactionalDerivedRebuildExecutor(
    private val database: Database,
    private val registry: DerivedRebuildModuleRegistry,
) : DerivedRebuildExecutor {
    override suspend fun rebuild(request: DerivedRebuildRequest, computedAt: Instant) {
        registry.modules.forEach { module ->
            val dates = request[module.kind]
            if (dates.isNotEmpty()) {
                suspendTransaction(db = database) {
                    module.action.rebuild(request.sourceInstanceId, dates, computedAt)
                }
            }
        }
    }
}
