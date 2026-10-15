// language: JavaScript, file: apply.js — restocker application flow
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
} = require('discord.js');
const { query, one, many, getSetting, setSetting } = require('./db');
const perms = require('./permissions');
const logs = require('./logs');
const config = require('./config');

const QUESTIONS = [
  {
    id: 'why',
    text: '**Why** do you want to become a restocker on this farm?',
  },
  {
    id: 'volume',
    text: 'How many **OAuth accounts** can you realistically supply **per week**?',
  },
  {
    id: 'experience',
    text: 'Have you restocked for other member farms before? If yes, **which ones** and for how long?',
  },
  {
    id: 'quality',
    text: 'Do you understand that **invalid / phone-locked / maxed** tokens are removed from stock and repeated junk can get you revoked? (yes/no + comment)',
  },
  {
    id: 'availability',
    text: 'What is your **timezone** and usual availability for restocks?',
  },
  {
    id: 'extra',
    text: 'Anything else we should know? (optional — type `skip` to skip)',
  },
];

// in-memory sessions: userId -> { step, answers, messageId, channelId }
const sessions = new Map();

async function ensureTable() {
  await query(`
CREATE TABLE IF NOT EXISTS applications (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  user_tag TEXT,
  type TEXT DEFAULT 'restocker',
  answers JSONB NOT NULL DEFAULT '{}',
  status TEXT DEFAULT 'pending',
  reviewer_id TEXT,
  review_note TEXT,
  created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW())::BIGINT),
  reviewed_at BIGINT
);
`);
}

function buildQuestionEmbed(step, total, question) {
  return new EmbedBuilder()
    .setTitle('Restocker Application')
    .setColor(0x5865f2)
    .setDescription(
      `Question **${step + 1}/${total}**\n\n${question.text}\n\n*Reply in this channel. Type \`cancel\` to abort.*`
    )
    .setFooter({ text: 'Member Farm · Apply' })
    .setTimestamp();
}

function buildReviewEmbed(app, user) {
  const answers = typeof app.answers === 'string' ? JSON.parse(app.answers) : app.answers;
  const fields = QUESTIONS.map((q) => ({
    name: q.text.replace(/\*\*/g, '').slice(0, 100),
    value: String(answers[q.id] || '—').slice(0, 1020),
  }));
  return new EmbedBuilder()
    .setTitle(`Restocker Application #${app.id}`)
    .setColor(0xfaa61a)
    .addFields(
      { name: 'Applicant', value: `<@${app.user_id}>\n\`${app.user_id}\``, inline: true },
      { name: 'Tag', value: app.user_tag || user?.tag || '—', inline: true },
      { name: 'Status', value: `\`${app.status}\``, inline: true },
      ...fields
    )
    .setFooter({ text: 'Member Farm · Staff Review' })
    .setTimestamp();
}

function reviewButtons(appId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`apply_accept_${appId}`)
      .setLabel('Accept')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`apply_deny_${appId}`)
      .setLabel('Deny')
      .setStyle(ButtonStyle.Danger)
  );
}

async function startApply(message, client) {
  await ensureTable();

  const open = await one(
    `SELECT id FROM applications WHERE user_id = $1 AND status = 'pending'`,
    [message.author.id]
  );
  if (open) {
    await message.reply(`You already have a pending application (**#${open.id}**). Wait for staff review.`);
    return;
  }

  if (sessions.has(message.author.id)) {
    await message.reply('You already have an application in progress. Finish it or type `cancel`.');
    return;
  }

  // Prefer DM
  let channel = null;
  try {
    const dm = await message.author.createDM();
    await dm.send({ embeds: [buildQuestionEmbed(0, QUESTIONS.length, QUESTIONS[0])] });
    channel = dm;
    await message.reply('Check your **DMs** — the application questions were sent there.');
  } catch {
    channel = message.channel;
    await message.reply({
      embeds: [buildQuestionEmbed(0, QUESTIONS.length, QUESTIONS[0])],
    });
  }

  sessions.set(message.author.id, {
    step: 0,
    answers: {},
    channelId: channel.id,
    startedAt: Date.now(),
  });
}

