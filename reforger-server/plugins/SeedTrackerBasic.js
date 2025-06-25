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
    this.displayCount = 10;
    
    // NEW: Seeding alerts configuration
    this.alertsEnabled = false;
    this.alertChannelId = null;
    this.alertThresholds = {
      critical: 3,    // Alert when <= 3 players
      low: 8         // Alert when <= 8 players
    };
    this.alertCooldown = 30; // Minutes between alerts
    this.alertRoles = []; // Roles to ping
    this.lastAlertTime = new Map(); // Track last alert times by threshold
    
    // State management
    this.lastLeaderboardJson = null;
    this.purgeScheduled = false;
    
    // NEW: Analytics and tracking data
    this.sessionData = new Map(); // Track active sessions
    this.dailyStats = new Map(); // Track daily population data
    
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
      
      if (typeof pluginConfig.displayCount === "number" && pluginConfig.displayCount > 0) {
        this.displayCount = Math.min(pluginConfig.displayCount, 25);
      }

      // Load new player list system
      if (Array.isArray(pluginConfig.playerList)) {
        this.playerList = pluginConfig.playerList
          .slice(0, pluginConfig.playerListLimit || 25)
          .map((id) => id.trim().toLowerCase());
      }
      
      if (pluginConfig.playerListMode === "whitelist" || pluginConfig.playerListMode === "blacklist") {
        this.playerListMode = pluginConfig.playerListMode;
      }
      
      if (typeof pluginConfig.playerListLimit === "number" && pluginConfig.playerListLimit > 0) {
        this.playerListLimit = pluginConfig.playerListLimit;
      }

      this.leaderboardChannelId = pluginConfig.leaderboardChannelId || null;
      this.leaderboardMessageId = pluginConfig.leaderboardMessageId || null;

      // NEW: Load alert configuration
      if (pluginConfig.seedingAlerts) {
        this.alertsEnabled = pluginConfig.seedingAlerts.enabled || false;
        this.alertChannelId = pluginConfig.seedingAlerts.alertChannel || null;
        
        if (pluginConfig.seedingAlerts.thresholds) {
          this.alertThresholds.critical = pluginConfig.seedingAlerts.thresholds.critical || 3;
          this.alertThresholds.low = pluginConfig.seedingAlerts.thresholds.low || 8;
        }
        
        this.alertCooldown = pluginConfig.seedingAlerts.cooldown || 30;
        this.alertRoles = Array.isArray(pluginConfig.seedingAlerts.pingRoles) 
          ? pluginConfig.seedingAlerts.pingRoles 
          : [];
      }

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
      logger.info(`[${this.name}] Leaderboard will display top ${this.displayCount} players`);
    } catch (error) {
      logger.error(`[${this.name}] Error during initialization: ${error.message}`);
    }
  }

  async setupSchema() {
    const createSeederTotalsQuery = `
      CREATE TABLE IF NOT EXISTS seeder_totals (
        playerUID VARCHAR(255) PRIMARY KEY,
        playerName VARCHAR(255),
        totalMinutes INT NOT NULL DEFAULT 0,
        lastSeen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    `;

    // NEW: Streak tracking table
    const createStreaksQuery = `
      CREATE TABLE IF NOT EXISTS seeding_streaks (
        playerUID VARCHAR(255) PRIMARY KEY,
        playerName VARCHAR(255),
        currentStreak INT DEFAULT 0,
        longestStreak INT DEFAULT 0,
        lastSeededDate DATE,
        totalSeedingDays INT DEFAULT 0,
        created TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    `;

    // NEW: Session tracking table
    const createSessionsQuery = `
      CREATE TABLE IF NOT EXISTS seeding_sessions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        playerUID VARCHAR(255),
        playerName VARCHAR(255),
        sessionStart TIMESTAMP,
        sessionEnd TIMESTAMP,
        minutesTracked INT DEFAULT 0,
        averagePlayerCount FLOAT DEFAULT 0,
        peakPlayerCount INT DEFAULT 0,
        seedingEffective BOOLEAN DEFAULT FALSE,
        created TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    `;

    // NEW: Analytics data table
    const createAnalyticsQuery = `
      CREATE TABLE IF NOT EXISTS seeding_analytics (
        id INT AUTO_INCREMENT PRIMARY KEY,
        date DATE,
        hour TINYINT,
        playerCount INT,
        seedingActive BOOLEAN,
        playersTracked INT,
        serverFull BOOLEAN DEFAULT FALSE,
        created TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_date_hour (date, hour)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    `;

    try {
      const connection = await process.mysqlPool.getConnection();
      await connection.query(createSeederTotalsQuery);
      await connection.query(createStreaksQuery);
      await connection.query(createSessionsQuery);
      await connection.query(createAnalyticsQuery);
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

      // Check existing columns for seeder_totals
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

  shouldTrackPlayer(playerUID) {
    const normalizedUID = playerUID.trim().toLowerCase();
    const isInList = this.playerList.includes(normalizedUID);
    
    if (this.playerListMode === "blacklist") {
      return !isInList;
    } else {
      return isInList;
    }
  }

  async trackSeedPlayers() {
    try {
      const players = this.serverInstance?.players;
      if (!Array.isArray(players)) {
        // NEW: Check for seeding alerts even when no players data
        await this.checkSeedingAlerts(0);
        await this.updateLeaderboard();
        return;
      }

      const playerCount = players.length;
      const now = new Date();
      const today = now.toISOString().split('T')[0];
      const currentHour = now.getHours();
      
      // NEW: Record analytics data
      await this.recordAnalytics(today, currentHour, playerCount);
      
      // NEW: Check for seeding alerts (check even when not in seeding range)
      await this.checkSeedingAlerts(playerCount);
      
      // Check if we're in seeding range
      if (playerCount < this.seedStart || playerCount > this.seedEnd) {
        logger.verbose(`[${this.name}] Player count ${playerCount} outside seeding range (${this.seedStart}-${this.seedEnd}), updating leaderboard only.`);
        await this.updateLeaderboard();
        return;
      }

      logger.verbose(`[${this.name}] Tracking ${playerCount} seeding players (${this.playerListMode} mode).`);

      let trackedCount = 0;
      let skippedCount = 0;

      for (const player of players) {
        if (!player?.uid || !player?.name) continue;

        if (!this.shouldTrackPlayer(player.uid)) {
          skippedCount++;
          logger.verbose(`[${this.name}] Skipping player (${this.playerListMode}): ${player.name}`);
          continue;
        }

        try {
          // Update main totals
          await process.mysqlPool.query(this.upsertSQL, [
            player.uid.trim().toLowerCase(),
            player.name,
            this.intervalMinutes
          ]);

          // NEW: Update streak tracking
          await this.updateStreak(player.uid.trim().toLowerCase(), player.name, today);

          // NEW: Track session data
          await this.trackSession(player.uid.trim().toLowerCase(), player.name, playerCount);

          trackedCount++;
        } catch (error) {
          logger.error(`[${this.name}] Error tracking player ${player.name}: ${error.message}`);
        }
      }

      logger.verbose(`[${this.name}] Tracked ${trackedCount} players, skipped ${skippedCount} players`);

      await this.updateLeaderboard();
    } catch (error) {
      logger.error(`[${this.name}] Error in trackSeedPlayers: ${error.message}`);
    }
  }

  // NEW: Check and send seeding alerts
  async checkSeedingAlerts(playerCount) {
    if (!this.alertsEnabled || !this.discordClient || !this.alertChannelId) {
      return;
    }

    const now = Date.now();
    let alertType = null;
    let threshold = 0;

    // Determine alert type based on player count
    if (playerCount <= this.alertThresholds.critical) {
      alertType = 'critical';
      threshold = this.alertThresholds.critical;
    } else if (playerCount <= this.alertThresholds.low) {
      alertType = 'low';
      threshold = this.alertThresholds.low;
    }

    // No alert needed
    if (!alertType) {
      return;
    }

    // Check cooldown
    const lastAlert = this.lastAlertTime.get(alertType);
    const cooldownMs = this.alertCooldown * 60 * 1000;
    
    if (lastAlert && (now - lastAlert) < cooldownMs) {
      logger.verbose(`[${this.name}] Alert for ${alertType} threshold on cooldown`);
      return;
    }

    // Send alert
    await this.sendSeedingAlert(alertType, playerCount, threshold);
    this.lastAlertTime.set(alertType, now);
  }

  async sendSeedingAlert(alertType, playerCount, threshold) {
    try {
      const channel = await this.discordClient.channels.fetch(this.alertChannelId);
      if (!channel || !channel.isTextBased()) {
        logger.warn(`[${this.name}] Alert channel ${this.alertChannelId} not found or not text-based`);
        return;
      }

      // Build role mentions
      let roleMentions = '';
      if (this.alertRoles.length > 0) {
        const mentions = this.alertRoles.map(role => `<@&${role}>`).join(' ');
        roleMentions = `${mentions} `;
      }

      // Get smart recommendations for the alert
      const recommendations = await this.getSmartRecommendations();
      const recommendation = recommendations.find(r => r.type === 'urgent_seeding' || r.type === 'optimal_times');

      const embed = new EmbedBuilder()
        .setTimestamp()
        .setFooter({ text: 'SeedTracker Alerts - ReforgerJS' });

      if (alertType === 'critical') {
        embed
          .setTitle('🚨 CRITICAL: Server Needs Seeding NOW!')
          .setColor(0xff0000)
          .setDescription(
            `${roleMentions}The server is critically low on players!\n\n` +
            `**Current Players:** ${playerCount}/${threshold}\n` +
            `**Status:** Server needs immediate seeding help!\n\n` +
            `This is a **perfect time** to join and earn seeding rewards! 🌱`
          );
      } else {
        embed
          .setTitle('⚠️ Server Population Low')
          .setColor(0xffa500)
          .setDescription(
            `${roleMentions}The server could use some seeders!\n\n` +
            `**Current Players:** ${playerCount}/${threshold}\n` +
            `**Status:** Good opportunity for seeding\n\n` +
            `Join now to help grow the server! 🌱`
          );
      }

      // Add current seeding range info
      embed.addFields({
        name: '📊 Seeding Information',
        value: `**Seeding Range:** ${this.seedStart} - ${this.seedEnd} players\n` +
               `**Tracking:** ${playerCount >= this.seedStart && playerCount <= this.seedEnd ? '✅ Active' : '❌ Inactive'}\n` +
               `**Server:** ${this.config.server?.name || 'Reforger Server'}`,
        inline: false
      });

      // Add recommendation if available
      if (recommendation) {
        embed.addFields({
          name: '💡 Smart Recommendation',
          value: recommendation.description,
          inline: false
        });
      }

      // Add quick server info if available
      const serverFPS = global.serverFPS || 0;
      const serverMemoryMB = global.serverMemoryUsage ? (global.serverMemoryUsage / 1024).toFixed(1) : 0;
      
      if (serverFPS > 0) {
        embed.addFields({
          name: '🖥️ Server Performance',
          value: `**FPS:** ${serverFPS} | **Memory:** ${serverMemoryMB}MB`,
          inline: true
        });
      }

      await channel.send({ embeds: [embed] });
      
      logger.info(`[${this.name}] Sent ${alertType} seeding alert for ${playerCount} players`);
    } catch (error) {
      logger.error(`[${this.name}] Error sending seeding alert: ${error.message}`);
    }
  }

  // NEW: Get current alert status
  async getAlertStatus() {
    const status = {
      enabled: this.alertsEnabled,
      channelId: this.alertChannelId,
      thresholds: this.alertThresholds,
      cooldown: this.alertCooldown,
      roles: this.alertRoles,
      lastAlerts: {}
    };

    // Get cooldown status for each threshold
    const now = Date.now();
    const cooldownMs = this.alertCooldown * 60 * 1000;

    for (const [alertType, lastTime] of this.lastAlertTime.entries()) {
      const timeRemaining = Math.max(0, cooldownMs - (now - lastTime));
      status.lastAlerts[alertType] = {
        lastSent: new Date(lastTime).toLocaleString(),
        onCooldown: timeRemaining > 0,
        cooldownRemaining: Math.ceil(timeRemaining / (60 * 1000)) // minutes
      };
    }

    return status;
  }

  // NEW: Update alert configuration
  async updateAlertConfig(config) {
    const pluginConfig = this.config.plugins.find(p => p.plugin === 'SeedTrackerBasic');
    if (!pluginConfig) {
      return { success: false, message: 'Plugin configuration not found' };
    }

    // Initialize seedingAlerts if it doesn't exist
    if (!pluginConfig.seedingAlerts) {
      pluginConfig.seedingAlerts = {};
    }

    // Update configuration
    if (config.enabled !== undefined) {
      pluginConfig.seedingAlerts.enabled = config.enabled;
      this.alertsEnabled = config.enabled;
    }

    if (config.alertChannel) {
      pluginConfig.seedingAlerts.alertChannel = config.alertChannel;
      this.alertChannelId = config.alertChannel;
    }

    if (config.thresholds) {
      if (!pluginConfig.seedingAlerts.thresholds) {
        pluginConfig.seedingAlerts.thresholds = {};
      }
      
      if (config.thresholds.critical !== undefined) {
        pluginConfig.seedingAlerts.thresholds.critical = config.thresholds.critical;
        this.alertThresholds.critical = config.thresholds.critical;
      }
      
      if (config.thresholds.low !== undefined) {
        pluginConfig.seedingAlerts.thresholds.low = config.thresholds.low;
        this.alertThresholds.low = config.thresholds.low;
      }
    }

    if (config.cooldown !== undefined) {
      pluginConfig.seedingAlerts.cooldown = config.cooldown;
      this.alertCooldown = config.cooldown;
    }

    if (config.pingRoles !== undefined) {
      pluginConfig.seedingAlerts.pingRoles = config.pingRoles;
      this.alertRoles = config.pingRoles;
    }

    return { success: true, message: 'Alert configuration updated' };
  }

  // NEW: Analytics recording
  async recordAnalytics(date, hour, playerCount) {
    try {
      const seedingActive = playerCount >= this.seedStart && playerCount <= this.seedEnd;
      const serverFull = playerCount >= this.seedEnd;
      
      const players = this.serverInstance?.players || [];
      const eligiblePlayers = players.filter(p => p?.uid && this.shouldTrackPlayer(p.uid));
      
      await process.mysqlPool.query(`
        INSERT INTO seeding_analytics (date, hour, playerCount, seedingActive, playersTracked, serverFull)
        VALUES (?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          playerCount = VALUES(playerCount),
          seedingActive = VALUES(seedingActive),
          playersTracked = VALUES(playersTracked),
          serverFull = VALUES(serverFull)
      `, [date, hour, playerCount, seedingActive, eligiblePlayers.length, serverFull]);
    } catch (error) {
      logger.error(`[${this.name}] Error recording analytics: ${error.message}`);
    }
  }

  // NEW: Streak tracking
  async updateStreak(playerUID, playerName, today) {
    try {
      const [rows] = await process.mysqlPool.query(
        'SELECT * FROM seeding_streaks WHERE playerUID = ?',
        [playerUID]
      );

      if (rows.length === 0) {
        // New player
        await process.mysqlPool.query(`
          INSERT INTO seeding_streaks (playerUID, playerName, currentStreak, longestStreak, lastSeededDate, totalSeedingDays)
          VALUES (?, ?, 1, 1, ?, 1)
        `, [playerUID, playerName, today]);
      } else {
        const streak = rows[0];
        const lastDate = streak.lastSeededDate ? new Date(streak.lastSeededDate) : null;
        const todayDate = new Date(today);
        
        let newCurrentStreak = streak.currentStreak;
        let newLongestStreak = streak.longestStreak;
        let newTotalDays = streak.totalSeedingDays;

        if (lastDate) {
          const dayDiff = Math.floor((todayDate - lastDate) / (1000 * 60 * 60 * 24));
          
          if (dayDiff === 0) {
            // Same day, no update needed
            return;
          } else if (dayDiff === 1) {
            // Consecutive day
            newCurrentStreak++;
            newTotalDays++;
            if (newCurrentStreak > newLongestStreak) {
              newLongestStreak = newCurrentStreak;
            }
          } else {
            // Streak broken
            newCurrentStreak = 1;
            newTotalDays++;
          }
        } else {
          newCurrentStreak = 1;
          newTotalDays++;
        }

        await process.mysqlPool.query(`
          UPDATE seeding_streaks 
          SET playerName = ?, currentStreak = ?, longestStreak = ?, lastSeededDate = ?, totalSeedingDays = ?
          WHERE playerUID = ?
        `, [playerName, newCurrentStreak, newLongestStreak, today, newTotalDays, playerUID]);
      }
    } catch (error) {
      logger.error(`[${this.name}] Error updating streak for ${playerName}: ${error.message}`);
    }
  }

  // NEW: Session tracking
  async trackSession(playerUID, playerName, currentPlayerCount) {
    try {
      const sessionKey = `${playerUID}_${new Date().toISOString().split('T')[0]}`;
      
      if (!this.sessionData.has(sessionKey)) {
        // Start new session
        this.sessionData.set(sessionKey, {
          playerUID,
          playerName,
          startTime: new Date(),
          totalMinutes: 0,
          playerCounts: [currentPlayerCount],
          peakPlayerCount: currentPlayerCount
        });
      } else {
        // Update existing session
        const session = this.sessionData.get(sessionKey);
        session.totalMinutes += this.intervalMinutes;
        session.playerCounts.push(currentPlayerCount);
        session.peakPlayerCount = Math.max(session.peakPlayerCount, currentPlayerCount);
      }
    } catch (error) {
      logger.error(`[${this.name}] Error tracking session for ${playerName}: ${error.message}`);
    }
  }

  // NEW: Get streak leaderboard
  async getStreakLeaderboard(limit = 10) {
    try {
      const [rows] = await process.mysqlPool.query(`
        SELECT s.playerName, s.currentStreak, s.longestStreak, s.totalSeedingDays, s.lastSeededDate,
               t.totalMinutes
        FROM seeding_streaks s
        LEFT JOIN seeder_totals t ON s.playerUID = t.playerUID
        WHERE s.lastSeededDate >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
        ORDER BY s.currentStreak DESC, s.longestStreak DESC
        LIMIT ?
      `, [limit]);
      
      return rows;
    } catch (error) {
      logger.error(`[${this.name}] Error getting streak leaderboard: ${error.message}`);
      return [];
    }
  }

  // NEW: Get analytics data
  async getAnalytics(days = 7) {
    try {
      const analytics = {};
      
      // Peak seeding hours
      const [peakHours] = await process.mysqlPool.query(`
        SELECT hour, AVG(playerCount) as avgPlayers, 
               SUM(seedingActive) as seedingHours,
               COUNT(*) as totalHours
        FROM seeding_analytics 
        WHERE date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
        GROUP BY hour
        ORDER BY seedingHours DESC, avgPlayers DESC
        LIMIT 5
      `, [days]);
      
      // Most effective seeders (track success rate)
      const [effectiveSeeders] = await process.mysqlPool.query(`
        SELECT st.playerName, st.totalMinutes,
               COUNT(DISTINCT DATE(sa.created)) as activeDays,
               AVG(sa.playerCount) as avgPlayerCount
        FROM seeder_totals st
        LEFT JOIN seeding_analytics sa ON DATE(st.lastSeen) = sa.date
        WHERE st.lastSeen >= DATE_SUB(NOW(), INTERVAL ? DAY)
        GROUP BY st.playerUID, st.playerName
        HAVING st.totalMinutes > 60
        ORDER BY st.totalMinutes DESC, activeDays DESC
        LIMIT 10
      `, [days]);
      
      // Population trends
      const [trends] = await process.mysqlPool.query(`
        SELECT date, AVG(playerCount) as avgPlayers,
               MAX(playerCount) as peakPlayers,
               SUM(seedingActive) as seedingHours
        FROM seeding_analytics
        WHERE date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
        GROUP BY date
        ORDER BY date DESC
      `, [days]);
      
      // Success rate (seeding that led to fuller server)
      const [successRate] = await process.mysqlPool.query(`
        SELECT 
          SUM(CASE WHEN seedingActive = 1 THEN 1 ELSE 0 END) as totalSeedingHours,
          SUM(CASE WHEN seedingActive = 1 AND 
            (SELECT AVG(playerCount) FROM seeding_analytics sa2 
             WHERE sa2.date = seeding_analytics.date 
             AND sa2.hour BETWEEN seeding_analytics.hour AND seeding_analytics.hour + 2) > ? 
            THEN 1 ELSE 0 END) as successfulSeedingHours
        FROM seeding_analytics
        WHERE date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      `, [this.seedEnd, days]);

      analytics.peakHours = peakHours;
      analytics.effectiveSeeders = effectiveSeeders;
      analytics.trends = trends;
      analytics.successRate = successRate[0] || { totalSeedingHours: 0, successfulSeedingHours: 0 };
      
      return analytics;
    } catch (error) {
      logger.error(`[${this.name}] Error getting analytics: ${error.message}`);
      return null;
    }
  }

  // NEW: Smart recommendations
  async getSmartRecommendations() {
    try {
      const recommendations = [];
      const now = new Date();
      const currentHour = now.getHours();
      const currentDay = now.getDay(); // 0 = Sunday, 1 = Monday, etc.
      
      // Get historical data for this hour/day combination
      const [hourlyData] = await process.mysqlPool.query(`
        SELECT hour, AVG(playerCount) as avgPlayers,
               SUM(seedingActive) / COUNT(*) as seedingSuccessRate,
               COUNT(*) as dataPoints
        FROM seeding_analytics
        WHERE DAYOFWEEK(date) = ? AND date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
        GROUP BY hour
        ORDER BY hour
      `, [currentDay + 1]); // MySQL DAYOFWEEK starts at 1 for Sunday

      // Find optimal seeding windows
      const optimalHours = hourlyData
        .filter(h => h.seedingSuccessRate > 0.3 && h.avgPlayers < this.seedEnd)
        .sort((a, b) => b.seedingSuccessRate - a.seedingSuccessRate)
        .slice(0, 3);

      if (optimalHours.length > 0) {
        recommendations.push({
          type: 'optimal_times',
          title: 'Best Seeding Hours Today',
          description: `Based on historical data, seeding is most effective at: ${optimalHours.map(h => `${h.hour}:00`).join(', ')}`,
          confidence: 'high'
        });
      }

      // Current situation analysis
      const currentPlayers = this.serverInstance?.players?.length || 0;
      
      if (currentPlayers < this.seedStart) {
        recommendations.push({
          type: 'urgent_seeding',
          title: 'Server Needs Seeding Now!',
          description: `Only ${currentPlayers} players online. This is a great time to seed and earn bonus time.`,
          confidence: 'high'
        });
      } else if (currentPlayers >= this.seedStart && currentPlayers <= this.seedEnd) {
        recommendations.push({
          type: 'active_seeding',
          title: 'Seeding Active',
          description: `Server is in seeding range (${currentPlayers} players). Keep it going!`,
          confidence: 'high'
        });
      }

      // Predict if seeding will be effective
      const [recentTrend] = await process.mysqlPool.query(`
        SELECT AVG(playerCount) as avgRecent
        FROM seeding_analytics
        WHERE date = CURDATE() AND hour >= ? - 2
      `, [Math.max(0, currentHour - 2)]);

      if (recentTrend[0] && recentTrend[0].avgRecent > 0) {
        const trend = recentTrend[0].avgRecent;
        if (trend < currentPlayers) {
          recommendations.push({
            type: 'positive_trend',
            title: 'Growing Server Population',
            description: `Player count is trending upward. Great time to seed!`,
            confidence: 'medium'
          });
        }
      }

      return recommendations;
    } catch (error) {
      logger.error(`[${this.name}] Error getting smart recommendations: ${error.message}`);
      return [];
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
        LIMIT ?;
        `,
        [this.lookbackDays, this.displayCount]
      );

      if (!rows || rows.length === 0) return;

      // Check if leaderboard data changed
      const newJson = JSON.stringify(
        rows.map(r => ({ n: r.playerName, t: r.totalMinutes }))
      );
      if (newJson === this.lastLeaderboardJson) return;
      this.lastLeaderboardJson = newJson;

      const embed = new EmbedBuilder()
        .setTitle(`🏆 Top ${this.displayCount} Seeders (Last ${this.lookbackDays} Days)`)
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

      const channel = await this.discordClient.channels.fetch(this.leaderboardChannelId);
      if (!channel || !channel.isTextBased()) {
        logger.warn(`[${this.name}] Cannot find text channel with ID ${this.leaderboardChannelId}`);
        return;
      }

      if (!this.leaderboardMessageId) {
        const sent = await channel.send({ embeds: [embed] });
        this.leaderboardMessageId = sent.id;
        logger.info(`[${this.name}] Posted new leaderboard message: ${sent.id}`);
      } else {
        try {
          const msg = await channel.messages.fetch(this.leaderboardMessageId);
          await msg.edit({ embeds: [embed] });
          logger.verbose(`[${this.name}] Updated leaderboard message.`);
        } catch (editError) {
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
      0, 5, 0
    );
    const msUntilNext = nextPurge - now;

    setTimeout(async () => {
      await this.purgeOldEntries();
      setInterval(() => this.purgeOldEntries(), 24 * 60 * 60 * 1000);
    }, msUntilNext);

    logger.info(`[${this.name}] Scheduled daily purge at 00:05 (${msUntilNext}ms from now).`);
  }

  async purgeOldEntries() {
    try {
      const connection = await process.mysqlPool.getConnection();
      
      // Purge old seeder totals
      const [result1] = await connection.query(
        `DELETE FROM seeder_totals WHERE lastSeen < NOW() - INTERVAL ? DAY`,
        [this.purgeDays]
      );

      // Purge old analytics data (keep 90 days)
      const [result2] = await connection.query(
        `DELETE FROM seeding_analytics WHERE date < DATE_SUB(CURDATE(), INTERVAL 90 DAY)`
      );

      // Purge old sessions (keep 60 days)
      const [result3] = await connection.query(
        `DELETE FROM seeding_sessions WHERE created < NOW() - INTERVAL 60 DAY`
      );

      connection.release();

      const totalPurged = result1.affectedRows + result2.affectedRows + result3.affectedRows;
      if (totalPurged > 0) {
        logger.info(`[${this.name}] Purged ${totalPurged} old entries from seeding tables.`);
      }
    } catch (error) {
      logger.error(`[${this.name}] Error purging old entries: ${error.message}`);
    }
  }

  async addPlayerToList(playerUID) {
    const normalizedUID = playerUID.toLowerCase();
    
    if (this.playerList.includes(normalizedUID)) {
      return { success: false, message: `Player already in ${this.playerListMode}` };
    }
    
    if (this.playerList.length >= this.playerListLimit) {
      return { success: false, message: `${this.playerListMode} is full (${this.playerListLimit} max)` };
    }
    
    this.playerList.push(normalizedUID);
    
    const pluginConfig = this.config.plugins.find(p => p.plugin === 'SeedTrackerBasic');
    if (pluginConfig) {
      pluginConfig.playerList = this.playerList;
    }
    
    return { success: true, message: `Player added to ${this.playerListMode}` };
  }

  async removePlayerFromList(playerUID) {
    const normalizedUID = playerUID.toLowerCase();
    const index = this.playerList.indexOf(normalizedUID);
    
    if (index === -1) {
      return { success: false, message: `Player not in ${this.playerListMode}` };
    }
    
    this.playerList.splice(index, 1);
    
    const pluginConfig = this.config.plugins.find(p => p.plugin === 'SeedTrackerBasic');
    if (pluginConfig) {
      pluginConfig.playerList = this.playerList;
    }
    
    return { success: true, message: `Player removed from ${this.playerListMode}` };
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
    this.sessionData.clear();
    this.dailyStats.clear();
    
    if (process.seedTracker === this) {
      process.seedTracker = null;
    }
    
    logger.info(`[${this.name}] Cleanup completed.`);
  }
}

module.exports = SeedTrackerBasic;