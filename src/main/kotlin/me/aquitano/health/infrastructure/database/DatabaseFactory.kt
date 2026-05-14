package me.aquitano.health.infrastructure.database

import me.aquitano.health.infrastructure.config.DatabaseConfig
import org.jetbrains.exposed.sql.Database
import java.sql.Connection
import java.nio.file.Files
import java.nio.file.Path

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
            setupConnection = ::setupConnection,
        )
    }

    private fun setupConnection(connection: Connection) {
        connection.createStatement().use { statement ->
            statement.execute("PRAGMA foreign_keys = ON")
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
}
