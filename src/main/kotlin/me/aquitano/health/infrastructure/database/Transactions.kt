package me.aquitano.health.infrastructure.database

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.jetbrains.exposed.v1.jdbc.Database
import org.jetbrains.exposed.v1.jdbc.JdbcTransaction
import org.jetbrains.exposed.v1.jdbc.transactions.suspendTransaction
import java.util.concurrent.ConcurrentHashMap

/**
 * Per-database dispatchers for blocking JDBC work, sized to the connection pool so
 * transactions neither block the caller's dispatcher nor occupy more threads than
 * the pool has connections.
 */
object DatabaseDispatchers {
    private val dispatchers = ConcurrentHashMap<Database, CoroutineDispatcher>()

    fun register(database: Database, poolSize: Int) {
        dispatchers[database] = Dispatchers.IO.limitedParallelism(poolSize)
    }

    fun forDatabase(database: Database): CoroutineDispatcher =
        dispatchers[database] ?: Dispatchers.IO
}

/**
 * [suspendTransaction] variant that runs the blocking JDBC work on the database's
 * pool-sized IO dispatcher instead of the caller's dispatcher. All application code
 * should use this instead of calling [suspendTransaction] directly.
 */
suspend fun <T> suspendDbTransaction(
    db: Database,
    statement: suspend JdbcTransaction.() -> T,
): T =
    withContext(DatabaseDispatchers.forDatabase(db)) {
        suspendTransaction(db = db, statement = statement)
    }
