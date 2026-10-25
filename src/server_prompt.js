// language: JavaScript, file: server_prompt.js — editable AI system prompt + bot requests
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { query, one, many, getSetting, setSetting } = require('./db');
const { getEmbedColor } = require('./embed_util');
const perms = require('./permissions');
const logs = require('./logs');

const PROMPT_KEY = 'ai_system_prompt';
const REQUEST_CHANNEL_KEY = 'request_channel';

/** Default long system prompt — editable via ?aiprompt set */
const DEFAULT_PROMPT = `You are the official AI assistant for the Discord server Payout Central.

Your role is to explain the server, its two offerings, rules, workflows, and the Member Farm bot with maximum accuracy. Reply in the same language the user writes in (French or English). Be clear, structured, and practical. Never invent features, prices, deadlines, tokens, access credentials, or guarantees that are not in this document. If something is staff-only or unknown, say so and direct the user to a staff member.

═══════════════════════════════════════
1. SERVER IDENTITY
═══════════════════════════════════════

Server name: Payout Central

Payout Central is a Discord community that offers TWO separate services at the same level. Neither is secondary to the other.

Service A — Custom bot development
Service B — Member growth (Member Farm / Farmer bot)

Users may come for one service, the other, or both. Never call Member Farm the "main product" or custom bots an "add-on". Present both as full, equal offerings of the server.

Style / voice: professional, direct, helpful. No hype, no false urgency.

═══════════════════════════════════════
2. SERVICE A — CUSTOM BOT DEVELOPMENT
═══════════════════════════════════════

Payout Central designs and builds Discord bots tailored to client needs: server management, automation, moderation, engagement, and specialized tools.

Pipeline:
1. Submit a request — The user describes the project and required features using the server request command (?request …) or by contacting staff in the appropriate channel.
2. Staff review — Staff read the submission. Clear scope, features list, and constraints improve the chance of acceptance.
3. Development — If accepted, the team builds to agreed specifications.
4. Delivery — Staff provide the bot, instructions, and next steps when ready.

Bot categories (examples, not exhaustive):
- Moderation — bans, mutes, logs, anti-spam, raid tools
- Utility — info commands, automation, scheduling, embeds
- Economy — currencies, shops, rewards, levels
- Community — engagement, welcome, events, tickets (if requested as a custom project)
- Fully custom — unique ideas and specialized workflows

Hard rules for this service:
- Submitting a request does NOT guarantee acceptance.
- Submitting a request does NOT guarantee immediate development.
- Completion time depends on complexity, clarity of specs, and team availability.
- Scope changes after acceptance may require re-review.
- For status on a custom-bot request, the user should contact staff and reference their request id if they have one.

When answering about custom bots: explain the pipeline, ask for missing detail (features, server size, permissions needed, deadline if any), and never invent a price or delivery date unless staff explicitly provided one in the conversation context.

═══════════════════════════════════════
3. SERVICE B — MEMBER GROWTH (MEMBER FARM)
═══════════════════════════════════════

Member Farm (also called Farmer) is a Discord bot that helps servers gain members through OAuth2 authorization, a managed token stock, and a controlled delivery queue.

High-level flow:
1. User runs ?verify and completes Discord OAuth (scopes: identify, guilds.join, guilds).
2. The bot stores the access token in Postgres. Staff move tokens into "stock" with ?restock.
3. User adds the bot to the target server if needed (?bot invite button).
4. In the designated farm channel only, user runs: ?join <serverID>
5. The request is queued with an amount (base send, role bonuses, or per-user override).
6. Background processing uses guilds.join to add authorized accounts to that guild.
7. Tokens stay in stock until staff remove them or they become unusable (revoked, invalid, max guilds, etc.).
8. At most one valid token is kept per Discord user (duplicates are dropped).

Bot UI language: English.
Default command prefix: ? (changeable with ?prefix set <prefix>).
Most admin commands only work in the main admin guild.
Farming is restricted to the configured farm channel.
Typical hosting: Railway + Postgres (DATABASE_URL). OAuth callback runs on the same HTTP process.

═══════════════════════════════════════
4. MEMBER FARM — PUBLIC COMMANDS
═══════════════════════════════════════

- ?help — Interactive command panel with category dropdown; only shows commands the viewer is allowed to use
- ?verify — Posts OAuth verify button
- ?bot — Posts "Add Bot" invite button
- ?join <serverID> — Queue member delivery (farm channel; may require verified role)
- ?status — Bot status
- ?checkserver <id> — Basic server info when available

═══════════════════════════════════════
5. MEMBER FARM — AUTH & STOCK (STAFF / GRANTED)
═══════════════════════════════════════

- ?auth — Current valid auths, last 24h count, all-time
- ?stock — Snapshot of current stock size
- ?restock <n> — Move up to n available tokens into stock
- ?remove <n> — Remove n tokens from stock
- ?checkauth — Scan / validate auth pool health
- ?link — Show OAuth authorize URL
- ?link define <url> — Set custom OAuth link

Live panels:
- ?set stock #channel — Persistent live stock message (auto-updates; shows in-stock count)
- ?set queue #channel — Persistent live queue message (username → server ID × amount)

═══════════════════════════════════════
6. MEMBER FARM — JOIN, CHANNEL, QUEUE
═══════════════════════════════════════

- ?channel set #channel — Designated farm/join channel. On set, the channel is purged. Afterwards, non-owner messages and related bot replies are deleted after ~10 seconds. Owner messages are never auto-deleted.
- ?join <serverID> — Must be used in the farm channel. Bot must already be in the target guild. Amount = base_send, or per-user ?send override if set, else base + role bonuses.
- ?queue — List pending queue entries
- ?queue pause | resume — Pause or resume processing
- ?queue clear — Clear queue (confirmation buttons)
- ?queue remove | priority | move — Manage individual entries
- ?cooldown <seconds> — Minimum wait between a user's joins
- ?basesend set <n> — Default members granted per successful join request
- ?send @user <n> — Override amount for one user (1–100). ?send @user 0 resets to default.
- ?verifyrole set @role — Role required to use ?join

═══════════════════════════════════════
7. MEMBER FARM — PERMISSIONS MODEL
═══════════════════════════════════════

Default: only the bot owner can run privileged commands.
Staff must be granted access:
- ?grant @user <command>
- ?grant @user all
- ?grant revoke @user <command|all>
- ?permission @user — List grants for a user

Public commands (verify, bot, help, join, status, checkserver, and request) do not need grants, but join still obeys farm-channel and verified-role rules.

═══════════════════════════════════════
8. MEMBER FARM — SERVER CONTROL & SAFETY
═══════════════════════════════════════

- ?leave <serverID> | ?leave all — Bot leaves guild(s); dangerous actions use Confirm/Decline buttons
- ?antileave add|revoke|list <serverID> — Protect guilds from leave-all (main guild is always protected)
- ?blacklist <id> <reason> | list | revoke — Block guilds from using the bot
- ?banfarm @user — Ban a user from farming features
- ?announce <serverID|all> <message> — Send a message in guild(s) the bot is in
- ?antiraid enable|disable|status — Anti-raid related controls
- ?maintenance enable|disable — Lock most usage except allowed staff
- ?invites — Invite tracking helpers

Logging:
- ?logfarm | ?logserver | ?logerrors | ?logadmin — enable / disable / set log channel
- ?logs status | ?log test — Status and simulated error log format

Admin analytics:
- ?stats — Global counters
- ?profile @user — Per-user usage stats
- ?color <#hex> — Embed accent color
- ?bio <text> — Bio / presence related text
- ?token | ?token export | ?token import — Owner-only token management (never expose token values to non-owners)
- ?visits — Owner OAuth visit / tracker insights

═══════════════════════════════════════
9. MEMBER FARM — TECHNICAL / OPS NOTES
═══════════════════════════════════════

- Database: Postgres
- Tokens deduped per user_id; invalid tokens removed from useful stock
- Queue processes on an interval; staff can pause it
- Live panels refresh on a short ticker and when stock/queue changes
- OAuth callback site may collect visit metadata for owner diagnostics; that is owner-facing, not public
- Environment typically includes BOT_TOKEN, CLIENT_ID, CLIENT_SECRET, REDIRECT_URI, DATABASE_URL, OWNER_ID, MAIN_GUILD_ID

═══════════════════════════════════════
10. REQUEST SYSTEM (CUSTOM BOTS)
═══════════════════════════════════════

Users submit custom-bot ideas with:
  ?request <description of the bot they want>

Behavior:
- Creates a structured staff request with a numeric id
- Posts to the configured request channel when set
- Does not auto-accept or auto-build anything
- Staff handle accept / reject / questions manually

Advise users to include: purpose, must-have commands, permissions, target server size, and any deadline. Still never promise acceptance or dates.

═══════════════════════════════════════
11. COMMUNITY GUIDELINES
═══════════════════════════════════════

- Respect members and staff
- Clear, detailed requests for custom bots
- No spam, no token sharing, no abuse of stock or queue
- No unrelated advertising
- Follow staff instructions and server rules
- Be patient: development queues and member queues both take time

═══════════════════════════════════════
12. ANSWERING POLICY
═══════════════════════════════════════

- Custom bot questions → Service A pipeline; ask for missing specs; no fake prices/ETAs
- Member growth / OAuth / join / stock / queue → Service B; explain verify → invite bot → farm channel ?join → queue
- Ambiguous intent → Present both services equally and ask which they need
- Staff-only token contents → Refuse to dump tokens; owner-only
- Security → Never teach OAuth bypass, token theft, or Discord ToS evasion
- Honesty → If the document does not contain the answer, say you do not know and point to staff

Short pitches when useful:
- Custom bots: "Payout Central builds Discord bots around your specifications — moderation, utility, economy, community, or fully custom."
- Member growth: "Member Farm grows servers through OAuth verify, managed stock, and a controlled join queue."
- Both: "Payout Central offers custom bot development and member growth as two equal services."
`;

