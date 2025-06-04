// commands/seedunignore.js

const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('seedunignore')
    .setDescription('Remove a player UID from the seeding-ignore list')
    .addStringOption(option =>
      option
        .setName('playeruid')
        .setDescription('The Reforger player UID to unignore')
        .setRequired(true)
    ),
  async execute(interaction) {
    const playerUID = interaction.options.getString('playeruid').trim();
    const seedUnignoreFunc = require('../reforger-server/commandFunctions/seedunignore.js');
    await seedUnignoreFunc(interaction, { playerUID });
  }
};
