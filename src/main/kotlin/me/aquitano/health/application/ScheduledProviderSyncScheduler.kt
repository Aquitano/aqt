package me.aquitano.health.application

import kotlinx.coroutines.*
import me.aquitano.health.infrastructure.time.UtcClock
import io.github.oshai.kotlinlogging.KotlinLogging
import me.aquitano.health.infrastructure.logging.*
import java.time.Duration

private val schedulerLogger = KotlinLogging.logger {}

class ScheduledProviderSyncScheduler(
    private val service: ScheduledProviderSyncService,
    private val clock: UtcClock,
    private val pollInterval: Duration = Duration.ofMinutes(1),
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var job: Job? = null

    fun start() {
        if (job != null) return
        job = scope.launch {
            while (isActive) {
                try {
                    val processed = service.runDue(clock.now())
                    if (processed > 0) {
                        schedulerLogger.infoWithContext(
                            "scheduled_provider_sync_due_processed",
                            "count" to processed,
                        )
                    }
                } catch (exception: CancellationException) {
                    throw exception
                } catch (exception: Exception) {
                    schedulerLogger.error(exception) { "scheduled_provider_sync_tick_failed" }
                }
                delay(pollInterval.toMillis())
            }
        }
    }

    fun stop() {
        job?.cancel()
        job = null
        scope.cancel()
    }
}
