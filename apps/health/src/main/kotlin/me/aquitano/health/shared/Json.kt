package me.aquitano.health.shared

import kotlinx.serialization.json.Json

val AppJson: Json = Json {
    ignoreUnknownKeys = false
    explicitNulls = false
    isLenient = false
    encodeDefaults = true
}
