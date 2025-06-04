// reforger-server/plugins/SeedTrackerBasic.js

const path = require('path');
const mysql = require('mysql2/promise');
const { EmbedBuilder } = require('discord.js');

// Load the main config.json
const configPath = path.resolve(__dirname, '../../config.json');
let config;
try {
  config = require(configPath);
} catch (err) {
  console.error(`[SeedTracker] Could not load config.json at ${configPath}:`, err);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) Immediately set up the MySQL database & connection pool (using config.database)
// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  const mysqlCfg = config.connectors?.mysql;
  if (!mysqlCfg || !mysqlCfg.enabled) {
    console.error('[SeedTracker] MySQL connector is not enabled or missing in config.json.');
    process.exit(1);
  }

  const host       = mysqlCfg.host || 'localhost';
  const port       = mysqlCfg.port || 3306;
  const password   = mysqlCfg.password;
  const user       = mysqlCfg.user || mysqlCfg.username;
  const socketPath = mysqlCfg.socketPath || null;
  const dbName     = mysqlCfg.database;

  if (!user || !password || !dbName) {
    console.error('[SeedTracker] MySQL credentials or database name missing in config.json:');
    console.error(`  connectors.mysql.user/username: "${user}"`);
    console.error(`  connectors.mysql.password:   "${password}"`);
    console.error(`  connectors.mysql.database:   "${dbName}"`);
    console.error('Please supply user (or username), password, and database name, then restart.');
    process.exit(1);
  }

  console.log('[SeedTracker] Connecting to MySQL with:', {
    host,
    port,
    user,
    password: '<redacted>',
    socketPath,
    database: dbName
  });

  let initConn;
  try {
    if (socketPath) {
      console.log(`[SeedTracker] Attempting socket connection via "${socketPath}"…`);
      initConn = await mysql.createConnection({ user, password, socketPath });
      console.log('→ [SeedTracker] Connected via UNIX socket!');
    } else {
      console.log(`[SeedTracker] Attempting TCP connection to ${host}:${port}…`);
      initConn = await mysql.createConnection({ host, port, user, password });
      console.log('→ [SeedTracker] Connected via TCP!');
    }
  } catch (err) {
    console.error('→ [SeedTracker] FAILED to connect to MySQL:', err);
    process.exit(1);
  }

  try {
    await initConn.query(
      `CREATE DATABASE IF NOT EXISTS \`${dbName}\`
         CHARACTER SET utf8mb4
         COLLATE utf8mb4_unicode_ci;`
    );
    console.log(`[SeedTracker] ✔ Ensured database "${dbName}" exists.`);
  } catch (err) {
    console.error(`[SeedTracker] FAILED to create/verify database "${dbName}":`, err);
    process.exit(1);
  }

  await initConn.end();

  try {
    process.mysqlPool = mysql.createPool({
      host,
      user,
      password,
      port,
      database: dbName,
      socketPath,
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0,
      charset: 'utf8mb4_unicode_ci'
    });
    console.log(`[SeedTracker] ✔ process.mysqlPool → connected to database "${dbName}".`);
  } catch (poolErr) {
    console.error('[SeedTracker] FAILED to create mysqlPool:', poolErr);
    process.exit(1);
  }
})();

// ─────────────────────────────────────────────────────────────────────────────
// 2) The SeedTrackerBasic plugin class
// ─────────────────────────────────────────────────────────────────────────────
class SeedTrackerBasic {
  constructor(config) {
    this.config = config;
    this.name = 'SeedTrackerBasic Plugin';
    this.interval = null;

    // Defaults (overridden by pluginConfig in prepareToMount):
    this.intervalMinutes      = 15;
    this.seedStart            = 5;
    this.seedEnd              = 40;
    this.ignoreList           = [];
    this.leaderboardChannelId = null;
    this.leaderboardMessageId = null;
    this.lookbackDays         = 30;
    this.purgeDays            = 45;

    this.serverInstance = null;
    this.discordClient  = null;

    this.purgeScheduled       = false;
    this.upsertSQL            = `
      INSERT INTO seeder_totals (playerUID, playerName, totalMinutes)
      VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE
        playerName = VALUES(playerName),
        totalMinutes = totalMinutes + VALUES(totalMinutes);
    `;
    this.lastLeaderboardJson  = null;
  }

