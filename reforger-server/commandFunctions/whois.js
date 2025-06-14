const mysql = require("mysql2/promise");
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');

// Main whois command function
async function executeWhois(interaction, serverInstance, discordClient, extraData = {}) {
    try {
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ ephemeral: true });
        }

        const user = interaction.user;
        const identifier = extraData.identifier;
        const value = extraData.value;
        
        logger.info(`[Whois Command] User: ${user.username} (ID: ${user.id}) used /whois with Identifier: ${identifier}, Value: ${value}`);

        if (!serverInstance.config.connectors ||
            !serverInstance.config.connectors.mysql ||
            !serverInstance.config.connectors.mysql.enabled) {
            await interaction.editReply('MySQL is not enabled in the configuration. This command cannot be used.');
            return;
        }

        const pool = process.mysqlPool || serverInstance.mysqlPool;

        if (!pool) {
            await interaction.editReply('Database connection is not initialized.');
            return;
        }

        const fieldMap = {
            beguid: 'beGUID',
            uuid: 'playerUID',
            name: 'playerName',
            ip: 'playerIP',
            steamid: 'steamID'
        };

        const dbField = fieldMap[identifier.toLowerCase()];

        if (!dbField) {
            await interaction.editReply(`Invalid identifier provided: ${identifier}.`);
            return;
        }

        if (identifier.toLowerCase() === 'steamid') {
            if (!/^\d{17}$/.test(value)) {
                await interaction.editReply('Invalid SteamID format. SteamID should be 17 digits long.');
                return;
            }
        }

        try {
            let query;
            let params;
            
            if (dbField === 'playerName') {
                query = `SELECT playerName, playerIP, playerUID, beGUID, steamID, device FROM players WHERE ${dbField} LIKE ?`;
                params = [`%${value}%`];
            } else {
                query = `SELECT playerName, playerIP, playerUID, beGUID, steamID, device FROM players WHERE ${dbField} = ?`;
                params = [value];
            }

            const [rows] = await pool.query(query, params);

            if (rows.length === 0) {
                await interaction.editReply(`No information can be found for ${identifier}: ${value}`);
                return;
            }

            if (dbField === 'playerName' && rows.length > 1) {
                const displayCount = Math.min(rows.length, 10);
                let responseMessage = `Found ${rows.length} players matching "${value}". `;
                
                if (rows.length > 10) {
                    responseMessage += `Showing first 10 results. Please refine your search for more specific results.\n\n`;
                } else {
                    responseMessage += `Full details for each match:\n\n`;
                }
                
                for (let i = 0; i < displayCount; i++) {
                    const player = rows[i];
                    let playerDetails = `${i+1}. ${player.playerName || 'Unknown'}\n` +
                                       `   UUID: ${player.playerUID || 'Missing'}\n` +
                                       `   IP: ${player.playerIP || 'Missing'}\n` +
                                       `   beGUID: ${player.beGUID || 'Missing'}\n` +
                                       `   Device: ${player.device || 'Not Found'}\n`;
                    
                    if (player.device === 'PC') {
                        playerDetails += `   SteamID: ${player.steamID || 'Not Found'}\n`;
                    }
                    
                    responseMessage += playerDetails + '\n';
                }
                
                await interaction.editReply(responseMessage);
                return;
            }

            const embeds = [];
            const components = [];
            let currentEmbed = {
                title: 'Reforger Lookup Directory',
                description: `🔍 Whois: ${value}\n\n`,
                color: 0xFFA500,
                fields: [],
                footer: {
                    text: 'ReforgerJS'
                }
            };

            // Check if SeedTracker is available for button integration
            const seedTracker = process.seedTracker;
            const seedEnabled = seedTracker && seedTracker.isInitialized;

            rows.forEach((player, index) => {
                let playerInfo = `Name: ${player.playerName || 'Missing Player Name'}\n` +
                               `IP Address: ${player.playerIP || 'Missing IP Address'}\n` +
                               `Reforger UUID: ${player.playerUID || 'Missing UUID'}\n` +
                               `be GUID: ${player.beGUID || 'Missing beGUID'}\n` +
                               `Device: ${player.device || 'Not Found'}`;
                
                if (player.device === 'PC') {
                    playerInfo += `\nSteamID: ${player.steamID || 'Not Found'}`;
                }
                
                const playerData = {
                    name: `Player ${index + 1}`,
                    value: playerInfo
                };

                currentEmbed.fields.push(playerData);

                // Add seed tracker buttons for the first player (if single result or first of multiple)
                if (index === 0 && seedEnabled && player.playerUID) {
                    const playerUID = player.playerUID;
                    const playerName = player.playerName || 'Unknown';
                    const isInList = seedTracker.playerList.includes(playerUID.toLowerCase());
                    const mode = seedTracker.playerListMode;
                    
                    // Add seed tracker status to player info
                    const listStatus = isInList ? `✅ In ${mode}` : `❌ Not in ${mode}`;
                    const trackingStatus = seedTracker.shouldTrackPlayer(playerUID) ? '🟢 Being Tracked' : '🔴 Not Tracked';
                    
                    currentEmbed.fields.push({
                        name: '🌱 Seed Tracker Status',
                        value: `${trackingStatus}\n`,
                        inline: false
                    });

                    // Create action buttons
                    const actionRow = new ActionRowBuilder();
                    
                    if (isInList) {
                        // Player is in list - show remove button
                        actionRow.addComponents(
                            new ButtonBuilder()
                                .setCustomId(`whois-remove-${playerUID}`)
                                .setLabel(`Remove from ${mode}`)
                                .setStyle(ButtonStyle.Danger)
                                .setEmoji('➖')
                        );
                    } else {
                        // Player not in list - show add button
                        actionRow.addComponents(
                            new ButtonBuilder()
                                .setCustomId(`whois-add-${playerUID}`)
                                .setLabel(`Add to ${mode}`)
                                .setStyle(ButtonStyle.Success)
                                .setEmoji('➕')
                        );
                    }
                    
                    // Add info button
                    actionRow.addComponents(
                        new ButtonBuilder()
                            .setCustomId(`whois-info-${playerUID}`)
                            .setLabel('Seed Info')
                            .setStyle(ButtonStyle.Secondary)
                            .setEmoji('ℹ️')
                    );

                    components.push(actionRow);
                }

                const embedLength = JSON.stringify(currentEmbed).length;
                if (embedLength >= 5900) {
                    embeds.push(currentEmbed);
                    currentEmbed = {
                        title: 'Reforger Lookup Directory (Continued)',
                        description: '',
                        color: 0xFFA500,
                        fields: [],
                        footer: {
                            text: 'ReforgerJS'
                        }
                    };
                }
            });

            if (currentEmbed.fields.length > 0) {
                embeds.push(currentEmbed);
            }

            // Send the first embed with components
            const firstEmbed = embeds[0];
            const messageOptions = { embeds: [firstEmbed] };
            if (components.length > 0) {
                messageOptions.components = components;
            }

            await interaction.editReply(messageOptions);

            // Send additional embeds as follow-ups if needed
            for (let i = 1; i < embeds.length; i++) {
                await interaction.followUp({ embeds: [embeds[i]], ephemeral: true });
            }

        } catch (queryError) {
            logger.error(`[Whois Command] Database query error: ${queryError.message}`);
            await interaction.editReply('An error occurred while querying the database.');
        }
    } catch (error) {
        logger.error(`[Whois Command] Unexpected error: ${error.message}`);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
                content: 'An unexpected error occurred while executing the command.',
                ephemeral: true
            });
        } else if (interaction.deferred && !interaction.replied) {
            await interaction.editReply('An unexpected error occurred while executing the command.');
        }
    }
}

