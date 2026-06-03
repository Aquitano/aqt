package me.aquitano.health.di

import io.ktor.client.*
import io.ktor.client.engine.cio.*
import io.ktor.client.plugins.*
import io.ktor.client.plugins.contentnegotiation.*
import io.ktor.serialization.kotlinx.json.*
import me.aquitano.external.google.*
import me.aquitano.external.withings.KtorWithingsClient
import me.aquitano.external.withings.WithingsNormalizer
import me.aquitano.external.withings.WithingsProvider
import me.aquitano.health.application.*
import me.aquitano.health.application.metric.activity.ActivityQueryService
import me.aquitano.health.application.metric.activity.repository.ActivitySummaryRepository
import me.aquitano.health.application.metric.body.BodyMeasurementQueryService
import me.aquitano.health.application.metric.body.repository.BodyMeasurementRepository
import me.aquitano.health.application.metric.cardiovascular.CardiovascularQueryService
import me.aquitano.health.application.metric.cardiovascular.repository.CardiovascularRepository
import me.aquitano.health.application.metric.common.MetricWriteService
import me.aquitano.health.application.metric.common.MetricsQueryService
import me.aquitano.health.application.metric.dashboard.DashboardQueryService
import me.aquitano.health.application.metric.heart.HeartRateQueryService
import me.aquitano.health.application.metric.heart.derived.CanonicalHeartRateDerivationService
import me.aquitano.health.application.metric.heart.repository.CanonicalHeartRateDerivationRepository
import me.aquitano.health.application.metric.heart.repository.HeartRateRepository
import me.aquitano.health.application.metric.hrv.HrvQueryService
import me.aquitano.health.application.metric.hrv.derived.CanonicalHrvDerivationService
import me.aquitano.health.application.metric.hrv.repository.CanonicalHrvDerivationRepository
import me.aquitano.health.application.metric.hrv.repository.HrvRepository
import me.aquitano.health.application.metric.respiratory.RespiratoryRateQueryService
import me.aquitano.health.application.metric.respiratory.derived.CanonicalRespiratoryRateDerivationService
import me.aquitano.health.application.metric.respiratory.repository.CanonicalRespiratoryRateDerivationRepository
import me.aquitano.health.application.metric.respiratory.repository.RespiratoryRateRepository
import me.aquitano.health.application.metric.sleep.SleepQueryService
import me.aquitano.health.application.metric.sleep.repository.SleepNightDerivationRepository
import me.aquitano.health.application.metric.sleep.repository.SleepRepository
import me.aquitano.health.application.metric.steps.StepQueryService
import me.aquitano.health.application.metric.steps.repository.StepDailySummaryDerivationRepository
import me.aquitano.health.application.metric.steps.repository.StepRepository
import me.aquitano.health.infrastructure.config.AppConfig
import me.aquitano.health.infrastructure.repositories.IngestionRepository
import me.aquitano.health.infrastructure.repositories.ProviderOAuthRepository
import me.aquitano.health.infrastructure.repositories.ScheduledSyncRepository
import me.aquitano.health.infrastructure.repositories.SupportRepository
import me.aquitano.health.infrastructure.security.ApiKeyHasher
import me.aquitano.health.infrastructure.time.UtcClock
import me.aquitano.health.shared.AppJson
import org.jetbrains.exposed.v1.jdbc.Database
import org.koin.dsl.module

/**
 * Repositories layer: all low-level data-access objects.
 * Receives [database] and [config] as seeds from the bootstrap context.
 */
fun repositoriesModule(database: Database, config: AppConfig) = module {
    // Expose the pre-built database connection to the container
    single<Database> { database }

    // Infrastructure repositories (need database or config)
    single { SupportRepository(database) }
    single { IngestionRepository() }
    single { ProviderOAuthRepository(database) }
    single { ScheduledSyncRepository(database) }

    // Metric repositories (stateless, no constructor args needed)
    single { ActivitySummaryRepository() }
    single { BodyMeasurementRepository() }
    single { CardiovascularRepository() }
    single { HeartRateRepository() }
    single { CanonicalHeartRateDerivationRepository() }
    single { HrvRepository() }
    single { CanonicalHrvDerivationRepository() }
    single { RespiratoryRateRepository() }
    single { CanonicalRespiratoryRateDerivationRepository() }
    single { SleepRepository() }
    single { StepRepository() }
    single { SleepNightDerivationRepository() }
    single { StepDailySummaryDerivationRepository() }

    // HTTP client (shared across providers)
    single<HttpClient> {
        HttpClient(CIO) {
            install(ContentNegotiation) { json(AppJson) }
            install(HttpTimeout) {
                connectTimeoutMillis = 10_000
                socketTimeoutMillis = 60_000
                requestTimeoutMillis = 120_000
            }
        }
    }

    // External provider clients
    single<GoogleHealthOAuthClient> {
        KtorGoogleHealthOAuthClient(get(), config.googleHealth)
    }
    single {
        GeneratedGoogleHealthClient(
            oauthClient = get(),
            dataPointsServiceFactory = GoogleHealthDataPointsServiceFactory(
                config.googleHealth.apiBaseUrl
            ),
        )
    }
    single { KtorWithingsClient(get(), config.withings) }
}