async function handleApplyMessage(message, client) {
  const session = sessions.get(message.author.id);
  if (!session) return false;
  if (message.channel.id !== session.channelId) return false;
  if (message.author.bot) return false;

  const text = message.content.trim();
  if (!text) return true;

  if (text.toLowerCase() === 'cancel') {
    sessions.delete(message.author.id);
    await message.reply('Application **cancelled**.');
    return true;
  }

  const q = QUESTIONS[session.step];
  let answer = text;
  if (q.id === 'extra' && text.toLowerCase() === 'skip') answer = '—';

  session.answers[q.id] = answer.slice(0, 1500);
  session.step += 1;

  if (session.step >= QUESTIONS.length) {
    sessions.delete(message.author.id);
    await ensureTable();

    const row = await one(
      `INSERT INTO applications (user_id, user_tag, type, answers, status)
       VALUES ($1, $2, 'restocker', $3::jsonb, 'pending')
       RETURNING *`,
      [message.author.id, message.author.tag, JSON.stringify(session.answers)]
    );

    const reviewChId = await getSetting('apply_channel');
    const reviewEmbed = buildReviewEmbed(row, message.author);

    if (reviewChId) {
      try {
        const ch = await client.channels.fetch(reviewChId).catch(() => null);
        if (ch) {
          await ch.send({
            content: 'New restocker application',
            embeds: [reviewEmbed],
            components: [reviewButtons(row.id)],
          });
        }
      } catch (e) {
        console.error('apply review post', e.message);
      }
    }

    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('Application Submitted')
          .setColor(0x57f287)
          .setDescription(
            `Your restocker application **#${row.id}** was submitted.\nStaff will review it shortly.`
          )
          .setFooter({ text: 'Member Farm' })
          .setTimestamp(),
      ],
    });

    logs.adminLog(
      client,
      'New application',
      `<@${message.author.id}> submitted restocker application **#${row.id}**`
    );
    return true;
  }

  await message.reply({
    embeds: [buildQuestionEmbed(session.step, QUESTIONS.length, QUESTIONS[session.step])],
  });
  return true;
}

async function acceptApp(appId, reviewer, client) {
  await ensureTable();
  const app = await one(`SELECT * FROM applications WHERE id = $1`, [appId]);
  if (!app) return { ok: false, reason: 'not_found' };
  if (app.status !== 'pending') return { ok: false, reason: 'not_pending', status: app.status };

  await query(
    `UPDATE applications SET status = 'accepted', reviewer_id = $1, reviewed_at = EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id = $2`,
    [reviewer.id, appId]
  );

  await perms.grant(app.user_id, 'restock');

  const roleId = await getSetting('restocker_role');
  if (roleId && config.MAIN_GUILD_ID) {
    try {
      const guild = await client.guilds.fetch(config.MAIN_GUILD_ID).catch(() => null);
      const member = await guild?.members.fetch(app.user_id).catch(() => null);
      if (member) await member.roles.add(roleId).catch(() => {});
    } catch {}
  }

  try {
    const user = await client.users.fetch(app.user_id);
    await user.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('Application Accepted')
          .setColor(0x57f287)
          .setDescription(
            `Your restocker application **#${appId}** was **accepted**.\nYou can now use restock commands.`
          )
          .setFooter({ text: 'Member Farm' })
          .setTimestamp(),
      ],
    });
  } catch {}

  logs.adminLog(
    client,
    'Application accepted',
    `**#${appId}** <@${app.user_id}> by <@${reviewer.id}>`
  );
  return { ok: true, app };
}

async function denyApp(appId, reviewer, client, note) {
  await ensureTable();
  const app = await one(`SELECT * FROM applications WHERE id = $1`, [appId]);
  if (!app) return { ok: false, reason: 'not_found' };
  if (app.status !== 'pending') return { ok: false, reason: 'not_pending', status: app.status };

  await query(
    `UPDATE applications SET status = 'denied', reviewer_id = $1, review_note = $2, reviewed_at = EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id = $3`,
    [reviewer.id, note || null, appId]
  );

  try {
    const user = await client.users.fetch(app.user_id);
    await user.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('Application Denied')
          .setColor(0xed4245)
          .setDescription(
            `Your restocker application **#${appId}** was **denied**.` +
              (note ? `\n\nReason: ${note}` : '')
          )
          .setFooter({ text: 'Member Farm' })
          .setTimestamp(),
      ],
    });
  } catch {}

  logs.adminLog(
    client,
    'Application denied',
    `**#${appId}** <@${app.user_id}> by <@${reviewer.id}>` + (note ? ` — ${note}` : '')
  );
  return { ok: true, app };
}