// Button handler function for whois-related buttons
async function handleButton(interaction, serverInstance, discordClient, extraData = {}) {
    const { buttonId } = extraData;
    const user = interaction.user;
    
    logger.info(`[Whois Button] User: ${user.username} (ID: ${user.id}) clicked button: ${buttonId}`);

    // Check if SeedTracker is available
    const seedTracker = process.seedTracker;
    if (!seedTracker || !seedTracker.isInitialized) {
        await interaction.reply({
            content: '❌ Seed Tracker is not available.',
            ephemeral: true
        });
        return;
    }

    // Parse button ID: format is action-playerUID
    const parts = buttonId.split('-');
    if (parts.length < 2) {
        await interaction.reply({
            content: '❌ Invalid button configuration.',
            ephemeral: true
        });
        return;
    }

    const action = parts[0];
    const playerUID = parts.slice(1).join('-'); // Rejoin in case UUID has dashes

    try {
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ ephemeral: true });
        }

        // Get player name from database for better UX
        let playerName = 'Unknown Player';
        try {
            const pool = process.mysqlPool || serverInstance.mysqlPool;
            if (pool) {
                const [rows] = await pool.query(
                    'SELECT playerName FROM players WHERE playerUID = ? LIMIT 1',
                    [playerUID]
                );
                if (rows.length > 0) {
                    playerName = rows[0].playerName;
                }
            }
        } catch (dbError) {
            logger.warn(`[Whois Button] Could not fetch player name: ${dbError.message}`);
        }

        switch (action) {
            case 'add':
                const addResult = await seedTracker.addPlayerToList(playerUID);
                await saveConfig(serverInstance.config);
                
                if (addResult.success) {
                    await interaction.editReply({
                        content: `✅ **${playerName}** has been added to the ${seedTracker.playerListMode}.`
                    });
                    logger.info(`[Whois Button] User ${user.username} added ${playerName} (${playerUID}) to ${seedTracker.playerListMode}`);
                } else {
                    await interaction.editReply({
                        content: `❌ ${addResult.message}: **${playerName}**`
                    });
                }
                break;

            case 'remove':
                const removeResult = await seedTracker.removePlayerFromList(playerUID);
                await saveConfig(serverInstance.config);
                
                if (removeResult.success) {
                    await interaction.editReply({
                        content: `✅ **${playerName}** has been removed from the ${seedTracker.playerListMode}.`
                    });
                    logger.info(`[Whois Button] User ${user.username} removed ${playerName} (${playerUID}) from ${seedTracker.playerListMode}`);
                } else {
                    await interaction.editReply({
                        content: `❌ ${removeResult.message}: **${playerName}**`
                    });
                }
                break;

            case 'info':
                // Show detailed seed tracker info for this player
                const isInList = seedTracker.playerList.includes(playerUID.toLowerCase());
                const mode = seedTracker.playerListMode;
                const isTracked = seedTracker.shouldTrackPlayer(playerUID);
                
                // Get seeding stats if available
                let seedingStats = 'No data available';
                try {
                    const pool = process.mysqlPool || serverInstance.mysqlPool;
                    if (pool) {
                        const [rows] = await pool.query(
                            `SELECT totalMinutes, lastSeen FROM seeder_totals WHERE playerUID = ?`,
                            [playerUID.toLowerCase()]
                        );
                        if (rows.length > 0) {
                            const hours = (rows[0].totalMinutes / 60).toFixed(2);
                            const lastSeen = new Date(rows[0].lastSeen).toLocaleDateString();
                            seedingStats = `${hours} hours (${rows[0].totalMinutes} minutes)\nLast seen: ${lastSeen}`;
                        }
                    }
                } catch (statsError) {
                    logger.warn(`[Whois Button] Could not fetch seeding stats: ${statsError.message}`);
                }

                const infoEmbed = new EmbedBuilder()
                    .setTitle('🌱 Seed Tracker Information')
                    .setColor(isTracked ? 0x00ff00 : 0xff0000)
                    .addFields(
                        { name: 'Player', value: `${playerName}\n\`${playerUID}\``, inline: false },
                        { name: 'Tracking Status', value: isTracked ? '🟢 Being Tracked' : '🔴 Not Tracked', inline: true },
                        { name: 'Seeding Statistics', value: seedingStats, inline: false },
                    )
                    .setTimestamp()
                    .setFooter({ text: 'SeedTracker - ReforgerJS' });

                await interaction.editReply({ embeds: [infoEmbed] });
                break;

            default:
                await interaction.editReply({
                    content: '❌ Unknown button action.',
                });
                break;
        }

    } catch (error) {
        logger.error(`[Whois Button] Error handling button ${buttonId}: ${error.message}`);
        
        if (interaction.deferred && !interaction.replied) {
            await interaction.editReply({
                content: '❌ An error occurred while processing your request.'
            });
        } else if (!interaction.replied) {
            await interaction.reply({
                content: '❌ An error occurred while processing your request.',
                ephemeral: true
            });
        }
    }
}

// Helper function to save configuration
async function saveConfig(config) {
    try {
        const configPath = path.resolve(__dirname, '../../config.json');
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
        logger.verbose('[Whois Button] Configuration saved successfully');
    } catch (error) {
        logger.error(`[Whois Button] Error saving configuration: ${error.message}`);
        throw error;
    }
}

// Export both functions
module.exports = executeWhois;
module.exports.handleButton = handleButton;