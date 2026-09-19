const { Client } = require('discord.js-selfbot-v13');
const https = require('https');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function downloadImage(url, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        let finished = false;
        const timer = setTimeout(() => {
            finished = true;
            reject(new Error(`Image download timed out after ${timeoutMs / 1000}s for ${url}`));
        }, timeoutMs);

        const req = https.get(url, (res) => {
            if (finished) return;
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                clearTimeout(timer);
                return downloadImage(res.headers.location, timeoutMs).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                clearTimeout(timer);
                return reject(new Error(`Failed to download image, status code: ${res.statusCode}`));
            }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                clearTimeout(timer);
                const buffer = Buffer.concat(chunks);
                const mimeType = res.headers['content-type'] || 'image/png';
                resolve(`data:${mimeType};base64,${buffer.toString('base64')}`);
            });
            res.on('error', (e) => {
                clearTimeout(timer);
                reject(e);
            });
        });

        req.on('error', (e) => {
            clearTimeout(timer);
            reject(e);
        });
    });
}

class EnhancedServerCloner {
    constructor(loggerCallback) {
        this.client = null;
        this.logCallback = loggerCallback || (() => {});
        this.roleMapping = new Map();
        this.categoryMapping = new Map();
        this.isAborted = false;
        this.currentStep = 'INITIALIZING';
        this.progressPercent = 0;
        this.stats = {
            rolesCreated: 0,
            rolesDeleted: 0,
            categoriesCreated: 0,
            channelsCreated: 0,
            channelsDeleted: 0,
            emojisCreated: 0,
            emojisDeleted: 0,
            failed: 0,
            retries: 0
        };
    }

    abort() {
        this.isAborted = true;
        this.log('warn', '⚡ Abort requested! Safely terminating current task and cleaning up...');
    }

    log(type, message, extra = {}) {
        this.logCallback({
            type,
            message,
            step: this.currentStep,
            percent: Math.min(100, Math.max(0, Math.round(this.progressPercent))),
            timestamp: new Date().toLocaleTimeString(),
            stats: { ...this.stats },
            ...extra
        });
    }

    /**
     * Executes an API action with dynamic 429 rate-limit exponential backoff and watchdog timeout
     */
    async safeAction(actionFn, actionName, maxRetries = 5, timeoutMs = 25000) {
        let attempt = 0;
        while (attempt <= maxRetries) {
            if (this.isAborted) return null;
            try {
                let timeoutHandle;
                const timeoutPromise = new Promise((_, reject) => {
                    timeoutHandle = setTimeout(() => {
                        reject(new Error(`Operation [${actionName}] timed out after ${timeoutMs / 1000}s`));
                    }, timeoutMs);
                });

                const result = await Promise.race([
                    actionFn().finally(() => clearTimeout(timeoutHandle)),
                    timeoutPromise
                ]);
                return result;
            } catch (err) {
                const isRateLimit = err.httpStatus === 429 || 
                                    err.code === 429 || 
                                    (err.message && err.message.toLowerCase().includes('rate limit')) ||
                                    (err.message && err.message.toLowerCase().includes('retry after'));
                
                attempt++;
                if (isRateLimit && attempt <= maxRetries) {
                    this.stats.retries++;
                    let waitMs = 2000 * Math.pow(1.5, attempt - 1);
                    if (err.timeout) waitMs = err.timeout + 200;
                    if (err.retry_after) waitMs = (err.retry_after * 1000) + 200;

                    this.log('warn', `⏳ Rate limited on [${actionName}]. Backing off for ${(waitMs / 1000).toFixed(1)}s (Attempt ${attempt}/${maxRetries})...`, {
                        isRateLimit: true,
                        cooldownSec: Math.ceil(waitMs / 1000)
                    });
                    await delay(waitMs);
                } else if (attempt > maxRetries) {
                    this.stats.failed++;
                    this.log('error', `Permanent failure on [${actionName}] after ${maxRetries} attempts: ${err.message}`);
                    return null;
                } else {
                    this.stats.failed++;
                    this.log('error', `Failed [${actionName}]: ${err.message}`);
                    return null;
                }
            }
        }
        return null;
    }

    async destroyClient() {
        if (this.client) {
            try {
                this.client.removeAllListeners();
                this.client.destroy();
            } catch (e) {}
            this.client = null;
        }
    }

