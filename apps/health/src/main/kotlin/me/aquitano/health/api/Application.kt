package me.aquitano.health.api

import io.ktor.server.application.*
import me.aquitano.health.application.*
import me.aquitano.health.di.adminReplayModule
import me.aquitano.health.di.coreModule
import me.aquitano.health.di.ingestionModule
import me.aquitano.health.di.metricsReadModule
import me.aquitano.health.di.providersModule
import me.aquitano.health.infrastructure.config.toAppConfig
import me.aquitano.health.infrastructure.database.DatabaseFactory
import me.aquitano.health.infrastructure.repositories.SupportRepository
import me.aquitano.health.infrastructure.security.ApiKeyHasher
import me.aquitano.health.infrastructure.time.UtcClock
import org.koin.ktor.ext.inject
import org.koin.ktor.plugin.Koin
import org.koin.logger.slf4jLogger
import io.github.oshai.kotlinlogging.KotlinLogging
import me.aquitano.health.infrastructure.logging.*

private val logger = KotlinLogging.logger("me.aquitano.health.api.Application")

fun main(args: Array<String>) {
    io.ktor.server.netty.EngineMain.main(args)
}

fun Application.module() {
    val appConfig = environment.config.toAppConfig()
    logger.infoWithContext("app_starting", "databaseDriver" to appConfig.database.driver)

    val databaseFactory = DatabaseFactory()
    val database = databaseFactory.initialize(appConfig.database)

    monitor.subscribe(ApplicationStopped) {
        databaseFactory.close()
    }

    logger.infoWithContext(
        "app_configured",
        "googleHealthConfigured" to (
            appConfig.googleHealth.clientId.isNotBlank() &&
            appConfig.googleHealth.clientSecret.isNotBlank() &&
            appConfig.googleHealth.tokenEncryptionKey.isNotBlank()
        ),
        "withingsConfigured" to (
            appConfig.withings.clientId.isNotBlank() &&
            appConfig.withings.clientSecret.isNotBlank() &&
            appConfig.withings.tokenEncryptionKey.isNotBlank()
        ),
    )

    install(Koin) {
        slf4jLogger()
        modules(
            coreModule(database, appConfig),
            ingestionModule(),
            metricsReadModule(),
            providersModule(appConfig),
            adminReplayModule(),
        )
    }

    val httpClient by inject<io.ktor.client.HttpClient>()
    val clock by inject<UtcClock>()
    monitor.subscribe(ApplicationStopping) {
        httpClient.close()
    }

    // Start the scheduled sync background job
    val scheduler by inject<ScheduledProviderSyncScheduler>()
    scheduler.start()
    monitor.subscribe(ApplicationStopping) {
        scheduler.stop()
    }

    // Retry derived rebuilds that failed after their ingestion batch committed
    val pendingDerivedRebuildSweeper by inject<PendingDerivedRebuildSweeper>()
    pendingDerivedRebuildSweeper.start()
    monitor.subscribe(ApplicationStopping) {
        pendingDerivedRebuildSweeper.stop()
    }

    val providerSyncJobService by inject<ProviderSyncJobService>()
    providerSyncJobService.start(clock.now())
    monitor.subscribe(ApplicationStopping) {
        providerSyncJobService.stop()
    }

    val replayService by inject<ReplayService>()
    replayService.start(clock.now())
    monitor.subscribe(ApplicationStopping) {
        replayService.stop()
    }

    // Re-upsert metric_catalog and provider_ranks from the Kotlin registry
    val metricCatalogBootstrap by inject<MetricCatalogBootstrap>()
    metricCatalogBootstrap.run()

    // Bootstrap the API client (creates a default API key if none exists)
    val bootstrapService by inject<ApiClientBootstrapService>()
    bootstrapService.bootstrap()

    val supportRepository by inject<SupportRepository>()
    val apiKeyHasher by inject<ApiKeyHasher>()

    configureHttp(corsConfig = appConfig.cors)
    configureMetrics(appConfig = appConfig, sharedHttpClient = httpClient)
    configureAuthentication(
        supportRepository = supportRepository,
        apiKeyHasher = apiKeyHasher,
        clock = clock,
    )
    configureRoutes()
}
