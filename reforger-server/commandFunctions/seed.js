// reforger-server/commandFunctions/seed.js

const { EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');

module.exports = async (interaction, serverInstance, discordClient, extraData = {}) => {
  const user = interaction.user;
  const subcommand = interaction.options.getSubcommand();
  
  logger.info(`[Seed Command] User: ${user.username} (ID: ${user.id}) used /seed ${subcommand}`);

  // Get the subcommand and options
  const config = serverInstance.config;
  const seedConfig = config.commands.find((cmd) => cmd.command === "seed");

  if (!seedConfig) {
    return interaction.reply({
      content: "Seed command configuration is missing.",
      ephemeral: true,
    });
  }

  // Get user roles
  const userRoles = interaction.member.roles.cache.map((role) => role.id);

  // Function to get the user's maximum role level (copied from rcon.js)
  function getUserMaxRoleLevel(userRoles) {
    let maxLevel = 0;
    for (const [levelKey, roleNameArray] of Object.entries(config.roleLevels)) {
      const numericLevel = parseInt(levelKey, 10);
      if (isNaN(numericLevel)) continue;

      for (const roleName of roleNameArray) {
        const discordRoleID = config.roles[roleName];
        if (discordRoleID && userRoles.includes(discordRoleID)) {
          if (numericLevel > maxLevel) {
            maxLevel = numericLevel;
          }
        }
      }
    }
    return maxLevel;
  }

  // Function to check if user has permission for a specific subcommand
  function hasPermissionForSubcommand(subcommandName) {
    const requiredLevel = seedConfig[subcommandName];
    if (!requiredLevel) {
      return false;
    }
    const userLevel = getUserMaxRoleLevel(userRoles);
    return userLevel >= requiredLevel;
  }

  // Handle the interaction state
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ ephemeral: true });
  }

  try {
    // Handle each subcommand with permission checking
    switch (subcommand) {
      case 'leaderboard':
        await handleLeaderboard(interaction, serverInstance);
        break;
      
      case 'status':
        await handleStatus(interaction, serverInstance);
        break;
      
      case 'config':
        // Config viewing is allowed for everyone, but modification needs permission
        const setting = interaction.options.getString('setting');
        if (setting && !hasPermissionForSubcommand('configModify')) {
          return interaction.editReply({
            content: "You do not have permission to modify configuration settings.",
            ephemeral: true,
          });
        }
        await handleConfig(interaction, serverInstance, seedConfig);
        break;
      
      case 'playerlist':
        // Check permissions for managing player list
        const action = interaction.options.getString('action');
        if ((action === 'add' || action === 'remove' || action === 'clear') && !hasPermissionForSubcommand('playerlist')) {
          return interaction.editReply({
            content: "You do not have permission to manage the player list.",
            ephemeral: true,
          });
        }
        await handlePlayerList(interaction, serverInstance);
        break;
      
      case 'mode':
        // Check permissions for changing mode
        if (!hasPermissionForSubcommand('mode')) {
          return interaction.editReply({
            content: "You do not have permission to change the player list mode.",
            ephemeral: true,
          });
        }
        await handleMode(interaction, serverInstance);
        break;
      
      case 'setchannel':
        if (!hasPermissionForSubcommand('setchannel')) {
          return interaction.editReply({
            content: "You do not have permission to set the leaderboard channel.",
            ephemeral: true,
          });
        }
        await handleSetChannel(interaction, serverInstance);
        break;
      
      case 'reset':
        if (!hasPermissionForSubcommand('reset')) {
          return interaction.editReply({
            content: "You do not have permission to reset the seed leaderboard.",
            ephemeral: true,
          });
        }
        await handleReset(interaction, serverInstance);
        break;

      // NEW: Streak tracking
      case 'streaks':
        await handleStreaks(interaction, serverInstance);
        break;

      // NEW: Analytics
      case 'analytics':
        if (!hasPermissionForSubcommand('analytics') && getUserMaxRoleLevel(userRoles) < 2) {
          return interaction.editReply({
            content: "You do not have permission to view detailed analytics.",
            ephemeral: true,
          });
        }
        await handleAnalytics(interaction, serverInstance);
        break;

      // NEW: Smart recommendations
      case 'recommendations':
        await handleRecommendations(interaction, serverInstance);
        break;
      
      default:
        return interaction.editReply({
          content: `Unknown subcommand: ${subcommand}`,
          ephemeral: true,
        });
    }
  } catch (error) {
    logger.error(`[Seed Command] Error in ${subcommand}: ${error.message}`);
    return interaction.editReply({
      content: "An error occurred while executing the command.",
      ephemeral: true,
    });
  }
};

