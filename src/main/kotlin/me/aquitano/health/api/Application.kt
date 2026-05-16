package me.aquitano.health.api

import io.ktor.client.*
import io.ktor.client.engine.cio.*
import io.ktor.client.plugins.contentnegotiation.*
import io.ktor.client.plugins.HttpTimeout
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.application.*
import me.aquitano.health.application.*
import me.aquitano.health.infrastructure.config.toAppConfig
import me.aquitano.health.infrastructure.database.DatabaseFactory
import me.aquitano.health.infrastructure.repositories.MetricsWriteRepository
import me.aquitano.health.infrastructure.repositories.IngestionRepository
import me.aquitano.health.infrastructure.repositories.MetricsReadRepository
import me.aquitano.health.infrastructure.repositories.ProviderOAuthRepository
import me.aquitano.health.infrastructure.repositories.SupportRepository
import me.aquitano.external.google.GoogleHealthProvider
import me.aquitano.external.google.GeneratedGoogleHealthClient
import me.aquitano.external.google.GoogleHealthDataPointsServiceFactory
import me.aquitano.external.google.GoogleHealthNormalizer
import me.aquitano.external.google.KtorGoogleHealthOAuthClient
import me.aquitano.external.withings.KtorWithingsClient
import me.aquitano.external.withings.WithingsNormalizer
import me.aquitano.external.withings.WithingsProvider
import me.aquitano.health.infrastructure.security.ApiKeyHasher
import me.aquitano.health.infrastructure.time.UtcClock
import me.aquitano.health.shared.AppJson
import net.logstash.logback.argument.StructuredArguments.kv
import org.jetbrains.exposed.sql.Database
import org.slf4j.LoggerFactory

private val logger = LoggerFactory.getLogger("me.aquitano.health.api.Application")

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
    val database = DatabaseFactory().initialize(appConfig.database)
    val apiKeyHasher = ApiKeyHasher()
    val supportRepository = SupportRepository(database)
    val metricsWriteRepository = MetricsWriteRepository()
    val ingestionRepository = IngestionRepository()
    val providerOAuthRepository = ProviderOAuthRepository(database)
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
    val googleHealthOAuthClient = KtorGoogleHealthOAuthClient(httpClient, appConfig.googleHealth)
    val googleHealthClient = GeneratedGoogleHealthClient(
        oauthClient = googleHealthOAuthClient,
        dataPointsServiceFactory = GoogleHealthDataPointsServiceFactory(appConfig.googleHealth.apiBaseUrl),
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
    val ingestionService = IngestionService(
        database = database,
        mappingService = IngestionMappingService(),
        supportRepository = supportRepository,
        ingestionRepository = ingestionRepository,
        metricsWriteRepository = metricsWriteRepository,
        stepSummaryService = StepSummaryService(metricsWriteRepository),
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
    val providerRegistry = HealthProviderRegistry(listOf(googleHealthProvider, withingsProvider))

    val services = ApplicationServices(
        database = database,
        supportRepository = supportRepository,
        apiKeyHasher = apiKeyHasher,
        clock = clock,
        ingestionService = ingestionService,
        metricsQueryService = MetricsQueryService(
            database = database,
            metricsReadRepository = MetricsReadRepository(),
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
        providerStatusService = ProviderStatusService(
            providerRegistry = providerRegistry,
            providerOAuthRepository = providerOAuthRepository,
        ),
        providerWorkflowService = ProviderWorkflowService(
            providerRegistry = providerRegistry,
            providerOAuthRepository = providerOAuthRepository,
        ),
    )

    ApiClientBootstrapService(
        authConfig = appConfig.auth,
        supportRepository = supportRepository,
        apiKeyHasher = apiKeyHasher,
        clock = clock,
    ).bootstrap()

    configureHttp()
    configureRoutes(services = services)
}

data class ApplicationServices(
    val database: Database,
    val supportRepository: SupportRepository,
    val apiKeyHasher: ApiKeyHasher,
    val clock: UtcClock,
    val ingestionService: IngestionService,
    val metricsQueryService: MetricsQueryService,
    val adminService: AdminService,
    val providerRegistry: HealthProviderRegistry,
    val providerDiscoveryService: ProviderDiscoveryService,
    val metricCatalogService: MetricCatalogService,
    val providerStatusService: ProviderStatusService,
    val providerWorkflowService: ProviderWorkflowService,
)