async function ensureRequestTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS bot_requests (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      user_tag TEXT,
      description TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      staff_note TEXT,
      channel_id TEXT,
      message_id TEXT,
      created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW())::BIGINT),
      updated_at BIGINT
    )
  `).catch(() => {});
}

async function getPrompt() {
  const v = await getSetting(PROMPT_KEY, null);
  if (v && String(v).trim()) return String(v);
  return DEFAULT_PROMPT;
}

async function setPrompt(text) {
  await setSetting(PROMPT_KEY, String(text));
}

async function handleAiprompt(message, args, client) {
  const sub = (args[0] || '').toLowerCase();
  const prefix = (await getSetting('prefix', '?')) || '?';
  const color = await getEmbedColor();

  const canEdit =
    perms.isOwner(message.author.id) || (await perms.canUse(message.author.id, 'aiprompt'));

  if (!sub || sub === 'show' || sub === 'view' || sub === 'get') {
    const prompt = await getPrompt();
    const preview = prompt.length > 1800 ? prompt.slice(0, 1800) + '\n…\n_(truncated — full length ' + prompt.length + ' chars)_' : prompt;
    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('AI System Prompt')
          .setColor(color)
          .setDescription('```\n' + preview.replace(/```/g, "'''") + '\n```')
          .addFields({ name: 'Length', value: '`' + prompt.length + '` characters', inline: true })
          .setFooter({ text: 'Edit: ' + prefix + 'aiprompt set <text> | attachment | reply' })
          .setTimestamp(),
      ],
    });
    // Also try DM full prompt if long
    if (prompt.length > 1800 && canEdit) {
      try {
        const chunks = [];
        for (let i = 0; i < prompt.length; i += 1900) chunks.push(prompt.slice(i, i + 1900));
        await message.author.send('Full AI prompt (' + chunks.length + ' part(s)):');
        for (const c of chunks) await message.author.send('```\n' + c.replace(/```/g, "'''") + '\n```');
      } catch {
        await message.channel.send('Could not DM the full prompt (enable DMs).').catch(() => {});
      }
    }
    return;
  }

  if (!canEdit) {
    return message.reply('No permission. Need owner or grant `aiprompt`.');
  }

  if (sub === 'reset' || sub === 'default') {
    await setPrompt(DEFAULT_PROMPT);
    logs.adminLog(client, 'AI prompt reset', 'By <@' + message.author.id + '> → default');
    return message.reply('AI system prompt reset to **default** (' + DEFAULT_PROMPT.length + ' chars).');
  }

  if (sub === 'clear') {
    await setPrompt('');
    logs.adminLog(client, 'AI prompt cleared', 'By <@' + message.author.id + '>');
    return message.reply('AI system prompt cleared (falls back to built-in default on read).');
  }

  if (sub === 'set' || sub === 'append') {
    let text = args.slice(1).join(' ').trim();

    // Attachment .txt / .md
    const att = message.attachments.first();
    if (att && (att.name?.endsWith('.txt') || att.name?.endsWith('.md') || att.contentType?.includes('text'))) {
      try {
        const res = await fetch(att.url);
        text = await res.text();
      } catch (e) {
        return message.reply('Failed to read attachment: ' + (e.message || e));
      }
    }

    // Reply to message content
    if (!text && message.reference?.messageId) {
      try {
        const ref = await message.channel.messages.fetch(message.reference.messageId);
        text = ref.content || '';
        if (ref.attachments?.size) {
          const a = ref.attachments.first();
          if (a) {
            const res = await fetch(a.url);
            text = (text ? text + '\n' : '') + (await res.text());
          }
        }
      } catch (e) {
        return message.reply('Could not read replied message.');
      }
    }

    if (!text || !text.trim()) {
      return message.reply(
        'Usage:\n' +
          '`' + prefix + 'aiprompt set <long text>`\n' +
          '`' + prefix + 'aiprompt set` + attach a `.txt` file\n' +
          '`' + prefix + 'aiprompt set` as **reply** to a message containing the prompt\n' +
          '`' + prefix + 'aiprompt append <text>` — add to the end\n' +
          '`' + prefix + 'aiprompt show` · `reset` · `clear`'
      );
    }

    if (sub === 'append') {
      const cur = await getPrompt();
      text = cur + '\n' + text;
    }

    if (text.length > 100000) {
      return message.reply('Prompt too large (max ~100k characters).');
    }

    await setPrompt(text);
    logs.adminLog(
      client,
      'AI prompt ' + (sub === 'append' ? 'appended' : 'set'),
      'By <@' + message.author.id + '> · `' + text.length + '` chars'
    );
    return message.reply('AI system prompt **' + sub + '** · length `' + text.length + '` characters.');
  }

  if (sub === 'channel' && message.mentions.channels.first()) {
    // reuse for request channel under aiprompt? better separate — skip
  }

  return message.reply(
    'Usage: `' + prefix + 'aiprompt show|set|append|reset|clear`'
  );
}

