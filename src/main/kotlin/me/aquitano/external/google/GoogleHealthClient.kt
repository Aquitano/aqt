package me.aquitano.external.google

import com.google.api.gax.core.FixedCredentialsProvider
import com.google.auth.oauth2.AccessToken
import com.google.auth.oauth2.GoogleCredentials
import com.google.devicesandservices.health.v4.DataPointName
import com.google.devicesandservices.health.v4.DataTypeName
import com.google.devicesandservices.health.v4.DataPointsServiceClient
import com.google.devicesandservices.health.v4.DataPointsServiceSettings
import com.google.devicesandservices.health.v4.GetDataPointRequest
import com.google.devicesandservices.health.v4.ListDataPointsRequest
import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.config.yaml.YamlConfig
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.runBlocking
import me.aquitano.health.infrastructure.config.GoogleHealthConfig
import me.aquitano.health.infrastructure.config.toAppConfig
import me.aquitano.health.infrastructure.database.DatabaseFactory
import me.aquitano.health.infrastructure.providers.googlehealth.GOOGLE_HEALTH_PROVIDER_CODE
import me.aquitano.health.infrastructure.providers.googlehealth.KtorGoogleHealthClient
import me.aquitano.health.infrastructure.repositories.ProviderOAuthRepository
import me.aquitano.health.infrastructure.security.TokenCipher
import me.aquitano.health.shared.AppJson
import java.nio.file.Files
import java.nio.file.Path
import java.time.Instant
import me.aquitano.health.infrastructure.providers.googlehealth.GoogleHealthClient as GoogleHealthOAuthClient

class GoogleHealthClient {
    suspend fun listDataPointsWithStoredOAuth(
        config: GoogleHealthConfig,
        repository: ProviderOAuthRepository,
        oauthClient: GoogleHealthOAuthClient,
        now: Instant = Instant.now(),
        user: String = "me",
        dataType: String,
        pageSize: Int = 10,
    ) {
        listDataPoints(
            accessToken = storedAccessToken(config, repository, oauthClient, now),
            user = user,
            dataType = dataType,
            pageSize = pageSize,
        )
    }

    suspend fun getDataPointWithStoredOAuth(
        config: GoogleHealthConfig,
        repository: ProviderOAuthRepository,
        oauthClient: GoogleHealthOAuthClient,
        now: Instant = Instant.now(),
        user: String = "me",
        dataType: String,
        dataPoint: String,
    ) {
        getDataPoint(
            accessToken = storedAccessToken(config, repository, oauthClient, now),
            user = user,
            dataType = dataType,
            dataPoint = dataPoint,
        )
    }

    fun listDataPoints(
        accessToken: String,
        user: String = "me",
        dataType: String,
        pageSize: Int = 10,
    ) {
        dataPointsServiceClient(accessToken).use { dataPointsServiceClient ->
            val request =
                ListDataPointsRequest.newBuilder()
                    .setParent(DataTypeName.of(user, dataType).toString())
                    .setPageSize(pageSize)
                    .build()
//            dataPointsServiceClient.listDataPoints(request)
//                .iterateAll()
//                .forEach(::println)
            var data = dataPointsServiceClient.listDataPoints(request)

//            dataPointsServiceClient.listDataPoints(request).iterateAll().forEach(::println)
            for (dataPoint in data.iterateAll()) {
                println(dataPoint)
            }

//            check if okay
            print(data.nextPageToken)
        }
    }

    fun getDataPoint(
        accessToken: String,
        user: String = "me",
        dataType: String,
        dataPoint: String,
    ) {
        dataPointsServiceClient(accessToken).use { dataPointsServiceClient ->
            val request =
                GetDataPointRequest.newBuilder()
                    .setName(
                        DataPointName.of(
                            user,
                            dataType,
                            dataPoint,
                        ).toString()
                    )
                    .build()
            val response = dataPointsServiceClient.getDataPoint(request)
            println(response)
        }
    }