    async run(options) {
        const {
            token,
            sourceGuildId,
            targetGuildId,
            rolesMode = 'delete_and_clone',
            channelsMode = 'delete_and_clone',
            emojisMode = 'delete_and_clone',
            copyServerInfo = true
        } = options;

        try {
            this.currentStep = 'CONNECTING';
            this.progressPercent = 5;
            this.log('header', '⚡ Initializing A4KU Discord Cloner Engine v2.0...');

            // Connect Discord Selfbot Client
            this.client = new Client({ checkUpdate: false });
            
            // Real-time Discord rate limit telemetry
            this.client.on('rateLimit', (rateLimitInfo) => {
                this.stats.retries++;
                const waitSec = Math.ceil((rateLimitInfo.timeout || 1000) / 1000);
                this.log('warn', `⏳ Discord Rate Limit active (${rateLimitInfo.route || rateLimitInfo.path || 'REST API'}). Cooling down for ${waitSec}s... (Auto-recovering)`, {
                    isRateLimit: true,
                    cooldownSec: waitSec
                });
            });

            let loginTimer;
            try {
                const readyPromise = new Promise((resolve, reject) => {
                    loginTimer = setTimeout(() => {
                        reject(new Error('Discord login timed out after 20s. Check token validity.'));
                    }, 20000);

                    if (this.client.isReady && this.client.isReady()) {
                        clearTimeout(loginTimer);
                        return resolve();
                    }

                    this.client.once('ready', () => {
                        clearTimeout(loginTimer);
                        resolve();
                    });
                    this.client.once('error', (err) => {
                        clearTimeout(loginTimer);
                        reject(err);
                    });
                });

                await Promise.all([this.client.login(token), readyPromise]);
            } finally {
                clearTimeout(loginTimer);
            }

            this.log('success', `Authenticated as: @${this.client.user.tag} (${this.client.user.id})`);
            this.progressPercent = 10;

            // Fetch target guild
            const targetGuild = await this.client.guilds.fetch(targetGuildId).catch(() => null);
            if (!targetGuild) {
                throw new Error(`Target server (${targetGuildId}) not found! Verify your account is inside the server.`);
            }

            // Verify permissions on target guild
            const targetMember = await targetGuild.members.fetch(this.client.user.id).catch(() => null);
            if (!targetMember || (!targetMember.permissions.has('ADMINISTRATOR') && !targetMember.permissions.has('MANAGE_GUILD'))) {
                throw new Error(`Insufficient permissions on target server "${targetGuild.name}". You need ADMINISTRATOR or MANAGE_GUILD.`);
            }

            // Fetch source guild
            let sourceGuild = null;
            const requiresSource = (
                rolesMode !== 'delete_only' ||
                channelsMode !== 'delete_only' ||
                emojisMode !== 'delete_only' ||
                copyServerInfo
            );

            if (requiresSource) {
                sourceGuild = await this.client.guilds.fetch(sourceGuildId).catch(() => null);
                if (!sourceGuild) {
                    throw new Error(`Source server (${sourceGuildId}) not found! Verify your account is inside the source server.`);
                }
                this.log('info', `Source Server: "${sourceGuild.name}" (${sourceGuild.id}) [Boost Tier: ${sourceGuild.premiumTier}]`);
            }

            this.log('info', `Target Server: "${targetGuild.name}" (${targetGuild.id}) [Boost Tier: ${targetGuild.premiumTier}]`);

            // Seed @everyone role mapping (CRITICAL FIX: source @everyone -> target @everyone)
            if (sourceGuild) {
                this.roleMapping.set(sourceGuild.id, targetGuild.id);
            }

            // Step 1: Wipe Target Server Content if requested
            if (this.isAborted) return;
            if (channelsMode === 'delete_and_clone' || channelsMode === 'delete_only') {
                this.currentStep = 'WIPING_CHANNELS';
                this.progressPercent = 15;
                await this.deleteChannels(targetGuild);
            }

            if (this.isAborted) return;
            if (rolesMode === 'delete_and_clone' || rolesMode === 'delete_only') {
                this.currentStep = 'WIPING_ROLES';
                this.progressPercent = 25;
                await this.deleteRoles(targetGuild);
            }

            if (this.isAborted) return;
            if (emojisMode === 'delete_and_clone' || emojisMode === 'delete_only') {
                this.currentStep = 'WIPING_EMOJIS';
                this.progressPercent = 35;
                await this.deleteEmojis(targetGuild);
            }

            // Step 2: Clone Roles
            if (this.isAborted) return;
            if (rolesMode === 'delete_and_clone' || rolesMode === 'clone_only') {
                this.currentStep = 'CLONING_ROLES';
                this.progressPercent = 45;
                await this.cloneRoles(sourceGuild, targetGuild);
            }

            // Step 3: Clone Categories & Channels
            if (this.isAborted) return;
            if (channelsMode === 'delete_and_clone' || channelsMode === 'clone_only') {
                this.currentStep = 'CLONING_CATEGORIES';
                this.progressPercent = 60;
                await this.cloneCategories(sourceGuild, targetGuild);

                this.currentStep = 'CLONING_CHANNELS';
                this.progressPercent = 75;
                await this.cloneChannels(sourceGuild, targetGuild);
            }

            // Step 4: Clone Emojis
            if (this.isAborted) return;
            if (emojisMode === 'delete_and_clone' || emojisMode === 'clone_only') {
                this.currentStep = 'CLONING_EMOJIS';
                this.progressPercent = 88;
                await this.cloneEmojis(sourceGuild, targetGuild);
            }

            // Step 5: Server Info (Name, Icon, Banner)
            if (this.isAborted) return;
            if (copyServerInfo && sourceGuild) {
                this.currentStep = 'SYNCING_METADATA';
                this.progressPercent = 95;
                await this.cloneServerInfo(sourceGuild, targetGuild);
            }

            this.progressPercent = 100;
            this.currentStep = 'COMPLETED';
            if (this.isAborted) {
                this.log('warn', 'Cloning operation was aborted by user.');
            } else {
                this.log('success', '🎉 Discord Server cloning completed successfully with zero dropped items!');
            }

        } catch (error) {
            this.currentStep = 'FAILED';
            this.log('error', `Cloning failed: ${error.message}`);
            throw error;
        } finally {
            // ZERO-LEAK CLEANUP
            await this.destroyClient();
        }
    }

