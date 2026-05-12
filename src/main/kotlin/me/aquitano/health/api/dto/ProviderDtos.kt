package me.aquitano.health.api.dto

import kotlinx.serialization.Serializable

@Serializable
data class ProviderOAuthStartResponse(
    val provider: String,
    val authorizationUrl: String,
    val expiresAt: String,
)

@Serializable
data class ProviderOAuthCallbackResponse(
    val provider: String,
    val providerInstanceId: String,
    val connected: Boolean,
)

@Serializable
data class ProviderSyncRequestDto(
    val providerInstanceId: String? = null,
    val from: String? = null,
    val to: String? = null,
    val dataTypes: List<String>? = null,
    val pageSize: Int? = null,
)
