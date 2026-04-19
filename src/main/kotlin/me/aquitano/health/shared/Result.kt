package me.aquitano.health.shared

sealed interface AppResult<out T> {
    data class Success<T>(val value: T) : AppResult<T>
    data class Failure(val reason: String) : AppResult<Nothing>
}
