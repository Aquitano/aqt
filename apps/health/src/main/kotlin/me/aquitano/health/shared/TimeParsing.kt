package me.aquitano.health.shared

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

fun Instant.utcDate(): LocalDate = atZone(ZoneOffset.UTC).toLocalDate()
