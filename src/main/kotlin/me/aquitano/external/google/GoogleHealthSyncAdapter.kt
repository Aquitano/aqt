package me.aquitano.external.google

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import me.aquitano.health.application.providersync.ProviderFetchedBatch
import me.aquitano.health.application.providersync.ProviderSourcePayloadContext
import me.aquitano.health.application.providersync.ProviderSyncAdapter
import me.aquitano.health.application.providersync.ProviderSyncItem
import me.aquitano.health.application.providersync.ProviderSyncPlan
import me.aquitano.health.application.providersync.RefreshedTokenSet
import me.aquitano.health.application.providersync.SyncAccount
import me.aquitano.health.domain.ConflictException
import me.aquitano.health.domain.ProviderSyncRequest
import me.aquitano.health.domain.RequestValidationException
import me.aquitano.health.domain.UpstreamProviderException
import me.aquitano.health.domain.ValidationIssue
import me.aquitano.health.domain.ValidationIssueCodes
import me.aquitano.health.infrastructure.repositories.ACCOUNT_STATUS_NEEDS_REAUTH
import java.time.Duration
import java.time.Instant

class GoogleHealthSyncAdapter(
    private val client: GoogleHealthClient,
    private val normalizer: GoogleHealthNormalizer,
) : ProviderSyncAdapter {
    override val providerCode: String = GOOGLE_HEALTH_PROVIDER_CODE
    override val defaultSyncFailureMessage: String = "Google Health sync failed"
    override val tokenRefreshFailureCode: String = "google_health_token_refresh_failed"
    override val tokenRefreshFailureMessage: String = "Google OAuth token refresh failed"
    override val needsReauthCode: String = "google_health_needs_reauth"
    override val needsReauthMessage: String = "Google Health needs reconnect before syncing"

    override fun validate(request: ProviderSyncRequest): ProviderSyncPlan {
        val issues = mutableListOf<ValidationIssue>()
        val dataTypes = request.dataTypes?.takeIf { it.isNotEmpty() }
            ?: GOOGLE_HEALTH_DEFAULT_DATA_TYPES
        dataTypes.forEachIndexed { index, dataType ->
            if (dataType !in GOOGLE_HEALTH_DEFAULT_DATA_TYPES) {
                issues += ValidationIssue(
                    field = "dataTypes[$index]",
                    code = ValidationIssueCodes.UnsupportedValue,
                    message = "unsupported Google Health data type",
                )
            }
        }
        if (issues.isNotEmpty()) throw RequestValidationException(issues)

        val requestedPageSize = request.pageSize ?: 10000
        return ProviderSyncPlan(
            providerInstanceId = request.providerInstanceId,
            requestedFrom = request.from,
            requestedTo = request.to,
            items = dataTypes.distinct().flatMap { dataType ->
                syncWindows(dataType, request.from, request.to).map { window ->
                    ProviderSyncItem(
                        dataType = dataType,
                        from = window.from,
                        to = window.to,
                        pageSize = pageSizeFor(dataType, requestedPageSize),
                    )
                }
            },
        )
    }

    override fun accountUnavailable(
        providerInstanceId: String?,
        statusHint: SyncAccount?,
    ): Throwable {
        if (statusHint?.accountStatus == ACCOUNT_STATUS_NEEDS_REAUTH) {
            return ConflictException(needsReauthCode, needsReauthMessage)
        }
        return if (providerInstanceId == null) {
            ConflictException(
                "google_health_not_connected",
                "Google Health is not connected",
            )
        } else {
            ConflictException(
                "google_health_account_not_found",
                "Google Health account is not connected for providerInstanceId: $providerInstanceId",
            )
        }
    }

    override suspend fun refreshAccessToken(
        refreshToken: String,
        account: SyncAccount,
        now: Instant,
    ): RefreshedTokenSet {
        val tokens = client.refreshToken(refreshToken, now)
        return RefreshedTokenSet(
            accessToken = tokens.accessToken,
            refreshToken = tokens.refreshToken,
            tokenType = tokens.tokenType,
            expiresAt = tokens.expiresAt,
            scope = tokens.scope,
        )
    }

    override suspend fun fetch(
        accessToken: String,
        account: SyncAccount,
        item: ProviderSyncItem,
        now: Instant,
    ): ProviderFetchedBatch {
        val result = client.fetchDataPoints(
            accessToken,
            item.dataType,
            item.from,
            item.to,
            item.pageSize ?: 10000,
        )
        val normalized = normalizer.normalize(result)
        return ProviderFetchedBatch(
            dataType = result.dataType,
            pagesFetched = result.pages.size,
            sourceRecordsReceived = result.dataPoints.size,
            sourcePayload = normalized.sourcePayload,
            records = normalized.records,
        )
    }

    override fun sourcePayload(context: ProviderSourcePayloadContext): JsonObject =
        buildJsonObject {
            put("provider", GOOGLE_HEALTH_PROVIDER_CODE)
            put("providerInstanceId", context.providerInstanceId)
            put("requestedFrom", context.item.from.toString())
            put("requestedTo", context.item.to.toString())
            put("dataType", context.item.dataType)
            put("pages", context.fetched.sourcePayload["pages"] ?: JsonArray(emptyList()))
        }

    override fun batchExternalId(
        providerInstanceId: String,
        item: ProviderSyncItem,
    ): String = batchExternalId(providerInstanceId, item.dataType, item.from, item.to)

    override fun isUnauthorized(error: Throwable): Boolean =
        error is GoogleHealthUnauthorizedException

    override fun isInvalidRefreshToken(error: Throwable): Boolean =
        error is GoogleHealthUnauthorizedException ||
                error is GoogleHealthHttpException && error.oauthError == "invalid_grant"

    override fun errorCode(error: Throwable): String =
        when (error) {
            is GoogleHealthHttpException -> error.code
            is UpstreamProviderException -> error.code
            else -> "google_health_sync_failed"
        }

    private fun pageSizeFor(dataType: String, pageSize: Int): Int =
        if (dataType == "sleep") pageSize.coerceAtMost(25) else pageSize.coerceAtMost(10000)

    private fun syncWindows(
        dataType: String,
        from: Instant,
        to: Instant,
    ): List<SyncWindow> {
        val windowSize =
            if (dataType == "heart-rate") Duration.ofDays(1) else Duration.between(from, to)
        val windows = mutableListOf<SyncWindow>()
        var windowFrom = from
        while (windowFrom.isBefore(to)) {
            val windowTo = listOf(windowFrom.plus(windowSize), to).minOrNull()!!
            windows += SyncWindow(windowFrom, windowTo)
            windowFrom = windowTo
        }
        return windows
    }

    private fun batchExternalId(
        providerInstanceId: String,
        dataType: String,
        from: Instant,
        to: Instant,
    ): String = "google-health:$providerInstanceId:$dataType:$from:$to"

    private data class SyncWindow(
        val from: Instant,
        val to: Instant,
    )
}
