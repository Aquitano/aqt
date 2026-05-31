package me.aquitano.health.application

import kotlinx.coroutines.*
import me.aquitano.health.infrastructure.time.UtcClock
import net.logstash.logback.argument.StructuredArguments.kv
import org.slf4j.LoggerFactory
import java.time.Duration

private val schedulerLogger =
    LoggerFactory.getLogger(ScheduledProviderSyncScheduler::class.java)

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
                        schedulerLogger.info(
                            "scheduled_provider_sync_due_processed {}",
                            kv("count", processed),
                        )
                    }
                } catch (exception: CancellationException) {
                    throw exception
                } catch (exception: Exception) {
                    schedulerLogger.error("scheduled_provider_sync_tick_failed", exception)
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