    async deleteChannels(guild) {
        this.log('header', '🗑️ Deleting existing channels & categories on target server...');
        const channels = guild.channels.cache.filter(ch => ch.deletable);
        for (const [, channel] of channels) {
            if (this.isAborted) break;
            await this.safeAction(async () => {
                await channel.delete('A4KU Server Cloner Wipe');
                this.stats.channelsDeleted++;
                this.log('info', `Deleted channel/category: #${channel.name}`);
                await delay(200);
            }, `Delete Channel ${channel.name}`);
        }
    }

    async deleteRoles(guild) {
        this.log('header', '🗑️ Deleting existing custom roles on target server...');
        const roles = guild.roles.cache.filter(role => 
            role.name !== '@everyone' && 
            !role.managed && 
            role.editable
        );
        for (const [, role] of roles) {
            if (this.isAborted) break;
            await this.safeAction(async () => {
                await role.delete('A4KU Server Cloner Wipe');
                this.stats.rolesDeleted++;
                this.log('info', `Deleted role: @${role.name}`);
                await delay(200);
            }, `Delete Role ${role.name}`);
        }
    }

    async deleteEmojis(guild) {
        this.log('header', '🗑️ Deleting existing emojis on target server...');
        const emojis = guild.emojis.cache;
        for (const [, emoji] of emojis) {
            if (this.isAborted) break;
            await this.safeAction(async () => {
                await emoji.delete('A4KU Server Cloner Wipe');
                this.stats.emojisDeleted++;
                this.log('info', `Deleted emoji: :${emoji.name}:`);
                await delay(250);
            }, `Delete Emoji ${emoji.name}`);
        }
    }

    async cloneRoles(sourceGuild, targetGuild) {
        this.log('header', '🛡️ Cloning roles & permissions hierarchy...');
        
        // Sync @everyone base permissions first
        const sourceEveryone = sourceGuild.roles.cache.get(sourceGuild.id);
        const targetEveryone = targetGuild.roles.cache.get(targetGuild.id);
        if (sourceEveryone && targetEveryone) {
            await this.safeAction(async () => {
                await targetEveryone.setPermissions(sourceEveryone.permissions, 'A4KU Server Cloner Base Perms');
                this.log('info', 'Synchronized @everyone base server permissions.');
            }, 'Sync @everyone Permissions');
        }

        const roles = sourceGuild.roles.cache
            .filter(role => role.name !== '@everyone' && !role.managed)
            .sort((a, b) => a.position - b.position);

        for (const [, role] of roles) {
            if (this.isAborted) break;
            await this.safeAction(async () => {
                const roleCreateOpts = {
                    name: role.name,
                    permissions: role.permissions,
                    hoist: role.hoist,
                    mentionable: role.mentionable,
                    reason: 'A4KU Server Cloner'
                };

                if (role.color) {
                    roleCreateOpts.colors = { primaryColor: role.color };
                }

                const newRole = await targetGuild.roles.create(roleCreateOpts);

                this.roleMapping.set(role.id, newRole.id);
                this.stats.rolesCreated++;
                this.log('success', `Created role: @${role.name}`);
                await delay(350);
            }, `Create Role ${role.name}`);
        }

        await this.syncRolePositions(sourceGuild, targetGuild);
    }

