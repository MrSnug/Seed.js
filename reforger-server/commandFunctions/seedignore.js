// reforger-server/commandFunctions/seedignore.js

const fs = require('fs');
const path = require('path');

module.exports = async (interaction, extraData) => {
  // Only allow in a guild
  if (!interaction.guild) {
    return interaction.reply({
      content: 'This command can only be used in a server.',
      ephemeral: true
    });
  }

  // Pull the UID directly from interaction.options
  const playerUID = interaction.options.getString('playeruid')?.trim();
  if (!playerUID) {
    return interaction.reply({
      content: '⚠️ You must provide a player UID to ignore. Usage: `/seedignore <playerUID>`',
      ephemeral: true
    });
  }

  // We expect process.seedTracker to exist
  const plugin = process.seedTracker;
  if (!plugin) {
    return interaction.reply({
      content: '⚠️ SeedTracker plugin is not initialized.',
      ephemeral: true
    });
  }

  // Load the raw config.json so we can persist
  const configPath = path.resolve(__dirname, '../../config.json');
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    console.error('[SeedIgnore] Failed to read config.json:', err);
    return interaction.reply({
      content: '⚠️ Could not load configuration file.',
      ephemeral: true
    });
  }

  // Find our plugin entry
  const pluginConfig = config.plugins.find(p => p.plugin === 'SeedTrackerBasic');
  if (!pluginConfig) {
    return interaction.reply({
      content: '⚠️ Could not find SeedTrackerBasic in config.',
      ephemeral: true
    });
  }

  // Ensure seedIgnore is an array
  if (!Array.isArray(pluginConfig.seedIgnore)) {
    pluginConfig.seedIgnore = [];
  }

  // Normalize the UID for comparison
  const normalized = playerUID.toLowerCase();
  if (pluginConfig.seedIgnore.map(id => id.toLowerCase()).includes(normalized)) {
    return interaction.reply({
      content: `⚠️ UID \`${playerUID}\` is already in the ignore list.`,
      ephemeral: true
    });
  }

  // Add to both config.json and the in-memory plugin.ignoreList
  pluginConfig.seedIgnore.push(playerUID);

  // Persist back to disk
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    console.error('[SeedIgnore] Failed to write config.json:', err);
    return interaction.reply({
      content: '⚠️ Failed to update configuration file. See logs.',
      ephemeral: true
    });
  }

  // Update the in-memory ignoreList (normalize + up to 10 entries)
  plugin.ignoreList = pluginConfig.seedIgnore
    .slice(0, 10)
    .map(id => id.trim().toLowerCase());

  // Respond with a confirmation
  return interaction.reply({
    content: `✅ Player UID \`${playerUID}\` has been added to the ignore list.`,
    ephemeral: true
  });
};
