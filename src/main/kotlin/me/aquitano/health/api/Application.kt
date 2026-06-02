package me.aquitano.health.api

import io.ktor.client.*
import io.ktor.client.engine.cio.*
import io.ktor.client.plugins.*
import io.ktor.client.plugins.contentnegotiation.*
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.application.*
import me.aquitano.external.google.*
import me.aquitano.external.withings.KtorWithingsClient
import me.aquitano.external.withings.WithingsNormalizer
import me.aquitano.external.withings.WithingsProvider
import me.aquitano.health.application.*
import me.aquitano.health.application.metric.common.MetricWriteService
import me.aquitano.health.application.metric.sleep.repository.SleepNightDerivationRepository
import me.aquitano.health.application.metric.sleep.repository.SleepRepository
import me.aquitano.health.application.metric.steps.repository.StepDailySummaryDerivationRepository
import me.aquitano.health.infrastructure.config.toAppConfig
import me.aquitano.health.infrastructure.database.DatabaseFactory
import me.aquitano.health.infrastructure.repositories.*
import me.aquitano.health.infrastructure.security.ApiKeyHasher
import me.aquitano.health.infrastructure.time.UtcClock
import me.aquitano.health.shared.AppJson
import net.logstash.logback.argument.StructuredArguments.kv
import org.jetbrains.exposed.v1.jdbc.Database
import org.slf4j.LoggerFactory

private val logger =
    LoggerFactory.getLogger("me.aquitano.health.api.Application")

fun main(args: Array<String>) {
    io.ktor.server.netty.EngineMain.main(args)
}

fun Application.module() {
    val clock = UtcClock()
    val appConfig = environment.config.toAppConfig()
    logger.info(
        "app_starting {}",
        kv("databaseDriver", appConfig.database.driver),
    )
    val databaseFactory = DatabaseFactory()
    val database = databaseFactory.initialize(appConfig.database)
    val apiKeyHasher = ApiKeyHasher()
    val supportRepository = SupportRepository(database)
    val ingestionRepository = IngestionRepository()
    val providerOAuthRepository = ProviderOAuthRepository(database)
    val scheduledSyncRepository = ScheduledSyncRepository(database)
    val httpClient = HttpClient(CIO) {
        install(ContentNegotiation) {
            json(AppJson)
        }
        install(HttpTimeout) {
            connectTimeoutMillis = 10_000
            socketTimeoutMillis = 60_000
            requestTimeoutMillis = 120_000
        }
    }
    monitor.subscribe(ApplicationStopping) {
        httpClient.close()
        databaseFactory.close()
    }
    val googleHealthOAuthClient =
        KtorGoogleHealthOAuthClient(httpClient, appConfig.googleHealth)
    val googleHealthClient = GeneratedGoogleHealthClient(
        oauthClient = googleHealthOAuthClient,
        dataPointsServiceFactory = GoogleHealthDataPointsServiceFactory(
            appConfig.googleHealth.apiBaseUrl
        ),
    )
    val withingsClient = KtorWithingsClient(httpClient, appConfig.withings)
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
    val metricsReadRepository = MetricsReadRepository()
    val sleepRepository = SleepRepository()
    val sleepNightDerivationRepository = SleepNightDerivationRepository()
    val canonicalMetricsService =
        CanonicalMetricsService(CanonicalMetricsPolicy.default())
    val healthDayModuleRegistry = HealthDayModuleRegistry(
        listOf(
            StepsDayModule(metricsReadRepository, canonicalMetricsService),
            HeartRateDayModule(metricsReadRepository, canonicalMetricsService),
            WeightDayModule(metricsReadRepository, canonicalMetricsService),
            SleepDayModule(metricsReadRepository, canonicalMetricsService),
        )
    )
    val ingestionService = IngestionService(
        database = database,
        mappingService = IngestionMappingService(),
        supportRepository = supportRepository,
        ingestionRepository = ingestionRepository,
        metricWriteService = MetricWriteService(),
        stepSummaryService = StepSummaryService(
            StepDailySummaryDerivationRepository()
        ),
        sleepNightService = SleepNightService(sleepNightDerivationRepository),
    )
    val googleHealthProvider = GoogleHealthProvider(
        config = appConfig.googleHealth,
        repository = providerOAuthRepository,
        client = googleHealthClient,
        normalizer = GoogleHealthNormalizer(),
        ingestionService = ingestionService,
    )
    val withingsProvider = WithingsProvider(
        config = appConfig.withings,
        repository = providerOAuthRepository,
        client = withingsClient,
        normalizer = WithingsNormalizer(),
        ingestionService = ingestionService,
    )
    val providerRegistry =
        HealthProviderRegistry(listOf(googleHealthProvider, withingsProvider))
    val providerStatusService = ProviderStatusService(
        providerRegistry = providerRegistry,
        providerOAuthRepository = providerOAuthRepository,
    )
    val scheduledProviderSyncService = ScheduledProviderSyncService(
        providerRegistry = providerRegistry,
        providerOAuthRepository = providerOAuthRepository,
        repository = scheduledSyncRepository,
    )
    val scheduledProviderSyncScheduler = ScheduledProviderSyncScheduler(
        service = scheduledProviderSyncService,
        clock = clock,
    )
    scheduledProviderSyncScheduler.start()

    val services = ApplicationServices(
        database = database,
        supportRepository = supportRepository,
        apiKeyHasher = apiKeyHasher,
        clock = clock,
        ingestionService = ingestionService,
        metricsQueryService = MetricsQueryService(
            database = database,
            metricsReadRepository = metricsReadRepository,
            canonicalMetricsService = canonicalMetricsService,
            sleepNightService = SleepNightService(sleepNightDerivationRepository),
        ),
        sleepSummaryReadService = SleepSummaryReadService(
            database = database,
            sleepRepository = sleepRepository,
            canonicalMetricsService = canonicalMetricsService,
        ),
        healthDayQueryService = HealthDayQueryService(
            database = database,
            registry = healthDayModuleRegistry,
        ),
        adminService = AdminService(
            database = database,
            ingestionRepository = ingestionRepository,
        ),
        providerRegistry = providerRegistry,
        providerDiscoveryService = ProviderDiscoveryService(
            providerRegistry = providerRegistry,
        ),
        metricCatalogService = MetricCatalogService(
            providerRegistry = providerRegistry,
        ),
        providerStatusService = providerStatusService,
        providerWorkflowService = ProviderWorkflowService(
            providerRegistry = providerRegistry,
            providerOAuthRepository = providerOAuthRepository,
            providerStatusService = providerStatusService,
        ),
        scheduledProviderSyncService = scheduledProviderSyncService,
        trendQueryService = TrendQueryService(
            database = database,
            metricsReadRepository = metricsReadRepository,
        ),
    )

    ApiClientBootstrapService(
        authConfig = appConfig.auth,
        supportRepository = supportRepository,
        apiKeyHasher = apiKeyHasher,
        clock = clock,
    ).bootstrap()

    configureHttp(corsConfig = appConfig.cors)
    configureRoutes(services = services)

    monitor.subscribe(ApplicationStopping) {
        scheduledProviderSyncScheduler.stop()
    }
}

data class ApplicationServices(
    val database: Database,
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