/**
 * Services layer: domain/application services that orchestrate repositories.
 */
fun servicesModule(database: Database, config: AppConfig) = module {
    single { UtcClock() }
    single { ApiKeyHasher() }
    single { CanonicalMetricsService(CanonicalMetricsPolicy.default()) }
    single { SleepNightService(get<SleepNightDerivationRepository>()) }
    single { MetricWriteService() }
    single {
        StepSummaryService(get<StepDailySummaryDerivationRepository>())
    }
    single { CanonicalHeartRateDerivationService(get<CanonicalHeartRateDerivationRepository>()) }
    single { CanonicalRespiratoryRateDerivationService(get<CanonicalRespiratoryRateDerivationRepository>()) }
    single { CanonicalHrvDerivationService(get<CanonicalHrvDerivationRepository>()) }
    single {
        IngestionMappingService()
    }
    single {
        IngestionService(
            database = database,
            mappingService = get(),
            supportRepository = get(),
            ingestionRepository = get(),
            metricWriteService = get(),
            stepSummaryService = get(),
            sleepNightService = get(),
            canonicalHeartRateService = get(),
            canonicalRespiratoryRateService = get(),
            canonicalHrvService = get(),
        )
    }

    // Health day module registry
    single {
        HealthDayModuleRegistry(
            listOf(
                StepsDayModule(get(), get()),
                HeartRateDayModule(get(), get()),
                WeightDayModule(get(), get()),
                SleepDayModule(get(), get()),
            )
        )
    }

    // External health providers
    single {
        GoogleHealthProvider(
            config = config.googleHealth,
            repository = get(),
            client = get<GeneratedGoogleHealthClient>(),
            normalizer = GoogleHealthNormalizer(),
            ingestionService = get(),
        )
    }
    single {
        WithingsProvider(
            config = config.withings,
            repository = get(),
            client = get<KtorWithingsClient>(),
            normalizer = WithingsNormalizer(),
            ingestionService = get(),
        )
    }
    single {
        HealthProviderRegistry(
            listOf(
                get<GoogleHealthProvider>(),
                get<WithingsProvider>(),
            )
        )
    }

    single {
        ProviderStatusService(
            providerRegistry = get(),
            providerOAuthRepository = get(),
        )
    }
    single {
        ScheduledProviderSyncService(
            providerRegistry = get(),
            providerOAuthRepository = get(),
            repository = get<ScheduledSyncRepository>(),
        )
    }
    single {
        ScheduledProviderSyncScheduler(
            service = get(),
            clock = get(),
        )
    }

    single { AdminService(database = database, ingestionRepository = get()) }
    single { ProviderDiscoveryService(providerRegistry = get()) }
    single { MetricCatalogService(providerRegistry = get()) }
    single {
        ProviderWorkflowService(
            providerRegistry = get(),
            providerOAuthRepository = get(),
            providerStatusService = get(),
        )
    }
    single {
        ApiClientBootstrapService(
            authConfig = config.auth,
            supportRepository = get(),
            apiKeyHasher = get(),
            clock = get(),
        )
    }
}

/**
 * Query services layer: read-side services consumed by route handlers.
 */
fun queryServicesModule(database: Database) = module {
    single { ActivityQueryService(database = database, activitySummaryRepository = get(), canonicalMetricsService = get()) }
    single { BodyMeasurementQueryService(database = database, bodyMeasurementRepository = get(), canonicalMetricsService = get()) }
    single { CardiovascularQueryService(database = database, cardiovascularRepository = get()) }
    single {
        HeartRateQueryService(
            database = database,
            heartRateRepository = get(),
            canonicalRepository = get(),
        )
    }
    single {
        HrvQueryService(
            database = database,
            hrvRepository = get(),
            canonicalRepository = get(),
        )
    }
    single {
        RespiratoryRateQueryService(
            database = database,
            respiratoryRateRepository = get(),
            canonicalRepository = get(),
        )
    }
    single {
        SleepQueryService(
            database = database,
            sleepRepository = get(),
            canonicalMetricsService = get(),
            sleepNightService = get(),
        )
    }
    single { StepQueryService(database = database, stepRepository = get(), canonicalMetricsService = get()) }
    single {
        DashboardQueryService(
            database = database,
            stepRepository = get(),
            sleepRepository = get(),
            bodyMeasurementRepository = get(),
            heartRateRepository = get(),
            canonicalHeartRateRepository = get(),
            canonicalMetricsService = get(),
            sleepNightService = get(),
        )
    }
    single {
        MetricsQueryService(
            activityQueryService = get(),
            stepQueryService = get(),
            sleepQueryService = get(),
            bodyMeasurementQueryService = get(),
            heartRateQueryService = get(),
            respiratoryRateQueryService = get(),
            hrvQueryService = get(),
            cardiovascularQueryService = get(),
            dashboardQueryService = get(),
        )
    }
    single {
        SleepSummaryReadService(
            database = database,
            sleepRepository = get(),
            canonicalMetricsService = get(),
        )
    }
    single {
        HealthDayQueryService(
            database = database,
            registry = get(),
        )
    }
    single {
        TrendQueryService(
            database = database,
            stepRepository = get(),
            heartRateRepository = get(),
            sleepRepository = get(),
            bodyMeasurementRepository = get(),
        )
    }
}