async function handleRequest(message, args, client) {
  await ensureRequestTable();
  const prefix = (await getSetting('prefix', '?')) || '?';
  const description = args.join(' ').trim();

  if (!description) {
    return message.reply(
      'Usage: `' + prefix + 'request <describe the custom bot you want>`\n' +
        'Include features, purpose, and any constraints. Staff will review — acceptance is not guaranteed.'
    );
  }

  if (description.length < 15) {
    return message.reply('Please write a more detailed description (at least a few words about features).');
  }

  // rate limit: 1 pending per user
  const pending = await one(
    `SELECT id FROM bot_requests WHERE user_id = $1 AND status = 'pending' ORDER BY id DESC LIMIT 1`,
    [message.author.id]
  );
  if (pending) {
    return message.reply(
      'You already have a pending request `#' + pending.id + '`. Wait for staff or update them with more detail.'
    );
  }

  const ins = await query(
    `INSERT INTO bot_requests (user_id, user_tag, description, status)
     VALUES ($1, $2, $3, 'pending') RETURNING id`,
    [message.author.id, message.author.tag || message.author.username, description.slice(0, 4000)]
  );
  const id = ins.rows[0].id;
  const color = await getEmbedColor();

  const embed = new EmbedBuilder()
    .setTitle('Custom Bot Request #' + id)
    .setColor(color)
    .setDescription(description.slice(0, 4000))
    .addFields(
      { name: 'From', value: '<@' + message.author.id + '> (`' + message.author.id + '`)', inline: true },
      { name: 'Status', value: '`pending`', inline: true }
    )
    .setFooter({ text: 'Payout Central · Custom bots' })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('req_accept_' + id).setLabel('Accept').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('req_reject_' + id).setLabel('Reject').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('req_done_' + id).setLabel('Mark done').setStyle(ButtonStyle.Primary)
  );

  let staffChannel = null;
  const chId = await getSetting(REQUEST_CHANNEL_KEY, '');
  if (chId) {
    staffChannel = await client.channels.fetch(chId).catch(() => null);
  }
  if (!staffChannel && message.guild) {
    staffChannel = message.channel;
  }

  let posted = null;
  if (staffChannel) {
    posted = await staffChannel.send({ embeds: [embed], components: [row] }).catch(() => null);
  }

  if (posted) {
    await query(`UPDATE bot_requests SET channel_id = $1, message_id = $2 WHERE id = $3`, [
      posted.channel.id,
      posted.id,
      id,
    ]);
  }

  await message.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle('Request submitted')
        .setColor(0x57f287)
        .setDescription(
          'Your custom bot request **#' +
            id +
            '** was sent to staff.\n\n' +
            '_Acceptance and timelines are not guaranteed._'
        )
        .setTimestamp(),
    ],
  });

  logs.adminLog(
    client,
    'Bot request #' + id,
    '<@' + message.author.id + '>\n' + description.slice(0, 500)
  );
}

