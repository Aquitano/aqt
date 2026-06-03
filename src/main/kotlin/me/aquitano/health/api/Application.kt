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
import net.logstash.logback.argument.StructuredArguments.kv
import org.koin.ktor.ext.inject
import org.koin.ktor.plugin.Koin
import org.koin.logger.slf4jLogger
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("me.aquitano.health.api.Application")

fun main(args: Array<String>) {
    io.ktor.server.netty.EngineMain.main(args)
}

fun Application.module() {
    val appConfig = environment.config.toAppConfig()
    logger.info("app_starting {}", kv("databaseDriver", appConfig.database.driver))

    val databaseFactory = DatabaseFactory()
    val database = databaseFactory.initialize(appConfig.database)

    monitor.subscribe(ApplicationStopping) {
        databaseFactory.close()
    }

    logger.info(
        "app_configured {} {}",
        kv(
            "googleHealthConfigured",
            appConfig.googleHealth.clientId.isNotBlank() &&
                    appConfig.googleHealth.clientSecret.isNotBlank() &&
                    appConfig.googleHealth.tokenEncryptionKey.isNotBlank(),
        ),
        kv(
            "withingsConfigured",
            appConfig.withings.clientId.isNotBlank() &&
                    appConfig.withings.clientSecret.isNotBlank() &&
                    appConfig.withings.tokenEncryptionKey.isNotBlank(),
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
    monitor.subscribe(ApplicationStopping) {
        httpClient.close()
    }

    // Start the scheduled sync background job
    val scheduler by inject<ScheduledProviderSyncScheduler>()
    scheduler.start()
    monitor.subscribe(ApplicationStopping) {
        scheduler.stop()
    }

    // Bootstrap the API client (creates a default API key if none exists)
    val bootstrapService by inject<ApiClientBootstrapService>()
    bootstrapService.bootstrap()

    // Assemble the services bag for route handlers and wire routes
    val services = buildApplicationServices()
    configureHttp(corsConfig = appConfig.cors)
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
    val metricCatalogService by inject<MetricCatalogService>()
    val providerStatusService by inject<ProviderStatusService>()
    val providerWorkflowService by inject<ProviderWorkflowService>()
    val scheduledProviderSyncService by inject<ScheduledProviderSyncService>()
    val trendQueryService by inject<TrendQueryService>()

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
        metricCatalogService = metricCatalogService,
        providerStatusService = providerStatusService,
        providerWorkflowService = providerWorkflowService,
        scheduledProviderSyncService = scheduledProviderSyncService,
        trendQueryService = trendQueryService,
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
    val metricCatalogService: MetricCatalogService,
    val providerStatusService: ProviderStatusService,
    val providerWorkflowService: ProviderWorkflowService,
    val scheduledProviderSyncService: ScheduledProviderSyncService,
    val trendQueryService: TrendQueryService,
)
