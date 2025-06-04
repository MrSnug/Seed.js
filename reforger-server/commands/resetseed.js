// commands/resetseed.js
const { SlashCommandBuilder } = require('discord.js');

/**
 * Export an object with:
 *  • data: a SlashCommandBuilder
 *  • execute: a function (we’ll delegate to commandFunctions/resetseed.js)
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('resetseed')
    .setDescription('Reset this month’s seed leaderboard (clears all totals).'),
  // We simply forward the interaction to our commandFunctions version:
  async execute(interaction, extraData) {
    const resetSeedFunc = require('../reforger-server/commandFunctions/resetseed.js');
    await resetSeedFunc(interaction, extraData);
  }
};