  /**
   * Called by mountPlugins(..., serverInstance, discordClient).
   */
  async prepareToMount(serverInstance, discordClient) {
    await this.cleanup();
    this.serverInstance = serverInstance;
    this.discordClient  = discordClient;

    try {
      if (!this.config.connectors?.mysql?.enabled || !process.mysqlPool) {
        console.warn(`[${this.name}] MySQL not enabled or pool missing. Aborting plugin.`);
        return;
      }

      // 1) Load everything from pluginConfig
      const pluginConfig = this.config.plugins.find(
        (p) => p.plugin === 'SeedTrackerBasic'
      );
      if (!pluginConfig) {
        console.warn(`[${this.name}] No "SeedTrackerBasic" entry under config.plugins.`);
        return;
      }

      if (typeof pluginConfig.interval === 'number' && pluginConfig.interval > 0) {
        this.intervalMinutes = pluginConfig.interval;
      }
      if (typeof pluginConfig.seedStart === 'number') {
        this.seedStart = pluginConfig.seedStart;
      }
      if (typeof pluginConfig.seedEnd === 'number') {
        this.seedEnd = pluginConfig.seedEnd;
      }

      // Normalize and load up to 10 ignore UIDs
      if (Array.isArray(pluginConfig.seedIgnore)) {
        this.ignoreList = pluginConfig.seedIgnore
          .slice(0, 10)
          .map((id) => id.trim().toLowerCase());
      } else {
        this.ignoreList = [];
      }

      this.leaderboardChannelId = pluginConfig.leaderboardChannelId || null;
      this.leaderboardMessageId = pluginConfig.leaderboardMessageId || null;

      if (typeof pluginConfig.lookbackDays === 'number' && pluginConfig.lookbackDays > 0) {
        this.lookbackDays = pluginConfig.lookbackDays;
      }
      if (typeof pluginConfig.purgeDays === 'number' && pluginConfig.purgeDays > 0) {
        this.purgeDays = pluginConfig.purgeDays;
      }

      // 2) Ensure seeder_totals (with lastSeen) exists
      await this.ensureTotalsTable();

      // 3) Schedule daily purge at 00:05
      this.scheduleDailyPurge();

      // 4) Start the periodic tracking loop
      this.startTracking();

      console.info(`[${this.name}] Initialized successfully.`);

      // Expose this instance so ignore/unignore commands can update at runtime
      process.seedTracker = this;
    } catch (e) {
      console.error(`[${this.name}] Error during initialization: ${e.message}`);
    }
  }

  /**
   * Ensures that `seeder_totals` exists with columns:
   *   • playerUID VARCHAR(255) PRIMARY KEY
   *   • playerName VARCHAR(255)
   *   • totalMinutes INT NOT NULL DEFAULT 0
   *   • lastSeen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
   *
   * If missing entirely, create it. If lastSeen is missing, add it.
   */
  async ensureTotalsTable() {
    try {
      const conn = await process.mysqlPool.getConnection();

      // (a) Check if table exists
      const [tables] = await conn.query(`
        SELECT TABLE_NAME
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'seeder_totals';
      `);

      if (tables.length === 0) {
        // Create with all four columns
        const createSQL = `
          CREATE TABLE seeder_totals (
            playerUID VARCHAR(255) PRIMARY KEY,
            playerName VARCHAR(255),
            totalMinutes INT NOT NULL DEFAULT 0,
            lastSeen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
          ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
        `;
        await conn.query(createSQL);
        console.debug(`[${this.name}] Created "seeder_totals" with all required columns.`);
        conn.release();
        return;
      }

      // (b) If table exists, check if lastSeen is missing
      const [cols] = await conn.query(`
        SELECT COLUMN_NAME
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'seeder_totals'
          AND COLUMN_NAME = 'lastSeen';
      `);

      if (cols.length === 0) {
        // Add lastSeen column
        await conn.query(`
          ALTER TABLE seeder_totals
          ADD COLUMN lastSeen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
        `);
        console.debug(`[${this.name}] Added missing column "lastSeen" to seeder_totals.`);
      }

      conn.release();
    } catch (err) {
      console.error(`[${this.name}] Error ensuring seeder_totals table: ${err.message}`);
    }
  }

  scheduleDailyPurge() {
    if (this.purgeScheduled) return;
    this.purgeScheduled = true;

    const now          = new Date();
    const nextPurgetime = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
      0,  // 00:00 hours
      5,  // 00:05 minutes
      0   // 00 seconds
    );
    const msUntilNext  = nextPurgetime - now;