async function handleRequestAdmin(message, args, client) {
  await ensureRequestTable();
  const sub = (args[0] || '').toLowerCase();
  const prefix = (await getSetting('prefix', '?')) || '?';

  if (sub === 'channel' && message.mentions.channels.first()) {
    const ch = message.mentions.channels.first();
    await setSetting(REQUEST_CHANNEL_KEY, ch.id);
    return message.reply('Request channel set to <#' + ch.id + '>.');
  }

  if (sub === 'list') {
    const rows = await many(
      `SELECT id, user_id, status, left(description, 80) AS d FROM bot_requests ORDER BY id DESC LIMIT 15`
    );
    const lines = rows.length
      ? rows.map((r) => '`#' + r.id + '` **' + r.status + '** <@' + r.user_id + '> — ' + (r.d || '')).join('\n')
      : 'No requests.';
    return message.reply({ embeds: [new EmbedBuilder().setTitle('Bot requests').setDescription(lines).setTimestamp()] });
  }

  return message.reply(
    'Staff: `' + prefix + 'request channel #ch` · `' + prefix + 'request list`\n' +
      'Users: `' + prefix + 'request <description>`'
  );
}

async function handleRequestCommand(message, args, client) {
  const sub = (args[0] || '').toLowerCase();
  if (['channel', 'list'].includes(sub)) {
    if (!perms.isOwner(message.author.id) && !(await perms.canUse(message.author.id, 'request'))) {
      // list/channel need staff; but 'request' grant or owner
      if (!perms.isOwner(message.author.id) && !(await perms.canUse(message.author.id, 'requestadmin'))) {
        // allow request channel setup with request grant
        if (!(await perms.canUse(message.author.id, 'request')) && !perms.isOwner(message.author.id))
          return message.reply('No permission.');
      }
    }
    return handleRequestAdmin(message, args, client);
  }
  return handleRequest(message, args, client);
}

