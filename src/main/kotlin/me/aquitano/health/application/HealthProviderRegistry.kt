package me.aquitano.health.application

import me.aquitano.health.domain.HealthProvider
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

class HealthProviderRegistry(
    providers: List<HealthProvider>
) {
    private val providerMap = ConcurrentHashMap<String, HealthProvider>().apply {
        providers.forEach { put(normalize(it.providerCode), it) }
    }

    fun getProvider(code: String): HealthProvider? = providerMap[normalize(code)]

    fun listProviders(): List<HealthProvider> = providerMap.values.toList()

    fun normalize(code: String): String =
        code.trim()
            .lowercase(Locale.US)
            .replace('-', '_')
}
