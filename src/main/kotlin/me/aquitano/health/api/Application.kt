package me.aquitano.health.api

import io.ktor.server.application.*
import me.aquitano.external.google.GeneratedGoogleHealthClient
import me.aquitano.external.withings.KtorWithingsClient
import me.aquitano.health.application.*
import me.aquitano.health.application.metric.common.MetricsQueryService
import me.aquitano.health.di.queryServicesModule
import me.aquitano.health.di.repositoriesModule
import me.aquitano.health.di.servicesModule
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
            repositoriesModule(database, appConfig),
            servicesModule(database, appConfig),
            queryServicesModule(database),
        )
    }

    // Close the shared HTTP client on shutdown
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

    // Assemble the services bag for route handlers and wire routes
    val services = buildApplicationServices()
    configureHttp(corsConfig = appConfig.cors)
    configureMetrics(appConfig = appConfig, sharedHttpClient = httpClient)
    configureAuthentication(
        supportRepository = services.supportRepository,
        apiKeyHasher = services.apiKeyHasher,
        clock = services.clock,
    )
    configureRoutes(services = services)
}

/**
 * Pulls all resolved singletons from the Koin container and assembles the
 * [ApplicationServices] bag that route handlers use.  The bag deliberately
 * hides Koin from the route layer.
 */
private fun Application.buildApplicationServices(): ApplicationServices {
    val database by inject<org.jetbrains.exposed.v1.jdbc.Database>()
    val supportRepository by inject<SupportRepository>()
    val apiKeyHasher by inject<ApiKeyHasher>()
    val clock by inject<UtcClock>()
    val ingestionService by inject<IngestionService>()
    val metricsQueryService by inject<MetricsQueryService>()
    val sleepSummaryReadService by inject<SleepSummaryReadService>()
    val healthDayQueryService by inject<HealthDayQueryService>()
    val adminService by inject<AdminService>()
    val providerRegistry by inject<HealthProviderRegistry>()
    val providerDiscoveryService by inject<ProviderDiscoveryService>()
    val scalarMetricQueryService by inject<me.aquitano.health.application.metric.scalar.ScalarMetricQueryService>()
    val providerStatusService by inject<ProviderStatusService>()
    val providerWorkflowService by inject<ProviderWorkflowService>()
    val providerSyncJobService by inject<ProviderSyncJobService>()
    val scheduledProviderSyncService by inject<ScheduledProviderSyncService>()
    val trendQueryService by inject<TrendQueryService>()
    val replayService by inject<ReplayService>()

    return ApplicationServices(
        database = database,
        supportRepository = supportRepository,
        apiKeyHasher = apiKeyHasher,
        clock = clock,
        ingestionService = ingestionService,
        metricsQueryService = metricsQueryService,
        sleepSummaryReadService = sleepSummaryReadService,
        healthDayQueryService = healthDayQueryService,
        adminService = adminService,
        providerRegistry = providerRegistry,
        providerDiscoveryService = providerDiscoveryService,
        scalarMetricQueryService = scalarMetricQueryService,
        providerStatusService = providerStatusService,
        providerWorkflowService = providerWorkflowService,
        providerSyncJobService = providerSyncJobService,
        scheduledProviderSyncService = scheduledProviderSyncService,
        trendQueryService = trendQueryService,
        replayService = replayService,
    )
}

data class ApplicationServices(
    val database: org.jetbrains.exposed.v1.jdbc.Database,
    val supportRepository: SupportRepository,
    val apiKeyHasher: ApiKeyHasher,
    val clock: UtcClock,
    val ingestionService: IngestionService,
    val metricsQueryService: MetricsQueryService,
    val sleepSummaryReadService: SleepSummaryReadService,
    val healthDayQueryService: HealthDayQueryService,
    val adminService: AdminService,
    val providerRegistry: HealthProviderRegistry,
    val providerDiscoveryService: ProviderDiscoveryService,
    val scalarMetricQueryService: me.aquitano.health.application.metric.scalar.ScalarMetricQueryService,
    val providerStatusService: ProviderStatusService,
    val providerWorkflowService: ProviderWorkflowService,
    val providerSyncJobService: ProviderSyncJobService,
    val scheduledProviderSyncService: ScheduledProviderSyncService,
    val trendQueryService: TrendQueryService,
    val replayService: ReplayService,
)
