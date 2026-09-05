package me.aquitano.health.application

import me.aquitano.health.application.metric.steps.derived.CanonicalStepDerivationService
import me.aquitano.health.domain.DerivedKind
import me.aquitano.health.domain.RecordTypes
import me.aquitano.health.shared.utcDate
import org.jetbrains.exposed.v1.jdbc.Database
import me.aquitano.health.infrastructure.database.suspendDbTransaction
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

/** Maps one raw record's time span to the dates whose derived data it invalidates. */
fun interface AffectedDatesResolver {
    fun affectedDates(recordType: String, startAt: Instant, endAt: Instant?): Set<LocalDate>
}

class DerivedRebuildModule(
    val kind: DerivedKind,
    val affectedDates: AffectedDatesResolver,
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

    /**
     * The single record-to-rebuild-dates mapping shared by the ingestion write path and replay,
     * so a new derived kind cannot be wired into one and silently skipped by the other.
     */
    fun affectedDatesFor(recordType: String, startAt: Instant, endAt: Instant?): Map<DerivedKind, Set<LocalDate>> =
        modules.mapNotNull { module ->
            module.affectedDates.affectedDates(recordType, startAt, endAt)
                .takeIf { it.isNotEmpty() }
                ?.let { module.kind to it }
        }.toMap()
}

/** The canonical post-ingestion rebuild wiring; order is the execution order. */
fun derivedRebuildModules(
    stepSummaryService: StepSummaryService,
    canonicalStepService: CanonicalStepDerivationService,
    sleepNightService: SleepNightService,
): List<DerivedRebuildModule> =
    listOf(
        DerivedRebuildModule(
            kind = DerivedKind.STEP_SUMMARY,
            affectedDates = { recordType, startAt, endAt ->
                if (recordType == RecordTypes.STEP_INTERVAL) {
                    // Replay rows may carry a null end; treat them as an instant-wide interval.
                    affectedUtcDates(startAt, endAt ?: startAt.plusNanos(1))
                } else {
                    emptySet()
                }
            },
            action = { sourceInstanceId, dates, computedAt ->
                stepSummaryService.recompute(sourceInstanceId, dates, computedAt)
                canonicalStepService.recompute(dates, computedAt)
            },
        ),
        DerivedRebuildModule(
            kind = DerivedKind.SLEEP_NIGHT,
            affectedDates = { recordType, startAt, endAt ->
                if (recordType == RecordTypes.SLEEP_SESSION) {
                    setOf((endAt ?: startAt).utcDate())
                } else {
                    emptySet()
                }
            },
            action = { sourceInstanceId, dates, computedAt ->
                sleepNightService.recomputeUtc(sourceInstanceId, dates, computedAt)
            },
        ),
    )

internal fun affectedUtcDates(
    start: Instant,
    exclusiveEnd: Instant,
): Set<LocalDate> {
    val lastIncludedDate = exclusiveEnd.minusNanos(1).utcDate()
    val dates = linkedSetOf<LocalDate>()
    var cursor = start.utcDate()
    while (!cursor.isAfter(lastIncludedDate)) {
        dates.add(cursor)
        cursor = cursor.plusDays(1)
    }
    return dates
}

class TransactionalDerivedRebuildExecutor(
    private val database: Database,
    private val registry: DerivedRebuildModuleRegistry,
) : DerivedRebuildExecutor {
    override suspend fun rebuild(request: DerivedRebuildRequest, computedAt: Instant) {
        registry.modules.forEach { module ->
            val dates = request[module.kind]
            if (dates.isNotEmpty()) {
                suspendDbTransaction(db = database) {
                    module.action.rebuild(request.sourceInstanceId, dates, computedAt)
                }
            }
        }
    }
}
