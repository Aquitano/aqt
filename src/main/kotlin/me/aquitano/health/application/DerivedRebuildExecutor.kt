package me.aquitano.health.application

import me.aquitano.health.application.metric.activity.derived.CanonicalActivitySummaryDerivationService
import me.aquitano.health.application.metric.body.derived.CanonicalBodyMeasurementDerivationService
import me.aquitano.health.application.metric.heart.derived.CanonicalHeartRateDerivationService
import me.aquitano.health.application.metric.hrv.derived.CanonicalHrvDerivationService
import me.aquitano.health.application.metric.respiratory.derived.CanonicalRespiratoryRateDerivationService
import me.aquitano.health.application.metric.sleep.derived.CanonicalSleepSessionDerivationService
import me.aquitano.health.application.metric.sleep.derived.CanonicalSleepSummaryDerivationService
import me.aquitano.health.application.metric.steps.derived.CanonicalStepDerivationService
import org.jetbrains.exposed.v1.jdbc.Database
import org.jetbrains.exposed.v1.jdbc.transactions.suspendTransaction
import java.time.Instant
import java.time.LocalDate

interface DerivedRebuildExecutor {
    suspend fun rebuild(request: DerivedRebuildRequest, computedAt: Instant)
}

data class DerivedRebuildRequest(
    val sourceInstanceId: Int,
    val stepSummaryDates: Set<LocalDate>,
    val sleepNightDates: Set<LocalDate>,
    val sleepSessionCanonicalDates: Set<LocalDate>,
    val heartRateCanonicalDates: Set<LocalDate>,
    val respiratoryRateCanonicalDates: Set<LocalDate>,
    val hrvCanonicalDates: Set<LocalDate>,
    val bodyMeasurementCanonicalDates: Set<LocalDate>,
    val sleepSummaryCanonicalDates: Set<LocalDate>,
    val activitySummaryCanonicalDates: Set<LocalDate>,
) {
    fun hasWork(): Boolean =
        stepSummaryDates.isNotEmpty() ||
            sleepNightDates.isNotEmpty() ||
            sleepSessionCanonicalDates.isNotEmpty() ||
            heartRateCanonicalDates.isNotEmpty() ||
            respiratoryRateCanonicalDates.isNotEmpty() ||
            hrvCanonicalDates.isNotEmpty() ||
            bodyMeasurementCanonicalDates.isNotEmpty() ||
            sleepSummaryCanonicalDates.isNotEmpty() ||
            activitySummaryCanonicalDates.isNotEmpty()
}

class TransactionalDerivedRebuildExecutor(
    private val database: Database,
    private val stepSummaryService: StepSummaryService,
    private val sleepNightService: SleepNightService,
    private val canonicalHeartRateService: CanonicalHeartRateDerivationService,
    private val canonicalRespiratoryRateService: CanonicalRespiratoryRateDerivationService,
    private val canonicalHrvService: CanonicalHrvDerivationService,
    private val canonicalStepService: CanonicalStepDerivationService,
    private val canonicalBodyMeasurementService: CanonicalBodyMeasurementDerivationService,
    private val canonicalSleepSummaryService: CanonicalSleepSummaryDerivationService,
    private val canonicalSleepSessionService: CanonicalSleepSessionDerivationService,
    private val canonicalActivitySummaryService: CanonicalActivitySummaryDerivationService,
) : DerivedRebuildExecutor {
    override suspend fun rebuild(request: DerivedRebuildRequest, computedAt: Instant) {
        if (!request.hasWork()) return

        if (request.stepSummaryDates.isNotEmpty()) {
            suspendTransaction(db = database) {
                stepSummaryService.recompute(
                    request.sourceInstanceId,
                    request.stepSummaryDates,
                    computedAt,
                )
                canonicalStepService.recompute(request.stepSummaryDates, computedAt)
            }
        }
        if (request.sleepNightDates.isNotEmpty()) {
            suspendTransaction(db = database) {
                sleepNightService.recomputeUtc(
                    request.sourceInstanceId,
                    request.sleepNightDates,
                    computedAt,
                )
            }
        }
        if (request.heartRateCanonicalDates.isNotEmpty()) {
            suspendTransaction(db = database) {
                canonicalHeartRateService.recompute(
                    request.heartRateCanonicalDates,
                    computedAt,
                )
            }
        }
        if (request.respiratoryRateCanonicalDates.isNotEmpty()) {
            suspendTransaction(db = database) {
                canonicalRespiratoryRateService.recompute(
                    request.respiratoryRateCanonicalDates,
                    computedAt,
                )
            }
        }
        if (request.hrvCanonicalDates.isNotEmpty()) {
            suspendTransaction(db = database) {
                canonicalHrvService.recompute(request.hrvCanonicalDates, computedAt)
            }
        }
        if (request.bodyMeasurementCanonicalDates.isNotEmpty()) {
            suspendTransaction(db = database) {
                canonicalBodyMeasurementService.recompute(
                    request.bodyMeasurementCanonicalDates,
                    computedAt,
                )
            }
        }
        if (request.sleepSummaryCanonicalDates.isNotEmpty()) {
            suspendTransaction(db = database) {
                canonicalSleepSummaryService.recompute(
                    request.sleepSummaryCanonicalDates,
                    computedAt,
                )
            }
        }
        if (request.sleepSessionCanonicalDates.isNotEmpty()) {
            suspendTransaction(db = database) {
                canonicalSleepSessionService.recompute(
                    request.sleepSessionCanonicalDates,
                    computedAt,
                )
            }
        }
        if (request.activitySummaryCanonicalDates.isNotEmpty()) {
            suspendTransaction(db = database) {
                canonicalActivitySummaryService.recompute(
                    request.activitySummaryCanonicalDates,
                    computedAt,
                )
            }
        }
    }
}
