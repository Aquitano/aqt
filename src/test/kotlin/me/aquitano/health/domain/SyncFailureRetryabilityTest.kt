package me.aquitano.health.domain

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class SyncFailureRetryabilityTest {
    @Test
    fun permanentFailuresAreNotRetryableRegardlessOfMessageWording() {
        // None of these messages contain the old magic substrings ("validation",
        // "not configured", "not connected", "needs reconnect").
        assertFalse(isRetryableSyncFailure(RequestValidationException(emptyList())))
        assertFalse(isRetryableSyncFailure(NotFoundException("no such account")))
        assertFalse(isRetryableSyncFailure(UnauthorizedException()))
        assertFalse(isRetryableSyncFailure(ConflictException("withings_needs_reauth", "token expired, reauthorize")))
        assertFalse(
            isRetryableSyncFailure(
                ServerConfigurationException("google_health_not_configured", "Provider is misconfigured")
            )
        )
    }

    @Test
    fun transientFailuresStayRetryableEvenWithSuspiciousWording() {
        assertTrue(isRetryableSyncFailure(RuntimeException("upstream schema validation hiccup, try again")))
        assertTrue(isRetryableSyncFailure(UpstreamProviderException("withings_http_503", "service unavailable")))
    }

    @Test
    fun upstreamProviderExceptionCarriesItsOwnRetryability() {
        assertFalse(
            isRetryableSyncFailure(
                UpstreamProviderException("withings_needs_reauth", "reauthorize", 502, retryable = false)
            )
        )
    }
}
