package me.aquitano.health.application

import me.aquitano.health.domain.HealthProvider
import me.aquitano.health.domain.HealthProviderDescriptor
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

class HealthProviderRegistry(
    providers: List<HealthProvider>
) {
    private val providerMap = ConcurrentHashMap<String, HealthProvider>().apply {
        providers.forEach { provider ->
            put(normalize(provider.providerCode), provider)
            put(normalize(provider.descriptor.providerCode), provider)
            provider.descriptor.aliases.forEach { alias -> put(normalize(alias), provider) }
        }
    }
    private val sortedProviders = providers.sortedBy { it.descriptor.providerCode }

    fun getProvider(code: String): HealthProvider? = providerMap[normalize(code)]

    fun listProviders(): List<HealthProvider> = sortedProviders

    fun getProviderDescriptor(code: String): HealthProviderDescriptor? =
        getProvider(code)?.descriptor

    fun listProviderDescriptors(): List<HealthProviderDescriptor> =
        sortedProviders.map { it.descriptor }

    fun normalize(code: String): String =
        code.trim()
            .lowercase(Locale.US)
            .replace('-', '_')
}
