package me.aquitano.health.application.metric.common

/**
 * Single source of truth for query-parameter contracts. Both the runtime parsers
 * ([QueryParams], QueryFilters) and the OpenAPI parameter builders consume these
 * specs, so documented defaults, limits, and enums cannot drift from validation.
 */
internal data class BooleanParamSpec(
    val name: String,
    val default: Boolean,
)

internal data class LimitParamSpec(
    val name: String,
    val default: Int,
    val min: Int,
    val max: Int,
)

internal data class EnumParamSpec(
    val name: String,
    val values: List<String>,
    val default: String,
) {
    init {
        require(default in values) { "default '$default' must be one of $values" }
    }

    val allowed: Set<String> = values.toSet()
}

internal object QueryParamSpecs {
    val includeSource = BooleanParamSpec("includeSource", default = false)
    val latest = BooleanParamSpec("latest", default = false)
    val raw = BooleanParamSpec("raw", default = false)

    val readLimit = LimitParamSpec("limit", default = 500, min = 1, max = 5000)
    val adminLimit = LimitParamSpec("limit", default = 100, min = 1, max = 1000)

    val order = EnumParamSpec("order", listOf(Orders.ASC, Orders.DESC), Orders.ASC)

    val sortByMeasuredAt = sortSpec(SortFields.MEASURED_AT)
    val sortByStartAt = sortSpec(SortFields.START_AT)
    val sortByEndAt = sortSpec(SortFields.END_AT)
    val sortByDate = sortSpec(SortFields.DATE)

    private fun sortSpec(field: String) = EnumParamSpec("sort", listOf(field), field)
}
