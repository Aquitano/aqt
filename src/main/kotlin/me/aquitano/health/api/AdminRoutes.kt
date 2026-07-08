@file:OptIn(io.ktor.utils.io.ExperimentalKtorApi::class)

package me.aquitano.health.api

import io.ktor.http.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.routing.openapi.*
import me.aquitano.health.api.dto.*
import me.aquitano.health.domain.NotFoundException
import kotlin.reflect.typeOf

/** Ingestion batch inspection and replay administration routes. */
internal fun Route.adminRoutes(services: ApplicationServices) {
    get("/api/v2/admin/ingestion/batches") {
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
        call.respond<ReplayJobStartResponse>(
            HttpStatusCode.Accepted,
            services.replayService.create(
                request = call.receive<ReplayRequest>(),
                now = services.clock.now(),
                idempotencyKey = call.idempotencyKey(),
            )
        )
    }.describe {
        operationId = "startReplay"
        tag("Admin")
        summary = "Replay projections from the raw event log"
        description =
            "Starts a background job that rebuilds metric projections and/or derived tables from stored ingestion records for the requested date range. Replay is idempotent; with wipe=true the affected projection rows are deleted and rewritten, without it the job acts as a verification pass whose counters report how many writes would have been missing. Repeating the request with the same Idempotency-Key returns the already-created job instead of starting a new one."
        requiresBearerAuth()
        idempotencyKeyHeader()
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
        val jobId = call.requiredPathParam("jobId")
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