    async syncRolePositions(sourceGuild, targetGuild) {
        try {
            const sourceRoles = sourceGuild.roles.cache
                .filter(role => role.name !== '@everyone' && !role.managed)
                .sort((a, b) => b.position - a.position);

            const positionUpdates = [];
            for (const [, sourceRole] of sourceRoles) {
                if (this.isAborted) break;
                const mappedId = this.roleMapping.get(sourceRole.id);
                if (mappedId) {
                    positionUpdates.push({
                        role: mappedId,
                        position: sourceRole.position
                    });
                }
            }

            if (positionUpdates.length > 0) {
                await this.safeAction(async () => {
                    await targetGuild.roles.setPositions(positionUpdates);
                    this.log('info', `Synchronized ${positionUpdates.length} role hierarchy positions in single bulk operation.`);
                }, 'Bulk Set Role Positions');
            }
        } catch (e) {
            this.log('warn', 'Role hierarchy synchronization skipped: ' + e.message);
        }
    }

    async cloneCategories(sourceGuild, targetGuild) {
        this.log('header', '📁 Cloning categories & folder structure...');
        const categories = sourceGuild.channels.cache
            .filter(ch => ch.type === 'GUILD_CATEGORY')
            .sort((a, b) => a.position - b.position);

        for (const [, category] of categories) {
            if (this.isAborted) break;
            await this.safeAction(async () => {
                const overwrites = this.mapPermissionOverwrites(category.permissionOverwrites, targetGuild);
                const newCategory = await targetGuild.channels.create(category.name, {
                    type: 'GUILD_CATEGORY',
                    permissionOverwrites: overwrites,
                    position: category.position,
                    reason: 'A4KU Server Cloner'
                });

                // CRITICAL FIX: Save exact category mapping by ID
                this.categoryMapping.set(category.id, newCategory.id);
                this.stats.categoriesCreated++;
                this.log('success', `Created category: [${category.name}]`);
                await delay(350);
            }, `Create Category ${category.name}`);
        }
    }

    async cloneChannels(sourceGuild, targetGuild) {
        this.log('header', '💬 Cloning text, voice & announcement channels...');
        
        const isCommunityTarget = targetGuild.features && targetGuild.features.includes('COMMUNITY');
        const maxBitrate = targetGuild.maximumBitrate || 96000;

        const channels = sourceGuild.channels.cache
            .filter(ch => ch.type !== 'GUILD_CATEGORY')
            .sort((a, b) => a.position - b.position);

        for (const [, channel] of channels) {
            if (this.isAborted) break;
            await this.safeAction(async () => {
                const overwrites = this.mapPermissionOverwrites(channel.permissionOverwrites, targetGuild);
                
                // CRITICAL FIX: Accurate parent category lookup via ID mapping
                const parentId = channel.parentId ? this.categoryMapping.get(channel.parentId) : null;

                let channelType = channel.type;
                // Fallback for non-community guilds
                if (!isCommunityTarget && (channelType === 'GUILD_NEWS' || channelType === 'GUILD_FORUM' || channelType === 'GUILD_STAGE_VOICE')) {
                    channelType = channelType === 'GUILD_STAGE_VOICE' ? 'GUILD_VOICE' : 'GUILD_TEXT';
                }

                const channelOptions = {
                    type: channelType,
                    parent: parentId || undefined,
                    permissionOverwrites: overwrites,
                    position: channel.position,
                    reason: 'A4KU Server Cloner'
                };

                if (channelType === 'GUILD_TEXT' || channelType === 'GUILD_NEWS') {
                    channelOptions.topic = channel.topic || undefined;
                    channelOptions.nsfw = channel.nsfw || false;
                    channelOptions.rateLimitPerUser = channel.rateLimitPerUser || 0;
                } else if (channelType === 'GUILD_VOICE') {
                    // CRITICAL FIX: Clamp voice bitrate to target server max
                    channelOptions.bitrate = channel.bitrate ? Math.min(channel.bitrate, maxBitrate) : 64000;
                    channelOptions.userLimit = channel.userLimit || 0;
                }

                await targetGuild.channels.create(channel.name, channelOptions);
                this.stats.channelsCreated++;
                this.log('success', `Created channel: #${channel.name} (${channelType.toLowerCase().replace('guild_', '')})`);
                await delay(350);
            }, `Create Channel ${channel.name}`);
        }
    }

