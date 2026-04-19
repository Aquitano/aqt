package me.aquitano.health.infrastructure.time

import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset

class UtcClock(
    private val clock: Clock = Clock.systemUTC(),
) {
    fun now(): Instant = Instant.now(clock)

    companion object {
        fun fixed(instant: Instant): UtcClock =
            UtcClock(Clock.fixed(instant, ZoneOffset.UTC))
    }
}
