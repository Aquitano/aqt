package me.aquitano.health.test

import me.aquitano.health.application.metric.activity.repository.ActivitySummaryWriteRepository
import me.aquitano.health.application.metric.cardiovascular.repository.CardiovascularWriteRepository
import me.aquitano.health.application.metric.common.MetricWriteService
import me.aquitano.health.application.metric.scalar.ScalarSampleWriteRepository
import me.aquitano.health.application.metric.sleep.repository.SleepWriteRepository
import me.aquitano.health.application.metric.steps.repository.StepWriteRepository

/** The production write wiring with default-constructed repositories, for ingestion tests. */
fun metricWriteService(): MetricWriteService =
    MetricWriteService(
        stepWriteRepository = StepWriteRepository(),
        sleepWriteRepository = SleepWriteRepository(),
        activitySummaryWriteRepository = ActivitySummaryWriteRepository(),
        cardiovascularWriteRepository = CardiovascularWriteRepository(),
        scalarSampleWriteRepository = ScalarSampleWriteRepository(),
    )
