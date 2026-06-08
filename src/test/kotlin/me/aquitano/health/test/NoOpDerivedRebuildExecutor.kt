package me.aquitano.health.test

import me.aquitano.health.application.DerivedRebuildExecutor
import me.aquitano.health.application.DerivedRebuildRequest
import java.time.Instant

object NoOpDerivedRebuildExecutor : DerivedRebuildExecutor {
    override suspend fun rebuild(request: DerivedRebuildRequest, computedAt: Instant) = Unit
}
