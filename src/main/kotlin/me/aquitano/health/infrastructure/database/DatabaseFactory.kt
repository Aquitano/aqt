package me.aquitano.health.infrastructure.database

import me.aquitano.health.infrastructure.config.DatabaseConfig
import org.jetbrains.exposed.sql.Database
import java.nio.file.Files
import java.nio.file.Path
import java.sql.Connection

class DatabaseFactory(
    private val migrator: FlywayMigrator = FlywayMigrator(),
) {
    fun initialize(config: DatabaseConfig): Database {
        ensureSqliteParentDirectory(config.jdbcUrl)
        Class.forName(config.driver)
        migrator.migrate(config)
        return Database.connect(
            url = config.jdbcUrl,
            driver = config.driver,
            setupConnection = { connection ->
                setupConnection(connection, config.jdbcUrl)
            },
        )
    }

    private fun setupConnection(connection: Connection, jdbcUrl: String) {
        connection.createStatement().use { statement ->
            statement.execute("PRAGMA foreign_keys = ON")
            statement.execute("PRAGMA busy_timeout = 5000")
            if (isFileBackedSqlite(jdbcUrl)) {
                statement.execute("PRAGMA journal_mode = WAL")
                statement.execute("PRAGMA synchronous = NORMAL")
            }
        }
    }

    private fun ensureSqliteParentDirectory(jdbcUrl: String) {
        val prefix = "jdbc:sqlite:"
        if (!jdbcUrl.startsWith(prefix)) return

        val location = jdbcUrl.removePrefix(prefix)
        if (location.isBlank() || location == ":memory:" || location.startsWith(
                "file:"
            )
        ) return

        val parent = Path.of(location).toAbsolutePath().parent ?: return
        Files.createDirectories(parent)
    }

    private fun isFileBackedSqlite(jdbcUrl: String): Boolean {
        val prefix = "jdbc:sqlite:"
        if (!jdbcUrl.startsWith(prefix)) return false

        val location = jdbcUrl.removePrefix(prefix)
        return location.isNotBlank() && location != ":memory:"
    }
}
