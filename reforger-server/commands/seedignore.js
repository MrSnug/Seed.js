// commands/seedignore.js

const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('seedignore')
    .setDescription('Add a player UID to the seeding-ignore list')
    .addStringOption(option =>
      option
        .setName('playeruid')
        .setDescription('The Reforger player UID to ignore')
        .setRequired(true)
    ),
  async execute(interaction) {
    const playerUID = interaction.options.getString('playeruid').trim();
    const seedIgnoreFunc = require('../reforger-server/commandFunctions/seedignore.js');
    await seedIgnoreFunc(interaction, { playerUID });
  }
};
