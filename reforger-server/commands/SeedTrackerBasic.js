const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('seed')
    .setDescription('Show top 10 seeders (by total minutes) in the last 30 days.'),

  async execute(interaction) {
    // Prevent non‐guild or missing pool
    if (!interaction.guild) {
      return interaction.reply({
        content: 'This command can only be used in a server.',
        ephemeral: true
      });
    }
    if (!process.mysqlPool) {
      return interaction.reply({
        content: 'Database not available. Try again later.',
        ephemeral: true
      });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      // Query the last 30 days of seed_events
      const [rows] = await process.mysqlPool.query(
        `
        SELECT
          playerName,
          SUM(duration) AS totalMinutes
        FROM seed_events
        WHERE \`timestamp\` >= NOW() - INTERVAL 30 DAY
        GROUP BY playerUID
        ORDER BY totalMinutes DESC
        LIMIT 10;
        `
      );

      if (!rows || rows.length === 0) {
        return interaction.editReply({
          content: 'No seeding data found for the last 30 days.',
        });
      }

      // Build embed
      const embed = new EmbedBuilder()
        .setTitle('🏆 Top 10 Seeders (Last 30 Days)')
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
  }
};