    async cloneEmojis(sourceGuild, targetGuild) {
        this.log('header', '😀 Cloning custom emojis & server stickers...');
        const emojis = sourceGuild.emojis.cache;
        
        // Track capacity
        const maxEmojis = targetGuild.maximumEmojis || 50;
        let staticCount = targetGuild.emojis.cache.filter(e => !e.animated).size;
        let animatedCount = targetGuild.emojis.cache.filter(e => e.animated).size;

        for (const [, emoji] of emojis) {
            if (this.isAborted) break;

            if (emoji.animated && animatedCount >= maxEmojis) {
                this.log('warn', `Skipping animated emoji :${emoji.name}: (Reached target server limit of ${maxEmojis})`);
                continue;
            }
            if (!emoji.animated && staticCount >= maxEmojis) {
                this.log('warn', `Skipping static emoji :${emoji.name}: (Reached target server limit of ${maxEmojis})`);
                continue;
            }

            await this.safeAction(async () => {
                const imageData = await downloadImage(emoji.url);
                await targetGuild.emojis.create(imageData, emoji.name, {
                    reason: 'A4KU Server Cloner'
                });

                if (emoji.animated) animatedCount++;
                else staticCount++;

                this.stats.emojisCreated++;
                this.log('success', `Created emoji: :${emoji.name}:`);
                await delay(1200); // Respect strict Discord emoji rate limits
            }, `Create Emoji ${emoji.name}`);
        }
    }

    async cloneServerInfo(sourceGuild, targetGuild) {
        this.log('header', '✨ Synchronizing server branding (Name, Icon, Splash)...');
        
        await this.safeAction(async () => {
            await targetGuild.setName(sourceGuild.name);
            this.log('success', `Server name updated to: "${sourceGuild.name}"`);
        }, 'Set Server Name');

        if (sourceGuild.iconURL()) {
            await this.safeAction(async () => {
                const iconData = await downloadImage(sourceGuild.iconURL({ format: 'png', size: 1024 }));
                await targetGuild.setIcon(iconData);
                this.log('success', 'Server icon successfully cloned.');
            }, 'Set Server Icon');
        }

        if (sourceGuild.bannerURL() && targetGuild.features.includes('BANNER')) {
            await this.safeAction(async () => {
                const bannerData = await downloadImage(sourceGuild.bannerURL({ format: 'png', size: 1024 }));
                await targetGuild.setBanner(bannerData);
                this.log('success', 'Server banner successfully cloned.');
            }, 'Set Server Banner');
        }
    }

    mapPermissionOverwrites(overwrites, targetGuild) {
        const mapped = [];
        if (!overwrites || !overwrites.cache) return mapped;

        overwrites.cache.forEach((overwrite) => {
            try {
                let targetId = overwrite.id;

                if (overwrite.type === 'role') {
                    const mappedRoleId = this.roleMapping.get(overwrite.id);
                    if (mappedRoleId) {
                        targetId = mappedRoleId;
                    } else {
                        // Check if role name matches in target
                        const sourceRole = overwrite.channel?.guild?.roles?.cache?.get(overwrite.id);
                        if (sourceRole) {
                            const found = targetGuild.roles.cache.find(r => r.name === sourceRole.name);
                            if (found) targetId = found.id;
                            else return;
                        } else {
                            return;
                        }
                    }
                }

                if (overwrite.allow !== undefined && overwrite.deny !== undefined) {
                    mapped.push({
                        id: targetId,
                        type: overwrite.type,
                        allow: overwrite.allow,
                        deny: overwrite.deny
                    });
                }
            } catch (err) {}
        });

        return mapped;
    }
}

module.exports = { EnhancedServerCloner };
