package me.aquitano.health.application

import me.aquitano.health.api.dto.ProviderCatalogResponseDto
import me.aquitano.health.api.dto.ProviderDescriptorResponseDto
import me.aquitano.health.api.dto.ProviderWorkflowEndpointsResponseDto
import me.aquitano.health.domain.HealthProviderDescriptor
import me.aquitano.health.domain.NotFoundException
import me.aquitano.health.domain.ProviderAuthType
import me.aquitano.health.domain.ProviderWorkflowEndpoints

class ProviderDiscoveryService(
    private val providerRegistry: HealthProviderRegistry,
) {
    fun listProviders(): ProviderCatalogResponseDto =
        ProviderCatalogResponseDto(
            providers = providerRegistry.listProviderDescriptors().map { it.toDto() },
        )

    fun getProvider(providerCode: String): ProviderDescriptorResponseDto =
        providerRegistry.getProviderDescriptor(providerCode)
            ?.toDto()
            ?: throw NotFoundException("Provider '$providerCode' not found")

    private fun HealthProviderDescriptor.toDto(): ProviderDescriptorResponseDto =
        ProviderDescriptorResponseDto(
            providerCode = providerCode,
            displayName = displayName,
            authType = authType.toDto(),
            requiresAuthentication = requiresAuthentication,
            supportedDataTypes = supportedDataTypes,
            defaultDataTypes = defaultDataTypes,
            maxSyncRangeDays = maxSyncRangeDays,
            supportsPageSize = supportsPageSize,
            workflowEndpoints = workflowEndpoints.toDto(),
            aliases = aliases,
        )

    private fun ProviderAuthType.toDto(): String =
        name.lowercase()

    private fun ProviderWorkflowEndpoints.toDto(): ProviderWorkflowEndpointsResponseDto =
        ProviderWorkflowEndpointsResponseDto(
            oauthStart = oauthStart,
            oauthCallback = oauthCallback,
            sync = sync,
        )
}
