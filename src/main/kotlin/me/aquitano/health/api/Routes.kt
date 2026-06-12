@file:OptIn(io.ktor.utils.io.ExperimentalKtorApi::class)

package me.aquitano.health.api

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.plugins.swagger.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.routing.openapi.*
import kotlinx.serialization.Serializable
import me.aquitano.health.api.dto.*
import me.aquitano.health.application.metric.common.QueryParams
import me.aquitano.health.domain.NotFoundException
import me.aquitano.health.domain.RequestValidationException
import me.aquitano.health.domain.ValidationIssue
import me.aquitano.health.domain.ValidationIssueCodes
import kotlin.reflect.typeOf

fun Application.configureRoutes(services: ApplicationServices) {
    val openApiInfo = openApiInfo()
    val openApiBaseDoc = openApiBaseDoc()
    val openApiSource = OpenApiDocSource.Routing()

    routing {
        get("/openapi") {
            val doc = openApiSource.read(application, openApiBaseDoc)
            call.respondText(
                stripInferredAuthorizationParameters(doc.content),
                doc.contentType
            )
        }.hide()
        swaggerUI(path = "swagger") {
            info = openApiInfo
            components = openApiBaseDoc.components
            source = openApiSource
            remotePath = "../openapi"
        }

        get("/api/v2/admin/health") {
            call.respond(
                HealthResponse(
                    status = "ok",
                    service = "aqt-health",
                    time = services.clock.now().toString()
                )
            )
        }.describe {
            operationId = "getHealth"
            tag("Admin")
            summary = "Health check"
            description =
                "Public liveness check for local process and dependency monitoring."
            publicEndpoint()
            responses {
                HttpStatusCode.OK {
                    description = "Service health status"
                    content {
                        schema = buildSchema(typeOf<HealthResponse>())
                        example("health", healthResponseExample())
                    }
                }
                commonErrors(
                    unauthorized = false,
                    validation = false,
                    internal = true,
                )
                defaultError()
            }
        }
        post("/api/v2/ingestion/batches") {
            call.requireApiClient(
                supportRepository = services.supportRepository,
                apiKeyHasher = services.apiKeyHasher,
                clock = services.clock,
            )
            val response = services.ingestionService.ingestBatch(
                request = call.receive<IngestionBatchRequest>(),
                now = services.clock.now(),
            )
            val status =
                if (response.duplicateBatch) HttpStatusCode.OK else HttpStatusCode.Created
            call.respond(status, response)
        }.describe {
            operationId = "ingestBatch"
            tag("Ingestion")
            summary = "Ingest a normalized health data batch"
            description =
                "Accepts a trusted normalized health data batch, stores the source payload for audit/reprocessing, writes structured metric tables, and treats repeated provider/batch identifiers idempotently. A duplicate batch returns 200 OK with `duplicateBatch=true`; a newly processed batch returns 201 Created."
            requiresBearerAuth()
            ingestionBatchJsonRequest()
            responses {
                HttpStatusCode.Created {
                    description = "Batch accepted and processed"
                    content {
                        schema = buildSchema(typeOf<IngestionSummaryResponse>())
                        example("created", ingestionSummaryExample())
                    }
                }
                HttpStatusCode.OK {
                    description =
                        "Duplicate batch accepted without creating a new batch"
                    content {
                        schema = buildSchema(typeOf<IngestionSummaryResponse>())
                        example(
                            "duplicate",
                            ingestionSummaryExample(duplicate = true)
                        )
                    }
                }
                commonErrors(conflict = true)
            }
        }
        get("/api/v2/providers") {
            call.authenticateProtected(services)
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
            call.authenticateProtected(services)
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
            call.authenticateProtected(services)
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
            call.authenticateProtected(services)
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
            call.authenticateProtected(services)
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
            call.authenticateProtected(services)
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
            call.authenticateProtected(services)
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
            requiresBearerAuth()
            providerCodePath()
            errorResponses(notFound = true)
        }
        put("/api/v2/providers/{providerCode}/accounts/{providerInstanceId}/scheduled-sync") {
            call.authenticateProtected(services)
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
            requiresBearerAuth()
            providerCodePath()
            jsonRequest<ScheduledSyncConfigUpdateRequestDto>(
                "Scheduled sync configuration fields to update.",
            )
            errorResponses(notFound = true)
        }
        post("/api/v2/providers/{providerCode}/accounts/{providerInstanceId}/scheduled-sync/run") {
            call.authenticateProtected(services)
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
            requiresBearerAuth()
            providerCodePath()
            errorResponses(notFound = true, conflict = true, upstream = true)
        }
        post("/api/v2/providers/{providerCode}/accounts/{providerInstanceId}/disconnect") {
            call.authenticateProtected(services)
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
            call.authenticateProtected(services)
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
            call.authenticateProtected(services)
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
        get("/api/v2/providers/{providerCode}/oauth/callback") {
            val code = call.providerCode()
            call.respond(
                HttpStatusCode.OK,
                services.providerWorkflowService.completeOAuth(
                    providerCode = code,
                    code = call.request.queryParameters["code"],
                    state = call.request.queryParameters["state"],
                    error = call.request.queryParameters["error"],
                    now = services.clock.now(),
                )
            )
        }.describe {
            operationId = "completeProviderOAuth"
            tag("Providers")
            summary = "Complete provider OAuth flow"
            description =
                "Public OAuth redirect target. Exchanges a provider authorization code for stored encrypted tokens, or returns a provider-error response when the provider redirects with `error`."
            publicEndpoint()
            providerCodePath()
            parameters {
                query("code") {
                    description = "OAuth authorization code"
                    schema = buildSchema(typeOf<String>())
                }
                query("state") {
                    description = "OAuth state value"
                    schema = buildSchema(typeOf<String>())
                }
                query("error") {
                    description = "OAuth provider error"
                    schema = buildSchema(typeOf<String>())
                }
            }
            errorResponses(
                unauthorized = false,
                notFound = true,
                upstream = true
            )
        }
        post("/api/v2/providers/{providerCode}/sync") {
            call.authenticateProtected(services)
            val code = call.providerCode()
            call.respond<ProviderSyncResponseDto>(
                HttpStatusCode.OK,
                services.providerWorkflowService.sync(
                    providerCode = code,
                    request = call.receive<ProviderSyncRequestDto>(),
                    now = services.clock.now(),
                )
            )
        }.describe {
            operationId = "syncProvider"
            tag("Providers")
            summary = "Synchronize provider data"
            description =
                "Fetches data from the selected provider for the requested range/data types, normalizes records, ingests resulting batches, and returns per-data-type batch, empty-result, and error details. Provider sync can return partial errors while still storing successful data types."
            requiresBearerAuth()
            providerCodePath()
            jsonRequest<ProviderSyncRequestDto>(
                "Provider sync request. Long historical ranges are accepted for backfill; providers split work into safe internal windows and may enforce page-size constraints advertised by the provider catalog.",
                "syncRequest",
                providerSyncRequestExample()
            )
            errorResponses(notFound = true, conflict = true, upstream = true)
        }
        post("/api/v2/providers/{providerCode}/sync-jobs") {
            call.authenticateProtected(services)
            val code = call.providerCode()
            call.respond<ProviderSyncJobStartResponseDto>(
                HttpStatusCode.Accepted,
                services.providerSyncJobService.create(
                    providerCode = code,
                    request = call.receive<ProviderSyncRequestDto>(),
                    now = services.clock.now(),
                )
            )
        }.describe {
            operationId = "startProviderSyncJob"
            tag("Providers")
            summary = "Start a background provider sync job"
            description =
                "Creates a durable manual provider sync job and returns immediately. The backend processes provider-safe chunks sequentially; clients can poll the job endpoint for progress and final summary after page reloads."
            requiresBearerAuth()
            providerCodePath()
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
            call.authenticateProtected(services)
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
            call.authenticateProtected(services)
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
        get("/api/v2/metrics") {
            call.authenticateProtected(services)
            call.respond<MetricTypeCatalogResponse>(services.scalarMetricQueryService.catalog())
        }.describe {
            operationId = "getMetricTypeCatalog"
            tag("Read")
            summary = "List readable scalar metric types"
            description =
                "Returns every scalar metric type the API can serve, with family, unit, segment support, and allowed context values. Structural metrics (steps, sleep, activity, blood pressure) have dedicated endpoints."
            requiresBearerAuth()
            errorResponses()
        }
        get("/api/v2/metrics/{metricType}") {
            call.authenticateProtected(services)
            call.respond<ScalarSamplesResponse>(
                services.scalarMetricQueryService.list(
                    call.metricTypePath(),
                    call.queryParams(),
                )
            )
        }.describe {
            operationId = "listScalarSamples"
            tag("Read")
            summary = "List scalar samples for one metric type"
            description =
                "Returns canonical (cross-provider deduplicated) samples for the metric type; `raw=true` returns every stored sample instead. Supports `latest=true` for the newest matching sample and opaque `cursor` keyset pagination via `meta.nextCursor`. Unknown metric types return 404."
            requiresBearerAuth()
            scalarMetricQueryParameters()
            errorResponses(notFound = true)
        }
        get("/api/v2/metrics/{metricType}/summary") {
            call.authenticateProtected(services)
            call.respond<ScalarSummaryResponse>(
                services.scalarMetricQueryService.summary(
                    call.metricTypePath(),
                    call.queryParams(),
                )
            )
        }.describe {
            operationId = "summarizeScalarSamples"
            tag("Read")
            summary = "Summarize scalar samples for one metric type"
            description =
                "Returns count, minimum, maximum, average, and the latest canonical sample for the metric type within the requested timestamp and source filters. Unknown metric types return 404."
            requiresBearerAuth()
            scalarSummaryQueryParameters()
            errorResponses(notFound = true)
        }
        get("/api/v2/health/day") {
            call.authenticateProtected(services)
            call.respond<HealthDayResponse>(
                HttpStatusCode.OK,
                services.healthDayQueryService.getHealthDay(
                    call.queryParams(),
                    services.clock.now(),
                )
            )
        }.describe {
            operationId = "getHealthDay"
            tag("Read")
            summary = "Get modular one-day health data"
            description =
                "Returns only the requested one-day health modules for a local day. The `timezone` parameter defines the local-day UTC boundaries. Normalized data is merged across providers by default; provider and providerInstanceId narrow the source set, and includeSource attaches provider metadata to point-level objects where available."
            requiresBearerAuth()
            healthDayQueryParameters()
            responses {
                HttpStatusCode.OK {
                    description = "Requested day modules"
                    content {
                        schema = buildSchema(typeOf<HealthDayResponse>())
                    }
                }
                commonErrors()
                defaultError()
            }
        }
        get("/api/v2/steps") {
            call.authenticateProtected(services)
            call.respond<StepSamplesResponse>(
                services.metricsQueryService.listStepSamples(
                    call.queryParams()
                )
            )
        }.describeReadOperation(
            operationId = "listStepSamples",
            summary = "List step samples",
            descriptionText = "Returns canonical step samples filtered by timestamp range, source provider, provider instance, source metadata inclusion, item limit, and sort order. Use `latest=true` to return the latest matching sample only.",
            includeLatest = true,
            sortValues = listOf("startAt"),
            defaultSort = "startAt",
        )
        get("/api/v2/steps/daily") {
            call.authenticateProtected(services)
            call.respond<StepDailySummariesResponse>(
                HttpStatusCode.OK,
                services.metricsQueryService.listStepDailySummaries(
                    call.queryParams(),
                    services.clock.now()
                )
            )
        }.describeDailyStepReadOperation()
        get("/api/v2/activity/summaries") {
            call.authenticateProtected(services)
            call.respond<ActivitySummariesResponse>(
                HttpStatusCode.OK,
                services.metricsQueryService.listActivitySummaries(
                    call.queryParams(),
                    services.clock.now()
                )
            )
        }.describeActivitySummaryReadOperation()
        get("/api/v2/sleep/sessions") {
            call.authenticateProtected(services)
            call.respond<SleepSessionsResponse>(
                services.metricsQueryService.listSleepSessions(
                    call.queryParams()
                )
            )
        }.describeReadOperation(
            operationId = "listSleepSessions",
            summary = "List sleep sessions",
            descriptionText = "Returns sleep sessions with nested stages. Use `latest=true` to return the latest matching session only.",
            includeLatest = true,
            sortValues = listOf("startAt"),
            defaultSort = "startAt",
        )
        get("/api/v2/sleep/nights") {
            call.authenticateProtected(services)
            call.respond<SleepNightsResponse>(
                HttpStatusCode.OK,
                services.metricsQueryService.listSleepNights(
                    call.queryParams(),
                    services.clock.now()
                )
            )
        }.describeSleepNightReadOperation()
        get("/api/v2/sleep/summaries") {
            call.authenticateProtected(services)
            call.respond<SleepSummariesResponse>(
                services.sleepSummaryReadService.list(
                    call.queryParams()
                )
            )
        }.describeReadOperation(
            operationId = "listSleepSummaries",
            summary = "List sleep summaries",
            descriptionText = "Returns aggregate sleep summary records such as sleep score, efficiency, latency, wakeups, WASO, and stage-duration totals. Use `latest=true` to return the latest matching summary only.",
            includeLatest = true,
            sortValues = listOf("endAt"),
            defaultSort = "endAt",
        )
        get("/api/v2/blood-pressure") {
            call.authenticateProtected(services)
            call.respond<BloodPressureMeasurementsResponse>(
                services.metricsQueryService.listBloodPressure(call.queryParams())
            )
        }.describeReadOperation(
            operationId = "listBloodPressureMeasurements",
            summary = "List blood pressure measurements",
            descriptionText = "Returns paired systolic/diastolic blood-pressure measurements filtered by timestamp and source. Use `latest=true` to return the latest matching measurement only.",
            includeLatest = true,
            sortValues = listOf("measuredAt"),
            defaultSort = "measuredAt",
        )

        get("/api/v2/dashboard/summary") {
            call.authenticateProtected(services)
            call.respond<DashboardSummaryResponse>(
                HttpStatusCode.OK,
                services.metricsQueryService.dashboardSummary(
                    call.queryParams(),
                    services.clock.now()
                )
            )
        }.describe {
            operationId = "getDashboardSummary"
            tag("Read")
            summary = "Get dashboard summary"
            description =
                "Returns aggregate dashboard data for an inclusive UTC date range, including total steps and latest matching weight, heart-rate, and sleep values."
            requiresBearerAuth()
            dashboardQueryParameters()
        }
        get("/api/v2/dashboard/trends") {
            call.authenticateProtected(services)
            call.respond<DashboardTrendsResponse>(
                HttpStatusCode.OK,
                services.trendQueryService.dashboardTrends(
                    call.queryParams(),
                    services.clock.now(),
                )
            )
        }.describe {
            operationId = "getDashboardTrends"
            tag("Read")
            summary = "Get dashboard trends"
            description =
                "Returns trend comparisons for steps, heart rate, sleep, and weight over a configurable period compared to the preceding period."
            requiresBearerAuth()
            parameters {
                query("periodDays") {
                    description = "Number of days in the comparison period"
                    schema = integerSchema(minimum = 1.0, maximum = 90.0, example = 7)
                }
                query("toDate") {
                    description = "End date of current period (ISO-8601 date); defaults to today"
                    schema = stringSchema(format = "date", example = "2026-05-30")
                }
            }
            errorResponses()
        }
        get("/api/v2/admin/ingestion/batches") {
            call.authenticateProtected(services)
            call.respond<IngestionBatchesResponse>(
                services.adminService.listBatches(
                    call.queryParams()
                )
            )
        }.describe {
            operationId = "listIngestionBatches"
            tag("Admin")
            summary = "List ingestion batches"
            description =
                "Lists ingestion batches by received timestamp and optional status for administrative inspection."
            requiresBearerAuth()
            adminQueryParameters()
            errorResponses()
        }
        get("/api/v2/admin/ingestion/batches/{id}") {
            call.authenticateProtected(services)
            call.respond<IngestionBatchDetailResponse>(
                HttpStatusCode.OK,
                services.adminService.getBatchDetail(
                    call.parameters["id"],
                    call.queryParams()
                )
            )
        }.describe {
            operationId = "getIngestionBatch"
            tag("Admin")
            summary = "Get ingestion batch detail"
            description =
                "Returns one ingestion batch with stored record-level detail for audit and debugging."
            requiresBearerAuth()
            parameters {
                path("id") {
                    description = "Ingestion batch id"
                    schema = integerSchema(minimum = 1.0, example = 42)
                }
            }
            errorResponses(notFound = true)
        }
        get("/api/v2/admin/ingestion/failures") {
            call.authenticateProtected(services)
            call.respond<IngestionBatchesResponse>(
                services.adminService.listFailures(
                    call.queryParams()
                )
            )
        }.describe {
            operationId = "listIngestionFailures"
            tag("Admin")
            summary = "List failed ingestion batches"
            description =
                "Lists ingestion batches with failure status for administrative inspection."
            requiresBearerAuth()
            adminQueryParameters()
            errorResponses()
        }
        post("/api/v2/admin/replay") {
            call.authenticateProtected(services)
            call.respond<ReplayJobStartResponse>(
                HttpStatusCode.Accepted,
                services.replayService.create(
                    request = call.receive<ReplayRequest>(),
                    now = services.clock.now(),
                )
            )
        }.describe {
            operationId = "startReplay"
            tag("Admin")
            summary = "Replay projections from the raw event log"
            description =
                "Starts a background job that rebuilds metric projections and/or derived tables from stored ingestion records for the requested date range. Replay is idempotent; with wipe=true the affected projection rows are deleted and rewritten, without it the job acts as a verification pass whose counters report how many writes would have been missing."
            requiresBearerAuth()
            jsonRequest<ReplayRequest>(
                "Replay request. scope selects the projections stage, the derived rebuild stage, or both; metricTypes limits the replay to specific record types; omitting the date range replays all stored history.",
            )
            responses {
                HttpStatusCode.Accepted {
                    description = "Replay job accepted"
                    content {
                        schema = buildSchema(typeOf<ReplayJobStartResponse>())
                    }
                }
                commonErrors()
                defaultError()
            }
        }
        get("/api/v2/admin/replay/latest") {
            call.authenticateProtected(services)
            val job = services.replayService.latest()
                ?: throw NotFoundException("Replay job not found")
            call.respond(HttpStatusCode.OK, job)
        }.describe {
            operationId = "getLatestReplayJob"
            tag("Admin")
            summary = "Get latest replay job"
            description = "Returns the most recently created replay job."
            requiresBearerAuth()
            errorResponses(notFound = true)
        }
        get("/api/v2/admin/replay/{jobId}") {
            call.authenticateProtected(services)
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
            call.respond(HttpStatusCode.OK, services.replayService.get(jobId))
        }.describe {
            operationId = "getReplayJob"
            tag("Admin")
            summary = "Get replay job progress"
            description =
                "Returns progress counters (records replayed, metrics written, duplicates skipped, mapping failures) and the current day item of a replay job."
            requiresBearerAuth()
            parameters {
                path("jobId") {
                    description = "Replay job id returned by startReplay"
                    schema = buildSchema(typeOf<String>())
                }
            }
            errorResponses(notFound = true)
        }
    }
}

@Serializable
data class HealthResponse(
    val status: String,
    val service: String,
    val time: String,
)

private suspend fun ApplicationCall.authenticateProtected(
    services: ApplicationServices
) {
    requireApiClient(
        supportRepository = services.supportRepository,
        apiKeyHasher = services.apiKeyHasher,
        clock = services.clock,
    )
}

private fun ApplicationCall.queryParams(): QueryParams =
    QueryParams(
        request.queryParameters.entries()
            .associate { it.key to it.value.firstOrNull() })

private fun ApplicationCall.metricTypePath(): String {
    val metricType = parameters["metricType"]
    if (metricType.isNullOrBlank()) {
        throw RequestValidationException(
            listOf(
                ValidationIssue(
                    field = "metricType",
                    code = ValidationIssueCodes.InvalidFormat,
                    message = "must not be blank",
                )
            )
        )
    }
    return metricType
}

private fun ApplicationCall.providerCode(): String {
    val code = parameters["providerCode"]
    if (code.isNullOrBlank()) {
        throw RequestValidationException(
            listOf(
                ValidationIssue(
                    field = "providerCode",
                    code = ValidationIssueCodes.InvalidFormat,
                    message = "must not be blank",
                )
            )
        )
    }
    return code
}
