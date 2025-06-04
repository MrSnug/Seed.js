// reforger-server/commandFunctions/seed.js

const path = require('path');
const config = require(path.resolve(__dirname, '../../config.json'));
const { EmbedBuilder } = require('discord.js');

module.exports = async (interaction, extraData) => {
  // If MySQL pool isn't ready yet
  if (!process.mysqlPool) {
    return interaction.reply({
      content: '⚠️ Database is not ready. Please try again later.',
      ephemeral: true
    });
  }

  // Defer as ephemeral
  await interaction.deferReply({ ephemeral: true });

  try {
    // Find lookbackDays in pluginConfig
    const pluginConfig = config.plugins.find(
      (p) => p.plugin === 'SeedTrackerBasic'
    );
    const lookbackDays =
      pluginConfig && typeof pluginConfig.lookbackDays === 'number'
        ? pluginConfig.lookbackDays
        : 30;

    // Query top 10 from seeder_totals
    const [rows] = await process.mysqlPool.query(
      `
      SELECT playerName, totalMinutes
      FROM seeder_totals
      WHERE lastSeen >= NOW() - INTERVAL ? DAY
      ORDER BY totalMinutes DESC
      LIMIT 10;
      `,
      [lookbackDays]
    );

    if (!rows || rows.length === 0) {
      return interaction.editReply({
        content: `No seeding data found for the last ${lookbackDays} days.`,
      });
    }

    // Build embed
    const embed = new EmbedBuilder()
      .setTitle(`🏆 Top 10 Seeders (Last ${lookbackDays} Days)`)
      .setColor(0x00ae86)
      .setTimestamp();

    rows.forEach((row, idx) => {
      const hours = (row.totalMinutes / 60).toFixed(2);
      embed.addFields({
        name: `${idx + 1}. ${row.playerName}`,
        value: `${hours} hours (${row.totalMinutes} minutes)`
      });
    });

    return interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error('[SeedCommand] Error fetching top seeders:', err);
    return interaction.editReply({
      content: '⚠️ There was an error while fetching the top seeders.',
    });
  }
};
