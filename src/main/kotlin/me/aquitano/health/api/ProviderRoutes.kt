@file:OptIn(io.ktor.utils.io.ExperimentalKtorApi::class)

package me.aquitano.health.api

import io.ktor.http.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.routing.openapi.*
import me.aquitano.health.api.dto.*
import me.aquitano.health.domain.NotFoundException
import me.aquitano.health.domain.RequestValidationException
import me.aquitano.health.domain.ValidationIssue
import me.aquitano.health.domain.ValidationIssueCodes
import kotlin.reflect.typeOf

/** Provider discovery, OAuth account, scheduled-sync, and sync-job routes. */
internal fun Route.providerRoutes(services: ApplicationServices) {
    get("/api/v2/providers") {
        call.respond<ProviderCatalogResponseDto>(services.providerDiscoveryService.listProviders())
    }.describe {
        operationId = "listProviders"
        tag("Providers")
        summary = "List provider discovery metadata"
        description =
            "Returns provider capabilities, supported data types, default sync selections, and workflow endpoint paths for client discovery."
        requiresBearerAuth()
        errorResponses()
    }
    get("/api/v2/providers/status") {
        call.respond<ProviderStatusCatalogResponseDto>(
            services.providerStatusService.listProviderStatuses(
                services.clock.now()
            )
        )
    }.describe {
        operationId = "listProviderStatuses"
        tag("Providers")
        summary = "List provider authentication and account status"
        description =
            "Returns provider configuration, OAuth connection state, available accounts, token status, and the next suggested workflow action."
        requiresBearerAuth()
        errorResponses()
    }
    get("/api/v2/providers/{providerCode}") {
        val code = call.providerCode()
        call.respond<ProviderDescriptorResponseDto>(
            services.providerDiscoveryService.getProvider(
                code
            )
        )
    }.describe {
        operationId = "getProvider"
        tag("Providers")
        summary = "Get provider discovery metadata"
        description = "Returns discovery metadata for one provider code."
        requiresBearerAuth()
        providerCodePath()
        errorResponses(notFound = true)
    }
    get("/api/v2/providers/{providerCode}/status") {
        val code = call.providerCode()
        call.respond<ProviderStatusResponseDto>(
            services.providerStatusService.getProviderStatus(
                code,
                services.clock.now()
            )
        )
    }.describe {
        operationId = "getProviderStatus"
        tag("Providers")
        summary = "Get provider authentication and account status"
        description =
            "Returns configuration, connection, account, and token status for one provider code."
        requiresBearerAuth()
        providerCodePath()
        errorResponses(notFound = true)
    }
    get("/api/v2/providers/{providerCode}/accounts") {
        val code = call.providerCode()
        call.respond<ProviderAccountListResponseDto>(
            services.providerWorkflowService.listAccounts(
                code,
                services.clock.now(),
            )
        )
    }.describe {
        operationId = "listProviderAccounts"
        tag("Providers")
        summary = "List provider OAuth accounts"
        description =
            "Returns lifecycle status for OAuth accounts for one provider without exposing stored token material."
        requiresBearerAuth()
        providerCodePath()
        errorResponses(notFound = true)
    }
    get("/api/v2/providers/{providerCode}/accounts/{providerInstanceId}") {
        val code = call.providerCode()
        val providerInstanceId = call.parameters["providerInstanceId"]
            ?: throw RequestValidationException(listOf(ValidationIssue("providerInstanceId")))
        call.respond<ProviderAccountStatusResponseDto>(
            services.providerWorkflowService.getAccount(
                code,
                providerInstanceId,
                services.clock.now(),
            )
        )
    }.describe {
        operationId = "getProviderAccount"
        tag("Providers")
        summary = "Get provider OAuth account status"
        description =
            "Returns lifecycle status for one OAuth account without exposing stored token material."
        requiresBearerAuth()
        providerCodePath()
        errorResponses(notFound = true)
    }
    get("/api/v2/providers/{providerCode}/accounts/{providerInstanceId}/scheduled-sync") {
        val code = call.providerCode()
        val providerInstanceId = call.parameters["providerInstanceId"]
            ?: throw RequestValidationException(listOf(ValidationIssue("providerInstanceId")))
        call.respond<ScheduledSyncConfigResponseDto>(
            services.scheduledProviderSyncService.getConfig(
                providerCode = code,
                providerInstanceId = providerInstanceId,
            )
        )
    }.describe {
        operationId = "getScheduledProviderSync"
        tag("Providers")
        summary = "Get scheduled provider sync configuration"
        description =
            "Returns the background sync configuration for one provider account, including cadence, lookback window, selected data types, per-data-type checkpoints, and last success/failure state. Accounts without stored configuration return the disabled defaults."
        requiresBearerAuth()
        providerCodePath()
        errorResponses(notFound = true)
    }
    put("/api/v2/providers/{providerCode}/accounts/{providerInstanceId}/scheduled-sync") {
        val code = call.providerCode()
        val providerInstanceId = call.parameters["providerInstanceId"]
            ?: throw RequestValidationException(listOf(ValidationIssue("providerInstanceId")))
        call.respond<ScheduledSyncConfigResponseDto>(
            services.scheduledProviderSyncService.updateConfig(
                providerCode = code,
                providerInstanceId = providerInstanceId,
                request = call.receive<ScheduledSyncConfigUpdateRequestDto>(),
                now = services.clock.now(),
            )
        )
    }.describe {
        operationId = "updateScheduledProviderSync"
        tag("Providers")
        summary = "Update scheduled provider sync configuration"
        description =
            "Upserts the background sync configuration for one provider account. Omitted fields keep their current (or default) values; enabling the schedule sets the next run to now."
        requiresBearerAuth()
        providerCodePath()
        jsonRequest<ScheduledSyncConfigUpdateRequestDto>(
            "Scheduled sync configuration fields to update.",
        )
        errorResponses(notFound = true)
    }
    post("/api/v2/providers/{providerCode}/accounts/{providerInstanceId}/scheduled-sync/run") {
        val code = call.providerCode()
        val providerInstanceId = call.parameters["providerInstanceId"]
            ?: throw RequestValidationException(listOf(ValidationIssue("providerInstanceId")))
        call.respond<ScheduledSyncRunResponseDto>(
            services.scheduledProviderSyncService.runNow(
                providerCode = code,
                providerInstanceId = providerInstanceId,
                now = services.clock.now(),
            )
        )
    }.describe {
        operationId = "runScheduledProviderSyncNow"
        tag("Providers")
        summary = "Run scheduled provider sync immediately"
        description =
            "Executes the configured scheduled sync for one provider account right away using the stored data types and checkpoints. Returns 409 when scheduled sync is not configured or a run is already in progress."
        requiresBearerAuth()
        providerCodePath()
        errorResponses(notFound = true, conflict = true, upstream = true)
    }
    post("/api/v2/providers/{providerCode}/accounts/{providerInstanceId}/disconnect") {
        val code = call.providerCode()
        val providerInstanceId = call.parameters["providerInstanceId"]
            ?: throw RequestValidationException(listOf(ValidationIssue("providerInstanceId")))
        call.respond<ProviderDisconnectResponseDto>(
            services.providerWorkflowService.disconnect(
                code,
                providerInstanceId,
                services.clock.now(),
            )
        )
    }.describe {
        operationId = "disconnectProviderAccount"
        tag("Providers")
        summary = "Disconnect a provider OAuth account locally"
        description =
            "Clears locally stored OAuth token material and marks the provider account disconnected. This does not revoke tokens upstream."
        requiresBearerAuth()
        providerCodePath()
        errorResponses(notFound = true, conflict = true)
    }
    post("/api/v2/providers/{providerCode}/accounts/{providerInstanceId}/reconnect") {
        val code = call.providerCode()
        val providerInstanceId = call.parameters["providerInstanceId"]
            ?: throw RequestValidationException(listOf(ValidationIssue("providerInstanceId")))
        call.respond<ProviderOAuthStartResponse>(
            services.providerWorkflowService.reconnect(
                code,
                providerInstanceId,
                services.clock.now(),
            )
        )
    }.describe {
        operationId = "reconnectProviderAccount"
        tag("Providers")
        summary = "Start provider OAuth reconnect flow"
        description =
            "Validates an existing local provider account and starts the provider OAuth flow again for re-consent."
        requiresBearerAuth()
        providerCodePath()
        errorResponses(notFound = true)
    }
    get("/api/v2/providers/{providerCode}/oauth/start") {
        val code = call.providerCode()
        call.respond<ProviderOAuthStartResponse>(
            services.providerWorkflowService.startOAuth(
                code,
                services.clock.now()
            )
        )
    }.describe {
        operationId = "startProviderOAuth"
        tag("Providers")
        summary = "Start provider OAuth flow"
        description =
            "Creates provider OAuth state and returns the authorization URL clients should open to connect an account. The state expires at the returned `expiresAt` timestamp."
        requiresBearerAuth()
        providerCodePath()
        errorResponses(notFound = true)
    }
    post("/api/v2/providers/{providerCode}/sync") {
        val code = call.providerCode()
        call.respond<ProviderSyncResponseDto>(
            HttpStatusCode.OK,
            services.providerWorkflowService.sync(
                providerCode = code,
                request = call.receive<ProviderSyncRequestDto>(),
                now = services.clock.now(),
                idempotencyKey = call.idempotencyKey(),
            )
        )
    }.describe {
        operationId = "syncProvider"
        tag("Providers")
        summary = "Synchronize provider data"
        description =
            "Fetches data from the selected provider for the requested range/data types, normalizes records, ingests resulting batches, and returns per-data-type batch, empty-result, and error details. Provider sync can return partial errors while still storing successful data types. Repeating a completed request with the same Idempotency-Key returns the stored response without syncing again; failed requests are not stored, so retrying them re-runs the sync."
        requiresBearerAuth()
        providerCodePath()
        idempotencyKeyHeader()
        jsonRequest<ProviderSyncRequestDto>(
            "Provider sync request. Long historical ranges are accepted for backfill; providers split work into safe internal windows and may enforce page-size constraints advertised by the provider catalog.",
            "syncRequest",
            providerSyncRequestExample()
        )
        errorResponses(notFound = true, conflict = true, upstream = true)
    }
    post("/api/v2/providers/{providerCode}/sync-jobs") {
        val code = call.providerCode()
        call.respond<ProviderSyncJobStartResponseDto>(
            HttpStatusCode.Accepted,
            services.providerSyncJobService.create(
                providerCode = code,
                request = call.receive<ProviderSyncRequestDto>(),
                now = services.clock.now(),
                idempotencyKey = call.idempotencyKey(),
            )
        )
    }.describe {
        operationId = "startProviderSyncJob"
        tag("Providers")
        summary = "Start a background provider sync job"
        description =
            "Creates a durable manual provider sync job and returns immediately. The backend processes provider-safe chunks sequentially; clients can poll the job endpoint for progress and final summary after page reloads. Repeating the request with the same Idempotency-Key returns the already-created job instead of starting a new one."
        requiresBearerAuth()
        providerCodePath()
        idempotencyKeyHeader()
        jsonRequest<ProviderSyncRequestDto>(
            "Provider sync request. Long historical ranges are accepted for backfill and processed by the backend job worker.",
            "syncJobRequest",
            providerSyncRequestExample()
        )
        responses {
            HttpStatusCode.Accepted {
                description = "Sync job accepted"
                content {
                    schema = buildSchema(typeOf<ProviderSyncJobStartResponseDto>())
                }
            }
            commonErrors(notFound = true, conflict = true)
            defaultError()
        }
    }
    get("/api/v2/providers/{providerCode}/sync-jobs/latest") {
        val code = call.providerCode()
        val job = services.providerSyncJobService.latest(code)
            ?: throw NotFoundException("Provider sync job not found")
        call.respond(HttpStatusCode.OK, job)
    }.describe {
        operationId = "getLatestProviderSyncJob"
        tag("Providers")
        summary = "Get latest provider sync job"
        description = "Returns the latest manual provider sync job for a provider."
        requiresBearerAuth()
        providerCodePath()
        errorResponses(notFound = true)
    }
    get("/api/v2/providers/{providerCode}/sync-jobs/{jobId}") {
        val jobId = call.parameters["jobId"]?.takeIf { it.isNotBlank() }
            ?: throw RequestValidationException(
                listOf(
                    ValidationIssue(
                        field = "jobId",
                        code = ValidationIssueCodes.Required,
                        message = "is required",
                    )
                )
            )
        call.respond(HttpStatusCode.OK, services.providerSyncJobService.get(jobId))
    }.describe {
        operationId = "getProviderSyncJob"
        tag("Providers")
        summary = "Get provider sync job progress"
        description =
            "Returns progress counters, the current provider-safe window, and the final sync summary when the background job has finished."
        requiresBearerAuth()
        providerCodePath()
        parameters {
            path("jobId") {
                description = "Provider sync job id returned by startProviderSyncJob"
                schema = buildSchema(typeOf<String>())
            }
        }
        errorResponses(notFound = true)
    }
}
