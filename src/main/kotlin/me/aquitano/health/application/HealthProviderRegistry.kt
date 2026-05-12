package me.aquitano.health.application

import me.aquitano.health.domain.HealthProvider
import java.util.concurrent.ConcurrentHashMap

class HealthProviderRegistry(
    providers: List<HealthProvider>
) {
    private val providerMap = ConcurrentHashMap<String, HealthProvider>().apply {
        providers.forEach { put(it.providerCode, it) }
    }

    fun getProvider(code: String): HealthProvider? = providerMap[code]

    fun listProviders(): List<HealthProvider> = providerMap.values.toList()
}
