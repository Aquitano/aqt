package me.aquitano.external.withings

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
import java.time.Instant

class WithingsSyncAdapter(
    private val client: WithingsClient,
    private val normalizer: WithingsNormalizer,
) : ProviderSyncAdapter {
    override val providerCode: String = WITHINGS_PROVIDER_CODE
    override val defaultSyncFailureMessage: String = "Withings sync failed"
    override val tokenRefreshFailureCode: String = "withings_token_refresh_failed"
    override val tokenRefreshFailureMessage: String = "Withings OAuth token refresh failed"
    override val needsReauthCode: String = "withings_needs_reauth"
    override val needsReauthMessage: String = "Withings needs reconnect before syncing"
    override val recordEmptyDataTypes: Boolean = true

    override fun validate(request: ProviderSyncRequest): ProviderSyncPlan {
        val issues = mutableListOf<ValidationIssue>()
        val dataTypes = request.dataTypes?.takeIf { it.isNotEmpty() }
            ?: WITHINGS_DEFAULT_DATA_TYPES
        dataTypes.forEachIndexed { index, dataType ->
            if (dataType !in WITHINGS_DEFAULT_DATA_TYPES) {
                issues += ValidationIssue(
                    field = "dataTypes[$index]",
                    code = ValidationIssueCodes.UnsupportedValue,
                    message = "unsupported Withings data type",
                )
            }
        }
        if (issues.isNotEmpty()) throw RequestValidationException(issues)

        return ProviderSyncPlan(
            providerInstanceId = request.providerInstanceId,
            requestedFrom = request.from,
            requestedTo = request.to,
            items = dataTypes.distinct().map { dataType ->
                ProviderSyncItem(
                    dataType = dataType,
                    from = request.from,
                    to = request.to,
                )
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
            ConflictException("withings_not_connected", "Withings is not connected")
        } else {
            ConflictException(
                "withings_account_not_found",
                "Withings account is not connected for providerInstanceId: $providerInstanceId",
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
        val result = fetchDataType(accessToken, item.dataType, item.from, item.to)
        val normalized = normalizer.normalize(result)
        return ProviderFetchedBatch(
            dataType = result.dataType,
            pagesFetched = result.pages.size,
            sourceRecordsReceived = result.records.size,
            sourcePayload = normalized.sourcePayload,
            records = normalized.records,
        )
    }

    override fun sourcePayload(context: ProviderSourcePayloadContext): JsonObject =
        buildJsonObject {
            put("provider", WITHINGS_PROVIDER_CODE)
            put("providerInstanceId", context.providerInstanceId)
            put("requestedFrom", context.item.from.toString())
            put("requestedTo", context.item.to.toString())
            put("dataType", context.item.dataType)
            put("pages", context.fetched.sourcePayload["pages"] ?: JsonArray(emptyList()))
            put("records", context.fetched.sourcePayload["records"] ?: JsonArray(emptyList()))
        }

    override fun batchExternalId(
        providerInstanceId: String,
        item: ProviderSyncItem,
    ): String = batchExternalId(providerInstanceId, item.dataType, item.from, item.to)

    override fun isUnauthorized(error: Throwable): Boolean =
        error is WithingsHttpException && error.code == "withings_data_request_failed"

    override fun isInvalidRefreshToken(error: Throwable): Boolean =
        error is WithingsHttpException &&
                error.code == "withings_token_request_failed" &&
                error.providerStatus == 401

    override fun errorCode(error: Throwable): String =
        when (error) {
            is WithingsHttpException -> error.code
            is UpstreamProviderException -> error.code
            else -> "withings_sync_failed"
        }

    private suspend fun fetchDataType(
        accessToken: String,
        dataType: String,
        from: Instant,
        to: Instant,
    ): WithingsFetchResult =
        when (dataType) {
            "activity" -> client.fetchActivity(
                accessToken,
                from,
                to,
                WITHINGS_ACTIVITY_FIELDS_ALL_LISTED,
            )

            "measures" -> client.fetchMeasures(
                accessToken,
                from,
                to,
                WITHINGS_MEASURE_TYPES_ALL_LISTED,
                1,
            )

            "sleep-summary" -> client.fetchSleepSummary(
                accessToken,
                from,
                to,
                WITHINGS_SLEEP_SUMMARY_FIELDS_ALL_LISTED,
            )

            "sleep" -> client.fetchSleep(
                accessToken,
                from,
                to,
                WITHINGS_SLEEP_FIELDS_ALL_LISTED,
            )

            else -> throw WithingsHttpException(
                "withings_unsupported_data_type",
                "Unsupported Withings data type: $dataType",
            )
        }

    private fun batchExternalId(
        providerInstanceId: String,
        dataType: String,
        from: Instant,
        to: Instant,
    ): String = "withings:$providerInstanceId:$dataType:$from:$to"
}
