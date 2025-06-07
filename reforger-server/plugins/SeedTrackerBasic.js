const mysql = require("mysql2/promise");
const { EmbedBuilder } = require("discord.js");

class SeedTrackerBasic {
  constructor(config) {
    this.config = config;
    this.name = "SeedTrackerBasic Plugin";
    this.interval = null;
    this.isInitialized = false;
    this.serverInstance = null;
    this.discordClient = null;
    
    // Configuration defaults
    this.intervalMinutes = 15;
    this.seedStart = 5;
    this.seedEnd = 40;
    
    // Updated ignore system
    this.playerList = []; // List of UUIDs
    this.playerListMode = "blacklist"; // "blacklist" or "whitelist"
    this.playerListLimit = 25; // Max number of UUIDs allowed
    
    this.leaderboardChannelId = null;
    this.leaderboardMessageId = null;
    this.lookbackDays = 30;
    this.purgeDays = 45;
    
    // State management
    this.lastLeaderboardJson = null;
    this.purgeScheduled = false;
    
    // SQL queries
    this.upsertSQL = `
      INSERT INTO seeder_totals (playerUID, playerName, totalMinutes, lastSeen)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON DUPLICATE KEY UPDATE
        playerName = VALUES(playerName),
        totalMinutes = totalMinutes + VALUES(totalMinutes),
        lastSeen = CURRENT_TIMESTAMP;
    `;
  }

  async prepareToMount(serverInstance, discordClient) {
    await this.cleanup();
    this.serverInstance = serverInstance;
    this.discordClient = discordClient;

    try {
      // Check if MySQL is enabled and available
      if (
        !this.config.connectors ||
        !this.config.connectors.mysql ||
        !this.config.connectors.mysql.enabled
      ) {
        logger.warn(`[${this.name}] MySQL is not enabled in the configuration. Plugin will be disabled.`);
        return;
      }

      if (!process.mysqlPool) {
        logger.error(`[${this.name}] MySQL pool is not available. Ensure MySQL is connected before enabling this plugin.`);
        return;
      }

      // Load plugin configuration
      const pluginConfig = this.config.plugins.find(
        (plugin) => plugin.plugin === "SeedTrackerBasic"
      );
      if (!pluginConfig) {
        logger.warn(`[${this.name}] Plugin configuration not found. Plugin disabled.`);
        return;
      }

      // Load configuration values
      if (typeof pluginConfig.interval === "number" && pluginConfig.interval > 0) {
        this.intervalMinutes = pluginConfig.interval;
      }
      if (typeof pluginConfig.seedStart === "number") {
        this.seedStart = pluginConfig.seedStart;
      }
      if (typeof pluginConfig.seedEnd === "number") {
        this.seedEnd = pluginConfig.seedEnd;
      }
      if (typeof pluginConfig.lookbackDays === "number" && pluginConfig.lookbackDays > 0) {
        this.lookbackDays = pluginConfig.lookbackDays;
      }
      if (typeof pluginConfig.purgeDays === "number" && pluginConfig.purgeDays > 0) {
        this.purgeDays = pluginConfig.purgeDays;
      }

      // Load new player list system
      if (Array.isArray(pluginConfig.playerList)) {
        this.playerList = pluginConfig.playerList
          .slice(0, pluginConfig.playerListLimit || 25)
          .map((id) => id.trim().toLowerCase());
      }
      
      // Load player list mode
      if (pluginConfig.playerListMode === "whitelist" || pluginConfig.playerListMode === "blacklist") {
        this.playerListMode = pluginConfig.playerListMode;
      }
      
      // Load player list limit
      if (typeof pluginConfig.playerListLimit === "number" && pluginConfig.playerListLimit > 0) {
        this.playerListLimit = pluginConfig.playerListLimit;
      }

      this.leaderboardChannelId = pluginConfig.leaderboardChannelId || null;
      this.leaderboardMessageId = pluginConfig.leaderboardMessageId || null;

      // Setup database schema
      await this.setupSchema();
      await this.migrateSchema();

      // Schedule daily purge
      this.scheduleDailyPurge();

      // Start tracking
      this.startTracking();

      // Expose instance for command access
      process.seedTracker = this;

      this.isInitialized = true;
      logger.info(`[${this.name}] Initialized successfully with ${this.intervalMinutes}min intervals, seeding range ${this.seedStart}-${this.seedEnd} players.`);
      logger.info(`[${this.name}] Player list mode: ${this.playerListMode}, limit: ${this.playerListLimit}, current entries: ${this.playerList.length}`);
    } catch (error) {
      logger.error(`[${this.name}] Error during initialization: ${error.message}`);
    }
  }

