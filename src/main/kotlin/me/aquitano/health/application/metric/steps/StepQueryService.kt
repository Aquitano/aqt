package me.aquitano.health.application.metric.steps

import me.aquitano.health.api.dto.StepDailySummariesResponse
import me.aquitano.health.api.dto.StepDailySummaryResponse
import me.aquitano.health.api.dto.StepSampleResponse
import me.aquitano.health.api.dto.StepSamplesResponse
import me.aquitano.health.application.CanonicalMetricsService
import me.aquitano.health.application.metric.common.BaseReadService
import me.aquitano.health.application.metric.common.QueryParams
import me.aquitano.health.application.metric.common.SortFields
import me.aquitano.health.application.metric.common.dailyReadFilters
import me.aquitano.health.application.metric.common.meta
import me.aquitano.health.application.metric.common.readFilters
import me.aquitano.health.application.metric.common.sourceInstanceIds
import me.aquitano.health.application.metric.common.toResponse
import me.aquitano.health.application.metric.steps.derived.CANONICAL_STEP_ALGORITHM_VERSION
import me.aquitano.health.application.metric.steps.repository.CanonicalStepDerivationRepository
import me.aquitano.health.application.metric.steps.repository.StepRepository
import me.aquitano.health.application.metric.steps.repository.StepDailySummaryRow
import org.jetbrains.exposed.v1.jdbc.Database
import java.time.Instant

class StepQueryService(
    database: Database,
    private val stepRepository: StepRepository,
    private val canonicalRepository: CanonicalStepDerivationRepository,
    private val canonicalMetricsService: CanonicalMetricsService,
) : BaseReadService(database) {
    suspend fun listStepSamples(params: QueryParams): StepSamplesResponse =
        dbQuery {
            val filters = params.readFilters(
                defaultSort = SortFields.START_AT,
                allowedSorts = setOf(SortFields.START_AT),
                latestSupported = true,
            )
            val (rows, sourceMetadata) =
                canonicalRepository.listCanonicalStepSamples(filters, CANONICAL_STEP_ALGORITHM_VERSION)
            StepSamplesResponse(
                items = rows.map {
                    StepSampleResponse(
                        id = it.id,
                        startAt = it.startAt,
                        endAt = it.endAt,
                        steps = it.steps,
                        source = sourceMetadata[it.sourceInstanceId].toResponse(),
                    )
                },
                meta = rows.meta(filters),
            )
        }

    suspend fun listStepDailySummaries(
        params: QueryParams,
        now: Instant,
    ): StepDailySummariesResponse =
        dbQuery {
            params.rejectLatest()
            val filters = params.dailyReadFilters(now)
            val (rawRows, sourceMetadata) = stepRepository.listStepDailySummaries(filters)
            val rows = canonicalMetricsService.canonicalStepDailySummaries(
                rawRows,
                stepRepository.sourceMetadataFor(rawRows.sourceInstanceIds { it.sourceInstanceId }),
            )
            StepDailySummariesResponse(
                items = rows.map {
                    StepDailySummaryResponse(
                        date = it.date,
                        steps = it.steps,
                        sampleCount = it.sampleCount,
                        source = sourceMetadata[it.sourceInstanceId].toResponse(),
                    )
                },
                meta = rows.meta(filters),
            )
        }
}

