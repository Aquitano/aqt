package me.aquitano.health.application

import me.aquitano.health.api.dto.ProviderCatalogResponse
import me.aquitano.health.api.dto.ProviderDescriptorResponse
import me.aquitano.health.api.dto.ProviderWorkflowEndpointsResponse
import me.aquitano.health.domain.HealthProviderDescriptor
import me.aquitano.health.domain.NotFoundException
import me.aquitano.health.domain.ProviderAuthType
import me.aquitano.health.domain.ProviderWorkflowEndpoints

class ProviderDiscoveryService(
    private val providerRegistry: HealthProviderRegistry,
) {
    fun listProviders(): ProviderCatalogResponse =
        ProviderCatalogResponse(
            items = providerRegistry.listProviderDescriptors()
                .map { it.toDto() },
        )

    fun getProvider(providerCode: String): ProviderDescriptorResponse =
        providerRegistry.getProviderDescriptor(providerCode)
            ?.toDto()
            ?: throw NotFoundException("Provider '$providerCode' not found")

    private fun HealthProviderDescriptor.toDto(): ProviderDescriptorResponse =
        ProviderDescriptorResponse(
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

    private fun ProviderWorkflowEndpoints.toDto(): ProviderWorkflowEndpointsResponse =
        ProviderWorkflowEndpointsResponse(
            oauthStart = oauthStart,
            oauthCallback = oauthCallback,
            accounts = accounts,
            disconnect = disconnect,
            reconnect = reconnect,
            sync = sync,
        )
}