  async setupSchema() {
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS seeder_totals (
        playerUID VARCHAR(255) PRIMARY KEY,
        playerName VARCHAR(255),
        totalMinutes INT NOT NULL DEFAULT 0,
        lastSeen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    `;

    try {
      const connection = await process.mysqlPool.getConnection();
      await connection.query(createTableQuery);
      connection.release();
      logger.verbose(`[${this.name}] Database schema setup complete.`);
    } catch (error) {
      logger.error(`[${this.name}] Error setting up database schema: ${error.message}`);
      throw error;
    }
  }

  async migrateSchema() {
    try {
      const connection = await process.mysqlPool.getConnection();

      // Check if lastSeen column exists
      const [columns] = await connection.query(`
        SELECT COLUMN_NAME 
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = 'seeder_totals'
      `);

      const columnNames = columns.map((col) => col.COLUMN_NAME);
      const alterQueries = [];

      if (!columnNames.includes("lastSeen")) {
        alterQueries.push("ADD COLUMN lastSeen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP");
      }

      // Check table collation
      const [tableResult] = await connection.query(`
        SELECT TABLE_COLLATION 
        FROM information_schema.TABLES 
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'seeder_totals'
      `);

      if (
        tableResult.length > 0 &&
        !tableResult[0].TABLE_COLLATION.startsWith("utf8mb4")
      ) {
        alterQueries.push("CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
      }

      if (alterQueries.length > 0) {
        const alterQuery = `ALTER TABLE seeder_totals ${alterQueries.join(", ")}`;
        await connection.query(alterQuery);
        logger.info(`[${this.name}] Migrated seeder_totals table: ${alterQueries.join(", ")}`);
      }

      connection.release();
    } catch (error) {
      logger.error(`[${this.name}] Error migrating schema: ${error.message}`);
      throw error;
    }
  }

  startTracking() {
    const intervalMs = this.intervalMinutes * 60 * 1000;

    // Clear existing interval if any
    if (this.interval) {
      clearInterval(this.interval);
    }

    // Run once immediately
    this.trackSeedPlayers();

    // Then repeat on interval
    this.interval = setInterval(() => this.trackSeedPlayers(), intervalMs);
    logger.verbose(`[${this.name}] Started tracking every ${this.intervalMinutes} minutes.`);
  }

  // Updated method to check if player should be tracked
  shouldTrackPlayer(playerUID) {
    const normalizedUID = playerUID.trim().toLowerCase();
    const isInList = this.playerList.includes(normalizedUID);
    
    if (this.playerListMode === "blacklist") {
      // Blacklist mode: track player if they are NOT in the list
      return !isInList;
    } else {
      // Whitelist mode: track player if they ARE in the list
      return isInList;
    }
  }

  async trackSeedPlayers() {
    try {
      const players = this.serverInstance?.players;
      if (!Array.isArray(players)) {
        // Update leaderboard even if no players
        await this.updateLeaderboard();
        return;
      }

      const playerCount = players.length;
      
      // Check if we're in seeding range
      if (playerCount < this.seedStart || playerCount > this.seedEnd) {
        logger.verbose(`[${this.name}] Player count ${playerCount} outside seeding range (${this.seedStart}-${this.seedEnd}), updating leaderboard only.`);
        await this.updateLeaderboard();
        return;
      }

      logger.verbose(`[${this.name}] Tracking ${playerCount} seeding players (${this.playerListMode} mode).`);

      // Process each eligible player
      let trackedCount = 0;
      let skippedCount = 0;

      for (const player of players) {
        if (!player?.uid || !player?.name) continue;

        // Check if player should be tracked based on blacklist/whitelist
        if (!this.shouldTrackPlayer(player.uid)) {
          skippedCount++;
          logger.verbose(`[${this.name}] Skipping player (${this.playerListMode}): ${player.name}`);
          continue;
        }

        try {
          await process.mysqlPool.query(this.upsertSQL, [
            player.uid.trim().toLowerCase(),
            player.name,
            this.intervalMinutes
          ]);
          trackedCount++;
        } catch (error) {
          logger.error(`[${this.name}] Error tracking player ${player.name}: ${error.message}`);
        }
      }

      logger.verbose(`[${this.name}] Tracked ${trackedCount} players, skipped ${skippedCount} players`);

      // Update leaderboard after tracking
      await this.updateLeaderboard();
    } catch (error) {
      logger.error(`[${this.name}] Error in trackSeedPlayers: ${error.message}`);
    }
  }

  async updateLeaderboard() {
    if (!this.discordClient || !this.leaderboardChannelId) return;

    try {
      const [rows] = await process.mysqlPool.query(
        `
        SELECT playerName, totalMinutes
        FROM seeder_totals
        WHERE lastSeen >= NOW() - INTERVAL ? DAY
        ORDER BY totalMinutes DESC
        LIMIT 10;
        `,
        [this.lookbackDays]
      );

      if (!rows || rows.length === 0) return;

      // Check if leaderboard data changed
      const newJson = JSON.stringify(
        rows.map(r => ({ n: r.playerName, t: r.totalMinutes }))
      );
      if (newJson === this.lastLeaderboardJson) return;
      this.lastLeaderboardJson = newJson;

      // Build embed
      const embed = new EmbedBuilder()
        .setTitle(`🏆 Top 10 Seeders (Last ${this.lookbackDays} Days)`)
        .setColor(0x00ae86)
        .setTimestamp();

      rows.forEach((row, idx) => {
        const hours = (row.totalMinutes / 60).toFixed(2);
        embed.addFields({
          name: `${idx + 1}. ${row.playerName}`,
          value: `${hours} hours (${row.totalMinutes} minutes)`,
          inline: false
        });
      });

      // Send or update message
      const channel = await this.discordClient.channels.fetch(this.leaderboardChannelId);
      if (!channel || !channel.isTextBased()) {
        logger.warn(`[${this.name}] Cannot find text channel with ID ${this.leaderboardChannelId}`);
        return;
      }

      if (!this.leaderboardMessageId) {
        // Send new message
        const sent = await channel.send({ embeds: [embed] });
        this.leaderboardMessageId = sent.id;
        logger.info(`[${this.name}] Posted new leaderboard message: ${sent.id}`);
      } else {
        // Try to edit existing message
        try {
          const msg = await channel.messages.fetch(this.leaderboardMessageId);
          await msg.edit({ embeds: [embed] });
          logger.verbose(`[${this.name}] Updated leaderboard message.`);
        } catch (editError) {
          // If edit fails, send new message
          const sent = await channel.send({ embeds: [embed] });
          this.leaderboardMessageId = sent.id;
          logger.info(`[${this.name}] Failed to edit message, posted new one: ${sent.id}`);
        }
      }
    } catch (error) {
      logger.error(`[${this.name}] Error updating leaderboard: ${error.message}`);
    }
  }

  scheduleDailyPurge() {
    if (this.purgeScheduled) return;
    this.purgeScheduled = true;

    const now = new Date();
    const nextPurge = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
      0, // 00:00 hours
      5, // 00:05 minutes
      0  // 00 seconds
    );
    const msUntilNext = nextPurge - now;

    setTimeout(async () => {
      await this.purgeOldEntries();
      // Schedule daily purge
      setInterval(() => this.purgeOldEntries(), 24 * 60 * 60 * 1000);
    }, msUntilNext);

    logger.info(`[${this.name}] Scheduled daily purge at 00:05 (${msUntilNext}ms from now).`);
  }

  async purgeOldEntries() {
    try {
      const connection = await process.mysqlPool.getConnection();
      const [result] = await connection.query(
        `DELETE FROM seeder_totals WHERE lastSeen < NOW() - INTERVAL ? DAY`,
        [this.purgeDays]
      );
      connection.release();

      if (result.affectedRows > 0) {
        logger.info(`[${this.name}] Purged ${result.affectedRows} entries older than ${this.purgeDays} days.`);
      } else {
        logger.verbose(`[${this.name}] No entries to purge.`);
      }
    } catch (error) {
      logger.error(`[${this.name}] Error purging old entries: ${error.message}`);
    }
  }

  async cleanup() {
    logger.verbose(`[${this.name}] Cleaning up...`);
    
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    
    this.serverInstance = null;
    this.discordClient = null;
    this.isInitialized = false;
    
    // Clear global reference
    if (process.seedTracker === this) {
      process.seedTracker = null;
    }
    
    logger.info(`[${this.name}] Cleanup completed.`);
  }
}

module.exports = SeedTrackerBasic;