// Handle /seed leaderboard
async function handleLeaderboard(interaction, serverInstance) {
  const pool = process.mysqlPool || serverInstance.mysqlPool;
  if (!pool) {
    await interaction.editReply('Database connection is not initialized.');
    return;
  }

  const pluginConfig = serverInstance.config.plugins.find(p => p.plugin === 'SeedTrackerBasic');
  const lookbackDays = (pluginConfig && typeof pluginConfig.lookbackDays === 'number') 
    ? pluginConfig.lookbackDays 
    : 30;

  try {
    const [rows] = await pool.query(
      `SELECT playerName, totalMinutes
       FROM seeder_totals
       WHERE lastSeen >= NOW() - INTERVAL ? DAY
       ORDER BY totalMinutes DESC
       LIMIT 10;`,
      [lookbackDays]
    );

    if (!rows || rows.length === 0) {
      await interaction.editReply(`No seeding data found for the last ${lookbackDays} days.`);
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(`🏆 Top 10 Seeders (Last ${lookbackDays} Days)`)
      .setColor(0x00ae86)
      .setTimestamp()
      .setFooter({ text: 'SeedTracker - ReforgerJS' });

    rows.forEach((row, idx) => {
      const hours = (row.totalMinutes / 60).toFixed(2);
      embed.addFields({
        name: `${idx + 1}. ${row.playerName}`,
        value: `${hours} hours (${row.totalMinutes} minutes)`,
        inline: false
      });
    });

    await interaction.editReply({ embeds: [embed] });
    logger.info(`[Seed Leaderboard] Successfully displayed leaderboard to ${interaction.user.username}`);
  } catch (error) {
    logger.error(`[Seed Leaderboard] Database error: ${error.message}`);
    await interaction.editReply('An error occurred while fetching the leaderboard data.');
  }
}

// NEW: Handle /seed streaks
async function handleStreaks(interaction, serverInstance) {
  const pool = process.mysqlPool || serverInstance.mysqlPool;
  if (!pool) {
    await interaction.editReply('Database connection is not initialized.');
    return;
  }

  const plugin = process.seedTracker;
  if (!plugin) {
    await interaction.editReply('⚠️ SeedTracker plugin is not initialized.');
    return;
  }

  const limit = interaction.options.getInteger('limit') || 10;

  try {
    const streaks = await plugin.getStreakLeaderboard(limit);

    if (!streaks || streaks.length === 0) {
      await interaction.editReply('No streak data found.');
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(`🔥 Top ${limit} Seeding Streaks`)
      .setColor(0xff6b35)
      .setTimestamp()
      .setFooter({ text: 'SeedTracker - ReforgerJS' });

    streaks.forEach((streak, idx) => {
      const totalHours = streak.totalMinutes ? (streak.totalMinutes / 60).toFixed(1) : '0.0';
      const lastSeen = streak.lastSeededDate ? new Date(streak.lastSeededDate).toLocaleDateString() : 'Never';
      
      embed.addFields({
        name: `${idx + 1}. ${streak.playerName}`,
        value: `🔥 Current: **${streak.currentStreak} days**\n` +
               `🏆 Best: ${streak.longestStreak} days\n` +
               `📅 Total Days: ${streak.totalSeedingDays}\n` +
               `⏱️ Total Hours: ${totalHours}\n` +
               `📊 Last Seen: ${lastSeen}`,
        inline: true
      });
    });

    await interaction.editReply({ embeds: [embed] });
    logger.info(`[Seed Streaks] Successfully displayed streak leaderboard to ${interaction.user.username}`);
  } catch (error) {
    logger.error(`[Seed Streaks] Error: ${error.message}`);
    await interaction.editReply('An error occurred while fetching streak data.');
  }
}

// NEW: Handle /seed analytics
async function handleAnalytics(interaction, serverInstance) {
  const pool = process.mysqlPool || serverInstance.mysqlPool;
  if (!pool) {
    await interaction.editReply('Database connection is not initialized.');
    return;
  }

  const plugin = process.seedTracker;
  if (!plugin) {
    await interaction.editReply('⚠️ SeedTracker plugin is not initialized.');
    return;
  }

  const days = interaction.options.getInteger('days') || 7;

  try {
    const analytics = await plugin.getAnalytics(days);

    if (!analytics) {
      await interaction.editReply('Unable to fetch analytics data.');
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(`📊 Seeding Analytics (Last ${days} Days)`)
      .setColor(0x4a90e2)
      .setTimestamp()
      .setFooter({ text: 'SeedTracker - ReforgerJS' });

    // Peak seeding hours
    if (analytics.peakHours && analytics.peakHours.length > 0) {
      const peakHoursText = analytics.peakHours
        .slice(0, 3)
        .map(h => `${h.hour}:00 (${h.seedingHours}h active, avg ${h.avgPlayers.toFixed(1)} players)`)
        .join('\n');
      
      embed.addFields({
        name: '⏰ Peak Seeding Hours',
        value: peakHoursText || 'No data available',
        inline: false
      });
    }

    // Most effective seeders
    if (analytics.effectiveSeeders && analytics.effectiveSeeders.length > 0) {
      const seedersText = analytics.effectiveSeeders
        .slice(0, 5)
        .map((s, idx) => `${idx + 1}. ${s.playerName} - ${(s.totalMinutes / 60).toFixed(1)}h (${s.activeDays} days)`)
        .join('\n');
      
      embed.addFields({
        name: '🌟 Most Effective Seeders',
        value: seedersText || 'No data available',
        inline: false
      });
    }

    // Success rate
    if (analytics.successRate) {
      const rate = analytics.successRate.totalSeedingHours > 0 
        ? ((analytics.successRate.successfulSeedingHours / analytics.successRate.totalSeedingHours) * 100).toFixed(1)
        : 0;
      
      embed.addFields({
        name: '📈 Seeding Success Rate',
        value: `${rate}% (${analytics.successRate.successfulSeedingHours}/${analytics.successRate.totalSeedingHours} hours led to server growth)`,
        inline: false
      });
    }

    // Population trends
    if (analytics.trends && analytics.trends.length > 0) {
      const latestTrend = analytics.trends[0];
      const avgGrowth = analytics.trends.length > 1 
        ? ((latestTrend.avgPlayers - analytics.trends[analytics.trends.length - 1].avgPlayers) / days).toFixed(1)
        : 0;
      
      embed.addFields({
        name: '📊 Recent Trends',
        value: `Avg daily players: ${latestTrend.avgPlayers.toFixed(1)}\n` +
               `Peak players: ${latestTrend.peakPlayers}\n` +
               `Daily growth: ${avgGrowth > 0 ? '+' : ''}${avgGrowth} players/day`,
        inline: false
      });
    }

    await interaction.editReply({ embeds: [embed] });
    logger.info(`[Seed Analytics] Successfully displayed analytics to ${interaction.user.username}`);
  } catch (error) {
    logger.error(`[Seed Analytics] Error: ${error.message}`);
    await interaction.editReply('An error occurred while fetching analytics data.');
  }
}

// NEW: Handle /seed recommendations
async function handleRecommendations(interaction, serverInstance) {
  const plugin = process.seedTracker;
  if (!plugin) {
    await interaction.editReply('⚠️ SeedTracker plugin is not initialized.');
    return;
  }

  try {
    const recommendations = await plugin.getSmartRecommendations();

    if (!recommendations || recommendations.length === 0) {
      await interaction.editReply('No recommendations available at this time.');
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('🧠 Smart Seeding Recommendations')
      .setColor(0x9b59b6)
      .setTimestamp()
      .setFooter({ text: 'SeedTracker AI - ReforgerJS' });

    recommendations.forEach(rec => {
      const confidenceEmoji = rec.confidence === 'high' ? '🟢' : rec.confidence === 'medium' ? '🟡' : '🔴';
      
      embed.addFields({
        name: `${confidenceEmoji} ${rec.title}`,
        value: rec.description,
        inline: false
      });
    });

    // Add current server status
    const currentPlayers = serverInstance?.players?.length || 0;
    const seedStart = plugin.seedStart;
    const seedEnd = plugin.seedEnd;
    
    let statusColor = '🔴';
    let statusText = 'Not in seeding range';
    
    if (currentPlayers < seedStart) {
      statusColor = '🟡';
      statusText = 'Needs seeding';
    } else if (currentPlayers >= seedStart && currentPlayers <= seedEnd) {
      statusColor = '🟢';
      statusText = 'Currently seeding';
    } else {
      statusColor = '🔵';
      statusText = 'Server full';
    }

    embed.addFields({
      name: '📊 Current Server Status',
      value: `${statusColor} ${currentPlayers} players online - ${statusText}`,
      inline: false
    });

    await interaction.editReply({ embeds: [embed] });
    logger.info(`[Seed Recommendations] Successfully displayed recommendations to ${interaction.user.username}`);
  } catch (error) {
    logger.error(`[Seed Recommendations] Error: ${error.message}`);
    await interaction.editReply('An error occurred while generating recommendations.');
  }
}

// Handle /seed playerlist
async function handlePlayerList(interaction, serverInstance) {
  const action = interaction.options.getString('action');
  const playerUID = interaction.options.getString('playeruid')?.trim();

  const plugin = process.seedTracker;
  if (!plugin) {
    await interaction.editReply('⚠️ SeedTracker plugin is not initialized.');
    return;
  }

  const config = serverInstance.config;
  const pluginConfig = config.plugins.find(p => p.plugin === 'SeedTrackerBasic');
  if (!pluginConfig) {
    await interaction.editReply('⚠️ SeedTrackerBasic configuration not found.');
    return;
  }

  if (!Array.isArray(pluginConfig.playerList)) {
    pluginConfig.playerList = [];
  }

  const mode = pluginConfig.playerListMode || 'blacklist';
  const limit = pluginConfig.playerListLimit || 25;

  switch (action) {
    case 'list':
      // Show current player list
      const embed = new EmbedBuilder()
        .setTitle(`📋 Player ${mode.charAt(0).toUpperCase() + mode.slice(1)} (${pluginConfig.playerList.length}/${limit})`)
        .setColor(mode === 'blacklist' ? 0xff4444 : 0x44ff44)
        .setTimestamp();

      if (pluginConfig.playerList.length === 0) {
        embed.setDescription(`No players in the ${mode}.`);
      } else {
        const playerList = pluginConfig.playerList.slice(0, 20); // Show max 20 in embed
        embed.setDescription(playerList.map((uid, idx) => `${idx + 1}. \`${uid}\``).join('\n'));
        
        if (pluginConfig.playerList.length > 20) {
          embed.setFooter({ text: `Showing first 20 of ${pluginConfig.playerList.length} players` });
        }
      }

      await interaction.editReply({ embeds: [embed] });
      break;

    case 'add':
      if (!playerUID) {
        await interaction.editReply('⚠️ You must provide a player UID to add.');
        return;
      }

      const normalizedUID = playerUID.toLowerCase();
      if (pluginConfig.playerList.map(id => id.toLowerCase()).includes(normalizedUID)) {
        await interaction.editReply(`⚠️ UID \`${playerUID}\` is already in the ${mode}.`);
        return;
      }

      if (pluginConfig.playerList.length >= limit) {
        await interaction.editReply(`⚠️ ${mode.charAt(0).toUpperCase() + mode.slice(1)} is full (maximum ${limit} entries). Remove an entry first.`);
        return;
      }

      pluginConfig.playerList.push(playerUID);

      try {
        await saveConfig(config);
        plugin.playerList = pluginConfig.playerList.slice(0, limit).map(id => id.trim().toLowerCase());
        
        const user = interaction.user;
        logger.info(`[Seed PlayerList] User ${user.username} (${user.id}) added ${playerUID} to ${mode}`);
        
        await interaction.editReply(`✅ Player UID \`${playerUID}\` has been added to the ${mode}.`);
      } catch (error) {
        logger.error(`[Seed PlayerList] Error saving config: ${error.message}`);
        await interaction.editReply('⚠️ Failed to update configuration file.');
      }
      break;

    case 'remove':
      if (!playerUID) {
        await interaction.editReply('⚠️ You must provide a player UID to remove.');
        return;
      }

      const normalizedRemoveUID = playerUID.toLowerCase();
      const index = pluginConfig.playerList.findIndex(id => id.trim().toLowerCase() === normalizedRemoveUID);

      if (index === -1) {
        await interaction.editReply(`⚠️ UID \`${playerUID}\` is not in the ${mode}.`);
        return;
      }

      const removedUID = pluginConfig.playerList.splice(index, 1)[0];

      try {
        await saveConfig(config);
        plugin.playerList = pluginConfig.playerList.slice(0, limit).map(id => id.trim().toLowerCase());
        
        const user = interaction.user;
        logger.info(`[Seed PlayerList] User ${user.username} (${user.id}) removed ${removedUID} from ${mode}`);
        
        await interaction.editReply(`✅ Player UID \`${removedUID}\` has been removed from the ${mode}.`);
      } catch (error) {
        logger.error(`[Seed PlayerList] Error saving config: ${error.message}`);
        await interaction.editReply('⚠️ Failed to update configuration file.');
      }
      break;

    case 'clear':
      if (pluginConfig.playerList.length === 0) {
        await interaction.editReply(`The ${mode} is already empty.`);
        return;
      }

      const clearedCount = pluginConfig.playerList.length;
      pluginConfig.playerList = [];

      try {
        await saveConfig(config);
        plugin.playerList = [];
        
        const user = interaction.user;
        logger.info(`[Seed PlayerList] User ${user.username} (${user.id}) cleared ${mode} (removed ${clearedCount} entries)`);
        
        await interaction.editReply(`✅ Cleared ${mode}. Removed ${clearedCount} entries.`);
      } catch (error) {
        logger.error(`[Seed PlayerList] Error saving config: ${error.message}`);
        await interaction.editReply('⚠️ Failed to update configuration file.');
      }
      break;
  }
}

// Handle /seed mode
async function handleMode(interaction, serverInstance) {
  const newMode = interaction.options.getString('mode');

  const plugin = process.seedTracker;
  if (!plugin) {
    await interaction.editReply('⚠️ SeedTracker plugin is not initialized.');
    return;
  }

  const config = serverInstance.config;
  const pluginConfig = config.plugins.find(p => p.plugin === 'SeedTrackerBasic');
  if (!pluginConfig) {
    await interaction.editReply('⚠️ SeedTrackerBasic configuration not found.');
    return;
  }

  const currentMode = pluginConfig.playerListMode || 'blacklist';

  if (!newMode) {
    // Show current mode
    const embed = new EmbedBuilder()
      .setTitle('🔧 Player List Mode')
      .setColor(currentMode === 'blacklist' ? 0xff4444 : 0x44ff44)
      .addFields(
        { name: 'Current Mode', value: currentMode.charAt(0).toUpperCase() + currentMode.slice(1), inline: true },
        { name: 'Description', value: currentMode === 'blacklist' 
          ? 'Players in the list will NOT be tracked for seeding' 
          : 'Only players in the list will be tracked for seeding', inline: false }
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (newMode === currentMode) {
    await interaction.editReply(`Player list mode is already set to ${newMode}.`);
    return;
  }

  // Update mode
  pluginConfig.playerListMode = newMode;

  try {
    await saveConfig(config);
    plugin.playerListMode = newMode;
    
    const user = interaction.user;
    logger.info(`[Seed Mode] User ${user.username} (${user.id}) changed player list mode from ${currentMode} to ${newMode}`);
    
    await interaction.editReply(`✅ Player list mode changed from **${currentMode}** to **${newMode}**.`);
  } catch (error) {
    logger.error(`[Seed Mode] Error saving config: ${error.message}`);
    await interaction.editReply('⚠️ Failed to update configuration file.');
  }
}

// Handle /seed reset
async function handleReset(interaction, serverInstance) {
  const confirm = interaction.options.getString('confirm');

  if (confirm !== 'CONFIRM') {
    await interaction.editReply('Type CONFIRM to proceed with resetting the leaderboard.');
    return;
  }

  const pool = process.mysqlPool || serverInstance.mysqlPool;
  if (!pool) {
    await interaction.editReply('Database connection is not initialized.');
    return;
  }

  try {
    const [tables] = await pool.query(`SHOW TABLES LIKE 'seeder_totals'`);
    if (!tables.length) {
      await interaction.editReply('⚠️ Seed tracking system is not initialized. No data to reset.');
      return;
    }

    await pool.query(`TRUNCATE TABLE seeder_totals;`);
    
    const user = interaction.user;
    logger.info(`[Seed Command] User ${user.username} (${user.id}) reset the seed leaderboard`);
    
    await interaction.editReply('✅ Successfully reset the seed leaderboard. All seeding totals have been cleared.');
  } catch (error) {
    logger.error(`[Seed Reset] Error: ${error.message}`);
    await interaction.editReply('⚠️ There was an error resetting the seed leaderboard.');
  }
}

// Handle /seed setchannel
async function handleSetChannel(interaction, serverInstance) {
  const channel = interaction.options.getChannel('channel');
  
  if (channel.guildId !== interaction.guild.id) {
    await interaction.editReply('⚠️ That channel is not in this server.');
    return;
  }

  if (!channel.isTextBased()) {
    await interaction.editReply('⚠️ Please choose a valid text channel.');
    return;
  }

  const plugin = process.seedTracker;
  if (!plugin) {
    await interaction.editReply('⚠️ SeedTracker plugin is not initialized.');
    return;
  }

  const config = serverInstance.config;
  const pluginConfig = config.plugins.find(p => p.plugin === 'SeedTrackerBasic');
  if (!pluginConfig) {
    await interaction.editReply('⚠️ SeedTrackerBasic configuration not found.');
    return;
  }

  pluginConfig.leaderboardChannelId = channel.id;
  pluginConfig.leaderboardMessageId = null;

  try {
    await saveConfig(config);
    plugin.leaderboardChannelId = channel.id;
    plugin.leaderboardMessageId = null;
    
    // Trigger immediate leaderboard update
    try {
      await plugin.updateLeaderboard();
    } catch (updateError) {
      logger.warn(`[Seed SetChannel] Failed to post initial leaderboard: ${updateError.message}`);
    }
    
    const user = interaction.user;
    logger.info(`[Seed Command] User ${user.username} (${user.id}) set leaderboard channel to ${channel.id}`);
    
    await interaction.editReply(`✅ Leaderboard channel set to ${channel}. The leaderboard will be posted there on the next update.`);
  } catch (error) {
    logger.error(`[Seed SetChannel] Error: ${error.message}`);
    await interaction.editReply('⚠️ Failed to update configuration or post leaderboard.');
  }
}

// Handle /seed config
async function handleConfig(interaction, serverInstance, seedConfig) {
  const setting = interaction.options.getString('setting');
  const value = interaction.options.getInteger('value');

  const config = serverInstance.config;
  const pluginConfig = config.plugins.find(p => p.plugin === 'SeedTrackerBasic');
  if (!pluginConfig) {
    await interaction.editReply('⚠️ SeedTrackerBasic configuration not found.');
    return;
  }

  // If no setting specified, show current config
  if (!setting) {
    const mode = pluginConfig.playerListMode || 'blacklist';
    const limit = pluginConfig.playerListLimit || 25;
    
    const embed = new EmbedBuilder()
      .setTitle('🔧 SeedTracker Configuration')
      .setColor(0x3498db)
      .addFields(
        { name: 'Tracking Interval', value: `${pluginConfig.interval || 15} minutes`, inline: true },
        { name: 'Seed Start', value: `${pluginConfig.seedStart || 5} players`, inline: true },
        { name: 'Seed End', value: `${pluginConfig.seedEnd || 40} players`, inline: true },
        { name: 'Lookback Days', value: `${pluginConfig.lookbackDays || 30} days`, inline: true },
        { name: 'Purge Days', value: `${pluginConfig.purgeDays || 45} days`, inline: true },
        { name: 'Player List Mode', value: `${mode.charAt(0).toUpperCase() + mode.slice(1)}`, inline: true },
        { name: 'Player List Limit', value: `${limit} players`, inline: true },
        { name: 'Current Player List', value: `${pluginConfig.playerList?.length || 0}/${limit}`, inline: true },
        { name: 'Leaderboard Channel', value: pluginConfig.leaderboardChannelId ? `<#${pluginConfig.leaderboardChannelId}>` : 'Not Set', inline: true }
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // For modifying config, permission was already checked above

  if (value === null) {
    await interaction.editReply('⚠️ You must provide a value when modifying settings.');
    return;
  }

  // Validate values
  const validations = {
    interval: { min: 1, max: 60, desc: 'tracking interval (minutes)' },
    seedStart: { min: 1, max: 100, desc: 'minimum players for seeding' },
    seedEnd: { min: 1, max: 100, desc: 'maximum players for seeding' },
    lookbackDays: { min: 1, max: 365, desc: 'leaderboard lookback period (days)' },
    purgeDays: { min: 1, max: 365, desc: 'data retention period (days)' },
    playerListLimit: { min: 1, max: 100, desc: 'player list limit' }
  };

  const validation = validations[setting];
  if (!validation) {
    await interaction.editReply(`⚠️ Invalid setting. Valid options: ${Object.keys(validations).join(', ')}`);
    return;
  }

  if (value < validation.min || value > validation.max) {
    await interaction.editReply(`⚠️ Value must be between ${validation.min} and ${validation.max} for ${validation.desc}.`);
    return;
  }

  // Special validation: seedStart should be less than seedEnd
  if (setting === 'seedStart' && value >= (pluginConfig.seedEnd || 40)) {
    await interaction.editReply('⚠️ Seed start must be less than seed end.');
    return;
  }
  if (setting === 'seedEnd' && value <= (pluginConfig.seedStart || 5)) {
    await interaction.editReply('⚠️ Seed end must be greater than seed start.');
    return;
  }

  // Special handling for playerListLimit
  if (setting === 'playerListLimit') {
    const currentList = pluginConfig.playerList || [];
    if (value < currentList.length) {
      await interaction.editReply(`⚠️ Cannot set limit to ${value} because there are currently ${currentList.length} players in the list. Remove some players first.`);
      return;
    }
  }

  // Update configuration
  const oldValue = pluginConfig[setting];
  pluginConfig[setting] = value;

  try {
    await saveConfig(config);
    
    // Update plugin instance if available
    const plugin = process.seedTracker;
    if (plugin) {
      plugin[setting] = value;
      // Restart tracking if interval changed
      if (setting === 'interval') {
        plugin.startTracking();
      }
      // Update player list if limit changed
      if (setting === 'playerListLimit') {
        plugin.playerListLimit = value;
        plugin.playerList = pluginConfig.playerList.slice(0, value).map(id => id.trim().toLowerCase());
      }
    }
    
    const user = interaction.user;
    logger.info(`[Seed Config] User ${user.username} (${user.id}) changed ${setting} from ${oldValue} to ${value}`);
    
    await interaction.editReply(`✅ Updated ${setting} from ${oldValue} to ${value}.`);
  } catch (error) {
    logger.error(`[Seed Config] Error saving config: ${error.message}`);
    await interaction.editReply('⚠️ Failed to update configuration file.');
  }
}

// Handle /seed status
async function handleStatus(interaction, serverInstance) {
  const plugin = process.seedTracker;
  const pool = process.mysqlPool || serverInstance.mysqlPool;
  
  const embed = new EmbedBuilder()
    .setTitle('📊 SeedTracker Status')
    .setColor(0x2ecc71)
    .setTimestamp();

  // Plugin status
  if (!plugin) {
    embed.addFields({ name: 'Plugin Status', value: '❌ Not Initialized', inline: true });
  } else {
    embed.addFields({ name: 'Plugin Status', value: '✅ Active', inline: true });
  }

  // Database status
  if (!pool) {
    embed.addFields({ name: 'Database Status', value: '❌ Not Connected', inline: true });
  } else {
    try {
      const [tables] = await pool.query(`SHOW TABLES LIKE 'seeder_totals'`);
      if (tables.length > 0) {
        const [count] = await pool.query(`SELECT COUNT(*) as total FROM seeder_totals`);
        embed.addFields({ name: 'Database Status', value: `✅ Connected (${count[0].total} records)`, inline: true });
      } else {
        embed.addFields({ name: 'Database Status', value: '⚠️ Table Missing', inline: true });
      }
    } catch (error) {
      embed.addFields({ name: 'Database Status', value: '❌ Error', inline: true });
    }
  }

  // Current server status
  const players = serverInstance?.players || [];
  const pluginConfig = serverInstance.config.plugins.find(p => p.plugin === 'SeedTrackerBasic');
  const seedStart = pluginConfig?.seedStart || 5;
  const seedEnd = pluginConfig?.seedEnd || 40;
  const isSeeding = players.length >= seedStart && players.length <= seedEnd;

  embed.addFields(
    { name: 'Current Players', value: `${players.length}`, inline: true },
    { name: 'Seeding Range', value: `${seedStart} - ${seedEnd}`, inline: true },
    { name: 'Currently Seeding', value: isSeeding ? '✅ Yes' : '❌ No', inline: true }
  );

  if (pluginConfig) {
    const mode = pluginConfig.playerListMode || 'blacklist';
    const limit = pluginConfig.playerListLimit || 25;
    const currentCount = pluginConfig.playerList?.length || 0;
    
    embed.addFields(
      { name: 'Tracking Interval', value: `${pluginConfig.interval || 15} minutes`, inline: true },
      { name: 'Player List Mode', value: `${mode.charAt(0).toUpperCase() + mode.slice(1)}`, inline: true },
      { name: 'Player List', value: `${currentCount}/${limit}`, inline: true },
      { name: 'Leaderboard Channel', value: pluginConfig.leaderboardChannelId ? `<#${pluginConfig.leaderboardChannelId}>` : 'Not Set', inline: true }
    );
  }

  await interaction.editReply({ embeds: [embed] });
}

// Helper function to save configuration
async function saveConfig(config) {
  const configPath = path.resolve(__dirname, '../../config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}