package me.aquitano.health.application

enum class CanonicalMetricFamily {
    STEPS,
    ACTIVITY,
    SLEEP,
    SLEEP_SUMMARY,
    BODY_MEASUREMENT,
    HEART_RATE,
    RESPIRATORY_RATE,
    HRV,
}

data class CanonicalSourceRank(
    val provider: String,
    val rank: Int,
)

class CanonicalMetricsPolicy(
    private val ranksByFamily: Map<CanonicalMetricFamily, List<CanonicalSourceRank>>,
) {
    fun rank(family: CanonicalMetricFamily, provider: String?): Int {
        val normalized = normalizeProvider(provider) ?: return UnknownProviderRank
        return ranksByFamily[family]
            ?.firstOrNull { it.provider == normalized }
            ?.rank
            ?: UnknownProviderRank
    }

    fun heartRateRank(provider: String?, context: String?): Int {
        val family = if (context == "sleep") {
            CanonicalMetricFamily.SLEEP
        } else {
            CanonicalMetricFamily.HEART_RATE
        }
        return rank(family, provider)
    }

    private fun normalizeProvider(provider: String?): String? =
        provider
            ?.trim()
            ?.lowercase()
            ?.replace('-', '_')
            ?.takeIf { it.isNotBlank() }

    companion object {
        private const val UnknownProviderRank = 10_000

        fun default(): CanonicalMetricsPolicy =
            CanonicalMetricsPolicy(
                ranksByFamily = mapOf(
                    CanonicalMetricFamily.STEPS to ranks(
                        "google_health",
                        "health_connect",
                        "withings",
                    ),
                    CanonicalMetricFamily.ACTIVITY to ranks(
                        "google_health",
                        "health_connect",
                        "withings",
                    ),
                    CanonicalMetricFamily.SLEEP to ranks(
                        "withings",
                        "google_health",
                        "health_connect",
                    ),
                    CanonicalMetricFamily.SLEEP_SUMMARY to ranks(
                        "withings",
                        "google_health",
                        "health_connect",
                    ),
                    CanonicalMetricFamily.BODY_MEASUREMENT to ranks(
                        "withings",
                        "google_health",
                        "health_connect",
                    ),
                    CanonicalMetricFamily.HEART_RATE to ranks(
                        "google_health",
                        "health_connect",
                        "withings",
                    ),
                    CanonicalMetricFamily.RESPIRATORY_RATE to ranks(
                        "withings",
                        "google_health",
                        "health_connect",
                    ),
                    CanonicalMetricFamily.HRV to ranks(
                        "withings",
                        "google_health",
                        "health_connect",
                    ),
                )
            )

        private fun ranks(vararg providers: String): List<CanonicalSourceRank> =
            providers.mapIndexed { index, provider ->
                CanonicalSourceRank(provider, index)
            }
    }
}
