package me.aquitano.health.application.metric.common

import me.aquitano.health.domain.BodyMetricTypes
import me.aquitano.health.domain.CardiovascularMetricTypes
import me.aquitano.health.domain.HrvMetricTypes
import me.aquitano.health.domain.RequestValidationException
import me.aquitano.health.domain.ValidationIssue
import me.aquitano.health.domain.ValidationIssueCodes

internal fun validateBodyMetricType(metricType: String) {
    if (metricType !in BodyMetricTypes.supported) {
        throw RequestValidationException(
            listOf(
                ValidationIssue(
                    field = "metricType",
                    code = ValidationIssueCodes.UnsupportedValue,
                    message = "unsupported body metric type",
                )
            )
        )
    }
}

internal fun validateCardiovascularMetricType(metricType: String) {
    if (metricType !in CardiovascularMetricTypes.supported) {
        throw RequestValidationException(
            listOf(
                ValidationIssue(
                    field = "metricType",
                    code = ValidationIssueCodes.UnsupportedValue,
                    message = "unsupported cardiovascular metric type: $metricType",
                )
            )
        )
    }
}

internal fun validateHrvMetricType(metricType: String) {
    if (metricType !in HrvMetricTypes.supported) {
        throw RequestValidationException(
            listOf(
                ValidationIssue(
                    field = "metricType",
                    code = ValidationIssueCodes.UnsupportedValue,
                    message = "unsupported hrv metric type",
                )
            )
        )
    }
}