    fun dataPointsServiceClient(accessToken: String): DataPointsServiceClient =
        DataPointsServiceClient.create(dataPointsServiceSettings(accessToken))

    internal fun dataPointsServiceSettings(accessToken: String): DataPointsServiceSettings =
        DataPointsServiceSettings.newBuilder()
            .setCredentialsProvider(
                FixedCredentialsProvider.create(
                    GoogleCredentials.create(AccessToken(accessToken, null))
                )
            )
            .build()

    internal suspend fun storedAccessToken(
        config: GoogleHealthConfig,
        repository: ProviderOAuthRepository,
        oauthClient: GoogleHealthOAuthClient,
        now: Instant,
    ): String {
        val account = repository.latestAccount(GOOGLE_HEALTH_PROVIDER_CODE)
            ?: error("Google Health is not connected; run /api/v1/providers/google-health/oauth/start first")
        val cipher = TokenCipher(config.tokenEncryptionKey)
        val accessToken = cipher.decrypt(account.accessTokenCiphertext)
        if (account.expiresAt.isAfter(now.plusSeconds(60))) return accessToken

        val refreshToken = cipher.decrypt(account.refreshTokenCiphertext)
        val tokens = oauthClient.refreshToken(refreshToken, now)
        repository.updateAccessToken(
            accountId = account.id,
            accessTokenCiphertext = cipher.encrypt(tokens.accessToken),
            refreshTokenCiphertext = tokens.refreshToken?.let(cipher::encrypt),
            tokenType = tokens.tokenType,
            expiresAt = tokens.expiresAt,
            scope = tokens.scope,
            now = now,
        )
        return tokens.accessToken
    }
}

fun main() {
    runBlocking {
        loadDotEnvFiles()
        val appConfig = (YamlConfig(null) ?: error("application.yaml was not found")).toAppConfig()
        val config = appConfig.googleHealth
        val database = DatabaseFactory().initialize(appConfig.database)
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

        try {
            val client = GoogleHealthClient()
            val repository = ProviderOAuthRepository(database)
            val oauthClient = KtorGoogleHealthClient(httpClient, config)
            val dataType = env("AQT_HEALTH_GOOGLE_DATA_TYPE", "steps")
            val dataPoint = optionalEnv("AQT_HEALTH_GOOGLE_DATA_POINT")
            if (dataPoint == null) {
                client.listDataPointsWithStoredOAuth(
                    config = config,
                    repository = repository,
                    oauthClient = oauthClient,
                    dataType = dataType,
                )
            } else {
                client.getDataPointWithStoredOAuth(
                    config = config,
                    repository = repository,
                    oauthClient = oauthClient,
                    dataType = dataType,
                    dataPoint = dataPoint,
                )
            }
        } finally {
            httpClient.close()
        }
    }
}

private fun env(name: String, default: String? = null): String =
    optionalEnv(name)
        ?: default
        ?: error("$name is required")

private fun optionalEnv(name: String): String? =
    System.getProperty(name)?.takeIf { it.isNotBlank() }
        ?: System.getenv(name)?.takeIf { it.isNotBlank() }

private fun loadDotEnvFiles(vararg paths: String = arrayOf(".env", ".env.local")) {
    paths.map(Path::of)
        .filter(Files::isRegularFile)
        .forEach(::loadDotEnvFile)
}

private fun loadDotEnvFile(path: Path) {
    Files.readAllLines(path).forEach { rawLine ->
        val line = rawLine.trim()
        if (line.isBlank() || line.startsWith("#")) return@forEach
        val separator = line.indexOf('=')
        if (separator <= 0) return@forEach

        val name = line.substring(0, separator).trim()
        val value = line.substring(separator + 1).trim().trimMatchingQuotes()
        if (name.isNotBlank() && System.getProperty(name).isNullOrBlank()) {
            System.setProperty(name, value)
        }
    }
}

private fun String.trimMatchingQuotes(): String =
    if (length >= 2 && ((first() == '"' && last() == '"') || (first() == '\'' && last() == '\''))) {
        substring(1, length - 1)
    } else {
        this
    }
