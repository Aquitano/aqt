package me.aquitano.health.di

import io.ktor.client.*
import io.ktor.client.engine.cio.*
import io.ktor.client.plugins.*
import io.ktor.client.plugins.contentnegotiation.*
import io.ktor.client.plugins.logging.*
import io.ktor.serialization.kotlinx.json.*
import me.aquitano.external.google.*
import me.aquitano.external.withings.KtorWithingsClient
import me.aquitano.external.withings.WithingsNormalizer
import me.aquitano.external.withings.WithingsProvider
import me.aquitano.health.application.*
import me.aquitano.health.application.metric.activity.ActivityQueryService
import me.aquitano.health.application.metric.activity.repository.ActivitySummaryRepository
import me.aquitano.health.application.metric.activity.repository.ActivitySummaryWriteRepository
import me.aquitano.health.application.metric.activity.repository.CanonicalActivitySummaryDerivationRepository
import me.aquitano.health.application.metric.cardiovascular.CardiovascularQueryService
import me.aquitano.health.application.metric.cardiovascular.repository.CardiovascularRepository
import me.aquitano.health.application.metric.cardiovascular.repository.CardiovascularWriteRepository
import me.aquitano.health.application.metric.common.MetricWriteService
import me.aquitano.health.application.metric.common.MetricsQueryService
import me.aquitano.health.application.metric.dashboard.DashboardQueryService
import me.aquitano.health.application.metric.scalar.ScalarMetricQueryService
import me.aquitano.health.application.metric.scalar.ScalarSampleReadRepository
import me.aquitano.health.application.metric.scalar.ScalarSampleWriteRepository
import me.aquitano.health.application.metric.sleep.SleepQueryService
import me.aquitano.health.application.metric.sleep.derived.SleepNightDerivation
import me.aquitano.health.application.metric.sleep.repository.CanonicalSleepSessionDerivationRepository
import me.aquitano.health.application.metric.sleep.repository.CanonicalSleepSummaryDerivationRepository
import me.aquitano.health.application.metric.sleep.repository.SleepNightDerivationRepository
import me.aquitano.health.application.metric.sleep.repository.SleepRepository
import me.aquitano.health.application.metric.sleep.repository.SleepWriteRepository
import me.aquitano.health.application.metric.steps.StepQueryService
import me.aquitano.health.application.metric.steps.derived.CanonicalStepDerivationService
import me.aquitano.health.application.metric.steps.repository.CanonicalStepDerivationRepository
import me.aquitano.health.application.metric.steps.repository.StepDailySummaryDerivationRepository
import me.aquitano.health.application.metric.steps.repository.StepRepository
import me.aquitano.health.application.metric.steps.repository.StepWriteRepository
import me.aquitano.health.infrastructure.config.AppConfig
import me.aquitano.health.infrastructure.repositories.IngestionRepository
import me.aquitano.health.infrastructure.repositories.PendingDerivedRebuildRepository
import me.aquitano.health.infrastructure.repositories.ProjectionWipeRepository
import me.aquitano.health.infrastructure.repositories.ProviderOAuthRepository
import me.aquitano.health.infrastructure.repositories.ProviderSyncJobRepository
import me.aquitano.health.infrastructure.repositories.ReplayJobRepository
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
    single { ProviderSyncJobRepository(database) }
    single { ReplayJobRepository(database) }
    single { PendingDerivedRebuildRepository(database) }
    single { ProjectionWipeRepository() }
    single { ScheduledSyncRepository(database) }
    single { ScheduledSyncRunGuard() }

    // Metric repositories (stateless, no constructor args needed)
    single { ActivitySummaryRepository() }
    single { ActivitySummaryWriteRepository() }
    single { CanonicalActivitySummaryDerivationRepository() }
    single { CardiovascularRepository() }
    single { CardiovascularWriteRepository() }
    single { ScalarSampleReadRepository() }
    single { ScalarSampleWriteRepository() }
    single { SleepRepository() }
    single { SleepWriteRepository() }
    single { StepWriteRepository() }
    single { CanonicalSleepSessionDerivationRepository() }
    single { CanonicalSleepSummaryDerivationRepository() }
    single { StepRepository() }
    single { CanonicalStepDerivationRepository() }
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
            install(Logging) {
                logger = Logger.DEFAULT
                level = LogLevel.INFO
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
    single { SleepNightDerivation(get<SleepNightDerivationRepository>()) }
    single { SleepNightService(get<SleepNightDerivationRepository>(), get()) }
    single {
        MetricWriteService(
            stepWriteRepository = get(),
            sleepWriteRepository = get(),
            activitySummaryWriteRepository = get(),
            cardiovascularWriteRepository = get(),
            scalarSampleWriteRepository = get(),
        )
    }
    single { MetricCatalogBootstrap(database) }
    single {
        StepSummaryService(get<StepDailySummaryDerivationRepository>())
    }
    single { CanonicalStepDerivationService(get<CanonicalStepDerivationRepository>()) }
    single<DerivedRebuildExecutor> {
        TransactionalDerivedRebuildExecutor(
            database = database,
            registry = DerivedRebuildModuleRegistry(
                derivedRebuildModules(
                    stepSummaryService = get(),
                    canonicalStepService = get(),
                    sleepNightService = get(),
                )
            ),
        )
    }
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
            derivedRebuildExecutor = get(),
            pendingDerivedRebuildRepository = get(),
        )
    }
    single {
        PendingDerivedRebuildSweeper(
            repository = get(),
            derivedRebuildExecutor = get(),
            clock = get(),
        )
    }

    // Health day module registry
    single {
        HealthDayModuleRegistry(
            listOf(
                StepsDayModule(get()),
                HeartRateDayModule(get()),
                WeightDayModule(get()),
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
            runGuard = get(),
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
    single {
        ProviderWorkflowService(
            providerRegistry = get(),
            providerOAuthRepository = get(),
            providerStatusService = get(),
        )
    }
    single {
        ProviderSyncJobService(
            providerRegistry = get(),
            workflowService = get(),
            repository = get(),
            clock = get(),
        )
    }
    single {
        ReplayService(
            database = database,
            ingestionRepository = get(),
            mappingService = get(),
            metricWriteService = get(),
            derivedRebuildExecutor = get(),
            replayJobRepository = get(),
            projectionWipeRepository = get(),
            clock = get(),
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
    single { ActivityQueryService(database = database, canonicalRepository = get()) }
    single {
        CardiovascularQueryService(
            database = database,
            cardiovascularRepository = get(),
        )
    }
    single {
        ScalarMetricQueryService(
            database = database,
            scalarRepository = get(),
        )
    }
    single {
        SleepQueryService(
            database = database,
            sleepRepository = get(),
            canonicalSessionRepository = get(),
            sleepNightService = get(),
        )
    }
    single {
        StepQueryService(
            database = database,
            stepRepository = get(),
            canonicalRepository = get(),
        )
    }
    single {
        DashboardQueryService(
            database = database,
            canonicalStepRepository = get(),
            sleepRepository = get(),
            scalarRepository = get(),
            sleepNightService = get(),
        )
    }
    single {
        MetricsQueryService(
            activityQueryService = get(),
            stepQueryService = get(),
            sleepQueryService = get(),
            cardiovascularQueryService = get(),
            dashboardQueryService = get(),
        )
    }
    single {
        SleepSummaryReadService(
            database = database,
            canonicalRepository = get(),
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
            sleepRepository = get(),
            scalarRepository = get(),
        )
    }
}
