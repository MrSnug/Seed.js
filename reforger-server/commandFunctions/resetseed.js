// reforger-server/commandFunctions/resetseed.js

module.exports = async (interaction, extraData) => {
  if (!interaction.guild) {
    return interaction.reply({
      content: 'This command can only be used in a server.',
      ephemeral: true
    });
  }

  if (!process.mysqlPool) {
    return interaction.reply({
      content: '⚠️ Database is not ready. Please try again later.',
      ephemeral: true
    });
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    // TRUNCATE seeder_totals (remove all data) for a full reset
    await process.mysqlPool.query(`TRUNCATE TABLE seeder_totals;`);

    return interaction.editReply({
      content: '✅ Successfully reset the seed leaderboard for this month (all totals cleared).',
    });
  } catch (err) {
    console.error('[ResetSeedCommand] Error resetting seeder_totals:', err);
    return interaction.editReply({
      content: '⚠️ There was an error resetting the seed leaderboard.',
    });
  }
};
