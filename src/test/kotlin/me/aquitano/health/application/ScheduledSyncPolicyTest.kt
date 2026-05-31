package me.aquitano.health.application

import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals

class ScheduledSyncPolicyTest {
    private val now = Instant.parse("2026-05-31T10:00:00Z")

    @Test
    fun successUsesConfiguredCadence() {
        assertEquals(
            Instant.parse("2026-06-01T10:00:00Z"),
            ScheduledSyncPolicy.nextRunAfterSuccess(now, 1_440),
        )
    }

    @Test
    fun failureBackoffIsExponentialAndBounded() {
        assertEquals(
            Instant.parse("2026-05-31T10:01:00Z"),
            ScheduledSyncPolicy.nextRunAfterFailure(now, 1),
        )
        assertEquals(
            Instant.parse("2026-05-31T10:08:00Z"),
            ScheduledSyncPolicy.nextRunAfterFailure(now, 4),
        )
        assertEquals(
            Instant.parse("2026-06-01T10:00:00Z"),
            ScheduledSyncPolicy.nextRunAfterFailure(now, 30),
        )
    }
}
