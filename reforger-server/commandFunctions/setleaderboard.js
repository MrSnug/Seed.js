// reforger-server/commandFunctions/setleaderboard.js

const fs = require('fs');
const path = require('path');

module.exports = async (interaction, extraData) => {
  // 1) Must be in a guild
  if (!interaction.guild) {
    return interaction.reply({
      content: 'This command can only be used in a server.',
      ephemeral: true
    });
  }

  // 2) Try to get the channel object from extraData, else fallback
  let channel = null;
  if (extraData && extraData.channel) {
    channel = extraData.channel;
    console.log('[SetLeaderboard Function] Got channel from extraData:', channel.id);
  } else {
    // Fallback: grab directly from interaction options
    channel = interaction.options.getChannel('channel');
    console.log('[SetLeaderboard Function] Got channel via interaction.options:', channel?.id);
  }

  if (!channel) {
    return interaction.reply({
      content: '⚠️ You must provide a channel. Usage: `/setleaderboard #channel`',
      ephemeral: true
    });
  }

  // --- Debug logging to see what we actually received ---
  console.log(`[SetLeaderboard] Received channel.id     = ${channel.id}`);
  console.log(`[SetLeaderboard] Received channel.type   = ${channel.type}`);
  console.log(`[SetLeaderboard] Received channel.guildId= ${channel.guildId}`);
  console.log(`[SetLeaderboard] Interaction.guild.id   = ${interaction.guild.id}`);
  // --------------------------------------------------------

  // 3) Verify channel belongs to this guild
  if (channel.guildId !== interaction.guild.id) {
    return interaction.reply({
      content: '⚠️ That channel is not in this server.',
      ephemeral: true
    });
  }

  // 4) Allow any text-based channel (GUILD_TEXT, GUILD_NEWS, GUILD_FORUM, etc.)
  if (!channel.isTextBased()) {
    return interaction.reply({
      content: '⚠️ Invalid channel. Please choose a valid text channel.',
      ephemeral: true
    });
  }

  // 5) Ensure the SeedTracker plugin instance is available
  const plugin = process.seedTracker;
  if (!plugin) {
    return interaction.reply({
      content: '⚠️ SeedTracker plugin is not initialized.',
      ephemeral: true
    });
  }

  // 6) Load config.json from disk
  const configPath = path.resolve(__dirname, '../../config.json');
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    console.error('[SetLeaderboard] Failed to read config.json:', err);
    return interaction.reply({
      content: '⚠️ Could not load configuration file.',
      ephemeral: true
    });
  }

  // 7) Find the SeedTrackerBasic plugin block
  const pluginConfig = config.plugins.find(p => p.plugin === 'SeedTrackerBasic');
  if (!pluginConfig) {
    return interaction.reply({
      content: '⚠️ Could not find SeedTrackerBasic in config.',
      ephemeral: true
    });
  }

  // 8) Overwrite leaderboardChannelId in config
  pluginConfig.leaderboardChannelId = channel.id;

  // 9) Persist updated config back to disk
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    console.error('[SetLeaderboard] Failed to write config.json:', err);
    return interaction.reply({
      content: '⚠️ Failed to update configuration file. Check logs.',
      ephemeral: true
    });
  }

  // 10) Update the in-memory plugin’s channel ID
  plugin.leaderboardChannelId = channel.id;

  // 11) Confirm success
  return interaction.reply({
    content: `✅ Seeder leaderboard channel has been set to ${channel}.`,
    ephemeral: true
  });
};