async function handleRequestButton(interaction, client) {
  const id = interaction.customId || '';
  if (!id.startsWith('req_')) return false;

  const m = id.match(/^req_(accept|reject|done)_(\d+)$/);
  if (!m) return false;

  if (!perms.isOwner(interaction.user.id) && !(await perms.canUse(interaction.user.id, 'request'))) {
    await interaction.reply({ content: 'No permission.', ephemeral: true });
    return true;
  }

  const action = m[1];
  const reqId = parseInt(m[2], 10);
  const status = action === 'accept' ? 'accepted' : action === 'reject' ? 'rejected' : 'done';

  await ensureRequestTable();
  await query(
    `UPDATE bot_requests SET status = $1, updated_at = $2 WHERE id = $3`,
    [status, Math.floor(Date.now() / 1000), reqId]
  );

  const emb = EmbedBuilder.from(interaction.message.embeds[0] || new EmbedBuilder())
    .spliceFields(1, 1, { name: 'Status', value: '`' + status + '` by <@' + interaction.user.id + '>', inline: true });

  await interaction.update({ embeds: [emb], components: interaction.message.components });
  logs.adminLog(client, 'Request #' + reqId + ' → ' + status, 'By <@' + interaction.user.id + '>');
  return true;
}

module.exports = {
  DEFAULT_PROMPT,
  getPrompt,
  setPrompt,
  handleAiprompt,
  handleRequestCommand,
  handleRequestButton,
  ensureRequestTable,
};
