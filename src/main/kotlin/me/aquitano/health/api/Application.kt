package me.aquitano.health.api

import io.ktor.server.application.Application
import me.aquitano.health.application.AdminService
import me.aquitano.health.application.ApiClientBootstrapService
import me.aquitano.health.application.CanonicalDerivationService
import me.aquitano.health.application.IngestionService
import me.aquitano.health.application.MetricsQueryService
import me.aquitano.health.application.StepSummaryService
import me.aquitano.health.infrastructure.config.toAppConfig
import me.aquitano.health.infrastructure.database.DatabaseFactory
import me.aquitano.health.infrastructure.repositories.CanonicalWriteRepository
import me.aquitano.health.infrastructure.repositories.IngestionRepository
import me.aquitano.health.infrastructure.repositories.MetricsReadRepository
import me.aquitano.health.infrastructure.repositories.SupportRepository
import me.aquitano.health.infrastructure.security.ApiKeyHasher
import me.aquitano.health.infrastructure.time.UtcClock
import org.jetbrains.exposed.sql.Database

fun main(args: Array<String>) {
    io.ktor.server.netty.EngineMain.main(args)
}

fun Application.module() {
    val clock = UtcClock()
    val appConfig = environment.config.toAppConfig()
    val database = DatabaseFactory().initialize(appConfig.database)
    val apiKeyHasher = ApiKeyHasher()
    val supportRepository = SupportRepository(database)
    val canonicalWriteRepository = CanonicalWriteRepository()
    val ingestionRepository = IngestionRepository()
    val services = ApplicationServices(
        database = database,
        supportRepository = supportRepository,
        apiKeyHasher = apiKeyHasher,
        clock = clock,
        ingestionService = IngestionService(
            database = database,
            derivationService = CanonicalDerivationService(),
            supportRepository = supportRepository,
            ingestionRepository = ingestionRepository,
            canonicalWriteRepository = canonicalWriteRepository,
            stepSummaryService = StepSummaryService(canonicalWriteRepository),
        ),
        metricsQueryService = MetricsQueryService(
            database = database,
            metricsReadRepository = MetricsReadRepository(),
        ),
        adminService = AdminService(
            database = database,
            ingestionRepository = ingestionRepository,
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
)
