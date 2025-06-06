// reforger-server/commands/seed.js
const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('seed')
    .setDescription('Seed tracking system management')
    .addSubcommand(subcommand =>
      subcommand
        .setName('leaderboard')
        .setDescription('Show the current seeding leaderboard')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('reset')
        .setDescription('Reset the seeding leaderboard (admin only)')
        .addStringOption(option =>
          option
            .setName('confirm')
            .setDescription('Type CONFIRM to proceed with reset')
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('playerlist')
        .setDescription('Manage the player blacklist/whitelist')
        .addStringOption(option =>
          option
            .setName('action')
            .setDescription('Action to perform')
            .setRequired(true)
            .addChoices(
              { name: 'list', value: 'list' },
              { name: 'add', value: 'add' },
              { name: 'remove', value: 'remove' },
              { name: 'clear', value: 'clear' }
            )
        )
        .addStringOption(option =>
          option
            .setName('playeruid')
            .setDescription('Player UID (required for add/remove actions)')
            .setRequired(false)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('mode')
        .setDescription('View or change the player list mode')
        .addStringOption(option =>
          option
            .setName('mode')
            .setDescription('Set the player list mode')
            .setRequired(false)
            .addChoices(
              { name: 'blacklist', value: 'blacklist' },
              { name: 'whitelist', value: 'whitelist' }
            )
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('setchannel')
        .setDescription('Set the Discord channel for leaderboard updates')
        .addChannelOption(option =>
          option
            .setName('channel')
            .setDescription('The text channel for leaderboard posts')
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('config')
        .setDescription('View or modify seeding configuration')
        .addStringOption(option =>
          option
            .setName('setting')
            .setDescription('Configuration setting to modify')
            .setRequired(false)
            .addChoices(
              { name: 'interval', value: 'interval' },
              { name: 'seedstart', value: 'seedStart' },
              { name: 'seedend', value: 'seedEnd' },
              { name: 'lookbackdays', value: 'lookbackDays' },
              { name: 'purgedays', value: 'purgeDays' },
              { name: 'playerlistlimit', value: 'playerListLimit' }
            )
        )
        .addIntegerOption(option =>
          option
            .setName('value')
            .setDescription('New value for the setting')
            .setRequired(false)
            .setMinValue(1)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('status')
        .setDescription('Show current seeding system status and statistics')
    ),

  async execute(interaction) {
    // This execute function is not used by ReforgerJS
    // ReforgerJS uses the commandFunctions pattern
    return;
  }
};