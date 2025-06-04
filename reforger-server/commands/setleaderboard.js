// commands/setleaderboard.js

const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setleaderboard')
    .setDescription('Set the channel where the seed leaderboard is posted')
    .addChannelOption(option =>
      option
        .setName('channel')
        .setDescription('The text channel to post/edit the leaderboard in')
        .setRequired(true)
    ),

  async execute(interaction) {
    console.log('[SetLeaderboard Command] execute() was called');

    // Discord has already validated this is a real channel in the guild
    const channel = interaction.options.getChannel('channel');
    console.log('[SetLeaderboard Command] Resolved channel:', channel.id, channel.type);

    // Delegate to our commandFunction, passing the channel object
    const setLbFunc = require('../reforger-server/commandFunctions/setleaderboard.js');
    await setLbFunc(interaction, { channel });
  }
};
