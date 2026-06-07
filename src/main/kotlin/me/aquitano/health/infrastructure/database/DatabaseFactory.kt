package me.aquitano.health.infrastructure.database

import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import me.aquitano.health.infrastructure.config.DatabaseConfig as AppDatabaseConfig
import me.aquitano.health.infrastructure.logging.Slf4jSqlLogger
import org.jetbrains.exposed.v1.jdbc.Database
import org.jetbrains.exposed.v1.core.DatabaseConfig

class DatabaseFactory(
    private val migrator: FlywayMigrator = FlywayMigrator(),
) : AutoCloseable {
    private var dataSource: HikariDataSource? = null

    fun initialize(config: AppDatabaseConfig): Database {
        Class.forName(config.driver)
        migrator.migrate(config)

        val hikariConfig = HikariConfig().apply {
            jdbcUrl = config.jdbcUrl
            username = config.user
            password = config.password
            maximumPoolSize = config.maxPoolSize
            isAutoCommit = false
            transactionIsolation = "TRANSACTION_READ_COMMITTED"
        }
        close()
        val newDataSource = HikariDataSource(hikariConfig)
        dataSource = newDataSource
        
        val dbConfig = DatabaseConfig {
            sqlLogger = Slf4jSqlLogger
        }
        return Database.connect(newDataSource, databaseConfig = dbConfig)
    }

    override fun close() {
        dataSource?.close()
        dataSource = null
    }
}
