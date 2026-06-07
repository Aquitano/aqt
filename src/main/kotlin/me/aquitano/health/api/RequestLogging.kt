package me.aquitano.health.api

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.plugins.callid.*
import io.ktor.server.plugins.calllogging.*
import io.ktor.server.request.*
import io.ktor.util.*
import kotlinx.coroutines.slf4j.MDCContext
import kotlinx.coroutines.withContext
import me.aquitano.health.infrastructure.repositories.SupportRepository
import me.aquitano.health.infrastructure.security.ApiKeyHasher
import me.aquitano.health.infrastructure.time.UtcClock
import org.koin.ktor.ext.inject
import org.slf4j.event.Level
import java.util.*

private val RequestStartedAtKey = AttributeKey<Long>("RequestStartedAt")

fun Application.configureRequestLogging() {
    val supportRepository by inject<SupportRepository>()
    val apiKeyHasher by inject<ApiKeyHasher>()
    val clock by inject<UtcClock>()

    install(CallId) {
        retrieveFromHeader(HttpHeaders.XRequestId)
        generate { UUID.randomUUID().toString() }
        verify { it.isNotBlank() }
        replyToHeader(HttpHeaders.XRequestId)
    }

    intercept(ApplicationCallPipeline.Setup) {
        call.attributes.put(RequestStartedAtKey, System.nanoTime())
    }

    intercept(ApplicationCallPipeline.Plugins) {
        val authHeader = call.request.headers[HttpHeaders.Authorization]
        val clientRef = if (authHeader != null && authHeader.startsWith("Bearer ")) {
            val apiKey = authHeader.removePrefix("Bearer ").trim()
            if (apiKey.isNotBlank()) {
                try {
                    val hash = apiKeyHasher.hash(apiKey)
                    supportRepository.findEnabledApiClientByHash(hash, clock.now())
                } catch (e: Exception) {
                    null
                }
            } else null
        } else null

        val mdcMap = mutableMapOf(
            "requestId" to call.callId.orEmpty(),
            "method" to call.request.httpMethod.value,
            "path" to call.request.path(),
            "clientIp" to call.request.local.remoteHost,
            "userAgent" to call.request.headers[HttpHeaders.UserAgent].orEmpty()
        )
        if (clientRef != null) {
            mdcMap["clientId"] = clientRef.id.toString()
            mdcMap["clientName"] = clientRef.name
            call.attributes.put(ApiClientAttributeKey, clientRef)
        }

        withContext(MDCContext(mdcMap)) {
            proceed()
        }
    }

    install(CallLogging) {
        level = Level.INFO
        mdc("requestId") { call -> call.callId.orEmpty() }
        mdc("method") { call -> call.request.httpMethod.value }
        mdc("path") { call -> call.request.path() }
        mdc("clientIp") { call -> call.request.local.remoteHost }
        mdc("userAgent") { call -> call.request.headers[HttpHeaders.UserAgent].orEmpty() }
        mdc("status") { call ->
            call.response.status()?.value?.toString().orEmpty()
        }
        mdc("durationMs") { call -> call.durationMs()?.toString().orEmpty() }
        mdc("clientId") { call -> call.attributes.getOrNull(ApiClientAttributeKey)?.id?.toString().orEmpty() }
        mdc("clientName") { call -> call.attributes.getOrNull(ApiClientAttributeKey)?.name.orEmpty() }
    }
}

private fun ApplicationCall.durationMs(): Long? =
    attributes.getOrNull(RequestStartedAtKey)
        ?.let { (System.nanoTime() - it) / 1_000_000 }