    setTimeout(async () => {
      await this.purgeOldEntries();
      setInterval(() => this.purgeOldEntries(), 24 * 60 * 60 * 1000);
    }, msUntilNext);
  }

  async purgeOldEntries() {
    try {
      const conn = await process.mysqlPool.getConnection();
      const [result] = await conn.query(
        `
        DELETE FROM seeder_totals
        WHERE lastSeen < NOW() - INTERVAL ? DAY;
        `,
        [ this.purgeDays ]
      );
      console.debug(`[${this.name}] Purged ${result.affectedRows} totals older than ${this.purgeDays} days.`);
      conn.release();
    } catch (err) {
      console.error(`[${this.name}] Error purging old seeder_totals: ${err.message}`);
    }
  }

  startTracking() {
    const intervalMs = this.intervalMinutes * 60 * 1000;

    // Run once immediately
    this.trackSeedPlayers().catch((e) =>
      console.error(`[${this.name}] Error in initial track:`, e)
    );

    // Then repeat every intervalMinutes
    this.interval = setInterval(
      () => this.trackSeedPlayers().catch((e) => console.error(e)),
      intervalMs
    );
    console.debug(`[${this.name}] Tracking started: every ${this.intervalMinutes} minutes.`);
  }

  async trackSeedPlayers() {
    const players = this.serverInstance?.players;
    if (!Array.isArray(players)) {
      // No players array → just update leaderboard
      await this.postOrEditLeaderboard();
      return;
    }

    if (players.length < this.seedStart || players.length > this.seedEnd) {
      // Outside seeding range → just update leaderboard
      await this.postOrEditLeaderboard();
      return;
    }

    // Within seeding range → UPSERT each non-ignored player
    for (const player of players) {
      if (!player?.uid || !player?.name) continue;

      // Normalize incoming UID
      const uid = player.uid.trim().toLowerCase();

      // Debug logging
      //console.debug(
      //  `[${this.name}] Checking player "${player.name}" (UID=${uid}) → ignored? ${this.ignoreList.includes(uid)}`
     // );

      if (this.ignoreList.includes(uid)) {
        // Skip this player
        continue;
      }

      try {
        // UPSERT totalMinutes
        await process.mysqlPool.query(this.upsertSQL, [
          uid,
          player.name,
          this.intervalMinutes
        ]);
        // Update lastSeen
        await process.mysqlPool.query(
          `UPDATE seeder_totals
           SET lastSeen = CURRENT_TIMESTAMP
           WHERE playerUID = ?;`,
          [uid]
        );
      } catch (err) {
        console.error(`[${this.name}] Error UPSERTing ${player.name}: ${err.message}`);
      }
    }

    // After UPSERTs, update leaderboard if changed
    await this.postOrEditLeaderboard();
  }

  async postOrEditLeaderboard() {
    if (!this.discordClient || !this.leaderboardChannelId) return;

    let rows;
    try {
      [rows] = await process.mysqlPool.query(
        `
        SELECT playerName, totalMinutes
        FROM seeder_totals
        WHERE lastSeen >= NOW() - INTERVAL ? DAY
        ORDER BY totalMinutes DESC
        LIMIT 10;
        `,
        [ this.lookbackDays ]
      );
    } catch (err) {
      console.error(`[${this.name}] Error fetching leaderboard: ${err.message}`);
      return;
    }

    if (!rows || rows.length === 0) return;

    const newJson = JSON.stringify(
      rows.map(r => ({ n: r.playerName, t: r.totalMinutes }))
    );
    if (newJson === this.lastLeaderboardJson) return;
    this.lastLeaderboardJson = newJson;

    // Build the embed
    const embed = new EmbedBuilder()
      .setTitle(`🏆 Top 10 Seeders (Last ${this.lookbackDays} Days)`)
      .setColor(0x00ae86)
      .setTimestamp();

    rows.forEach((row, idx) => {
      const hours = (row.totalMinutes / 60).toFixed(2);
      embed.addFields({
        name: `${idx + 1}. ${row.playerName}`,
        value: `${hours} hours (${row.totalMinutes} minutes)`
      });
    });

    try {
      const channel = await this.discordClient.channels.fetch(this.leaderboardChannelId);
      if (!channel || !channel.isTextBased()) {
        console.warn(`[${this.name}] Cannot find text channel with ID ${this.leaderboardChannelId}`);
        return;
      }

      if (!this.leaderboardMessageId) {
        // Send a new message if none exists
        const sent = await channel.send({ embeds: [embed] });
        this.leaderboardMessageId = sent.id;
      } else {
        // Try to edit the existing message
        try {
          const msg = await channel.messages.fetch(this.leaderboardMessageId);
          await msg.edit({ embeds: [embed] });
        } catch {
          // If edit fails, send a new one
          const sent = await channel.send({ embeds: [embed] });
          this.leaderboardMessageId = sent.id;
        }
      }
    } catch (err) {
      console.error(`[${this.name}] Failed to post/edit leaderboard: ${err.message}`);
    }
  }

  async cleanup() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.serverInstance = null;
    this.discordClient  = null;
  }
}

module.exports = SeedTrackerBasic;