async function handleApplyCommand(message, args, client, permsMod) {
  await ensureTable();
  const sub = (args[0] || '').toLowerCase();

  // User start: ?apply  or  ?apply restocker
  if (!sub || sub === 'restocker' || sub === 'start') {
    await startApply(message, client);
    return true;
  }

  if (sub === 'channel') {
    if (!(await permsMod.canUse(message.author.id, 'apply')) && !permsMod.isOwner(message.author.id))
      return true;
    if (args[1] === 'set') {
      const ch = message.mentions.channels.first();
      if (!ch) {
        await message.reply('Usage: apply channel set #channel');
        return true;
      }
      await setSetting('apply_channel', ch.id);
      await message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('Apply Channel Set')
            .setColor(0x57f287)
            .addFields({ name: 'Channel', value: `${ch}` })
            .setFooter({ text: 'Member Farm' })
            .setTimestamp(),
        ],
      });
      return true;
    }
    const id = await getSetting('apply_channel', 'not set');
    await message.reply(id === 'not set' ? 'No apply channel set.' : `Apply channel: <#${id}>`);
    return true;
  }

  if (sub === 'role') {
    if (!(await permsMod.canUse(message.author.id, 'apply')) && !permsMod.isOwner(message.author.id))
      return true;
    if (args[1] === 'set') {
      const role = message.mentions.roles.first();
      if (!role) {
        await message.reply('Usage: apply role set @role');
        return true;
      }
      await setSetting('restocker_role', role.id);
      await message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('Restocker Role Set')
            .setColor(0x57f287)
            .addFields({ name: 'Role', value: `${role}` })
            .setFooter({ text: 'Member Farm' })
            .setTimestamp(),
        ],
      });
      return true;
    }
    const id = await getSetting('restocker_role', 'not set');
    await message.reply(id === 'not set' ? 'No restocker role set.' : `Restocker role: <@&${id}>`);
    return true;
  }

  if (sub === 'list') {
    if (!(await permsMod.canUse(message.author.id, 'apply')) && !permsMod.isOwner(message.author.id))
      return true;
    const rows = await many(
      `SELECT id, user_id, user_tag, status, created_at FROM applications ORDER BY id DESC LIMIT 15`
    );
    if (!rows.length) {
      await message.reply('No applications yet.');
      return true;
    }
    const lines = rows.map(
      (r) =>
        `**#${r.id}** <@${r.user_id}> · \`${r.status}\` · <t:${r.created_at}:R>`
    );
    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('Applications')
          .setColor(0x5865f2)
          .setDescription(lines.join('\n'))
          .setFooter({ text: 'Member Farm' })
          .setTimestamp(),
      ],
    });
    return true;
  }

  if (sub === 'view') {
    if (!(await permsMod.canUse(message.author.id, 'apply')) && !permsMod.isOwner(message.author.id))
      return true;
    const id = parseInt(args[1], 10);
    if (!id) {
      await message.reply('Usage: apply view <id>');
      return true;
    }
    const app = await one(`SELECT * FROM applications WHERE id = $1`, [id]);
    if (!app) {
      await message.reply('Application not found.');
      return true;
    }
    await message.reply({
      embeds: [buildReviewEmbed(app)],
      components: app.status === 'pending' ? [reviewButtons(app.id)] : [],
    });
    return true;
  }

  if (sub === 'accept') {
    if (!(await permsMod.canUse(message.author.id, 'apply')) && !permsMod.isOwner(message.author.id))
      return true;
    const id = parseInt(args[1], 10);
    if (!id) {
      await message.reply('Usage: apply accept <id>');
      return true;
    }
    const res = await acceptApp(id, message.author, client);
    if (!res.ok) {
      await message.reply(`Cannot accept: \`${res.reason}\``);
      return true;
    }
    await message.reply(`Application **#${id}** accepted. Restock grant given.`);
    return true;
  }

  if (sub === 'deny') {
    if (!(await permsMod.canUse(message.author.id, 'apply')) && !permsMod.isOwner(message.author.id))
      return true;
    const id = parseInt(args[1], 10);
    if (!id) {
      await message.reply('Usage: apply deny <id> [reason]');
      return true;
    }
    const note = args.slice(2).join(' ') || null;
    const res = await denyApp(id, message.author, client, note);
    if (!res.ok) {
      await message.reply(`Cannot deny: \`${res.reason}\``);
      return true;
    }
    await message.reply(`Application **#${id}** denied.`);
    return true;
  }

  await message.reply(
    'Usage: `apply` · `apply channel set #ch` · `apply role set @role` · `apply list` · `apply view <id>` · `apply accept <id>` · `apply deny <id> [reason]`'
  );
  return true;
}

async function handleApplyButton(interaction, client) {
  const id = interaction.customId;
  if (!id.startsWith('apply_accept_') && !id.startsWith('apply_deny_')) return false;

  const isOwner = String(interaction.user.id) === String(config.OWNER_ID);
  const can = isOwner || (await perms.canUse(interaction.user.id, 'apply'));
  if (!can) {
    await interaction.reply({ content: 'No permission.', ephemeral: true });
    return true;
  }

  const appId = parseInt(id.split('_').pop(), 10);
  if (id.startsWith('apply_accept_')) {
    const res = await acceptApp(appId, interaction.user, client);
    if (!res.ok) {
      await interaction.reply({ content: `Cannot accept: \`${res.reason}\``, ephemeral: true });
      return true;
    }
    await interaction.update({
      content: `Accepted by <@${interaction.user.id}>`,
      components: [],
    });
    return true;
  }

  // deny via button — ask reason optionally via modal would be ideal; quick deny
  const res = await denyApp(appId, interaction.user, client, 'Denied via button');
  if (!res.ok) {
    await interaction.reply({ content: `Cannot deny: \`${res.reason}\``, ephemeral: true });
    return true;
  }
  await interaction.update({
    content: `Denied by <@${interaction.user.id}>`,
    components: [],
  });
  return true;
}

module.exports = {
  handleApplyCommand,
  handleApplyMessage,
  handleApplyButton,
  startApply,
  ensureTable,
};
