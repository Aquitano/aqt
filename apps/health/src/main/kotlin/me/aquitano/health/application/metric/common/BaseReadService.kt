package me.aquitano.health.application.metric.common

import org.jetbrains.exposed.v1.jdbc.Database
import me.aquitano.health.infrastructure.database.suspendDbTransaction

/**
 * Base class for metric read services.
 */
abstract class BaseReadService(
    protected val database: Database,
) {

    /**
     * Runs [block] inside a suspending transaction on [database].
     *
     * All repository reads should be wrapped in this call to maintain a
     * consistent transaction scope and to support suspension.
     */
    protected suspend fun <T> dbQuery(block: suspend () -> T): T =
        suspendDbTransaction(db = database) {
            block()
        }
}
