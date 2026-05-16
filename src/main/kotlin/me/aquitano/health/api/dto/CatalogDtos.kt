package me.aquitano.health.api.dto

import kotlinx.serialization.Serializable

@Serializable
data class MetricCatalogResponseDto(
    val families: List<MetricFamilyCatalogDto>,
)

@Serializable
data class MetricFamilyCatalogDto(
    val name: String,
    val readEndpoints: List<MetricReadEndpointDto>,
    val queryParameters: List<MetricQueryParameterDto>,
    val aggregationModes: List<MetricAggregationModeDto>,
    val metricTypes: List<String> = emptyList(),
    val responseDtos: List<String>,
    val providerDataTypes: List<MetricProviderDataTypesDto>,
    val schemaHint: String,
)

@Serializable
data class MetricReadEndpointDto(
    val mode: String,
    val method: String,
    val path: String? = null,
    val available: Boolean = true,
    val responseDto: String? = null,
)

@Serializable
data class MetricQueryParameterDto(
    val name: String,
    val type: String,
    val required: Boolean = false,
    val description: String,
    val values: List<String> = emptyList(),
)

@Serializable
data class MetricAggregationModeDto(
    val name: String,
    val available: Boolean,
    val endpoint: String? = null,
)

@Serializable
data class MetricProviderDataTypesDto(
    val providerCode: String,
    val dataTypes: List<String>,
)
