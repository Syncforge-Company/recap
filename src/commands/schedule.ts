import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  PermissionFlagsBits,
  ChannelType,
} from 'discord.js';
import {
  Schedule,
  getSchedule,
  getSchedulesForGuild,
} from '../services/schedule-store';
import {
  createSchedule,
  editSchedule,
  deleteSchedule,
  pauseSchedule,
  resumeSchedule,
} from '../services/scheduler';
import { buildCron, describeCron, parseSimpleCron, dayLabel } from '../services/cron-format';

const DEFAULT_TIMEZONE = process.env.SCHEDULED_TIMEZONE || 'America/New_York';

/** Validate an IANA timezone string via the Intl API. */
function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** One-line description of a schedule for `/schedule list`. */
function describeSchedule(s: Schedule): string {
  const when = describeCron(s.cron, s.timezone);
  const status = s.paused ? ' ⏸ **paused**' : '';
  const text = s.textChannelId ? `<#${s.textChannelId}>` : '⚠️ missing — edit text_channel before it can fire';
  return (
    `**${s.name}** \`${s.id}\` — ${when}${status}\n` +
    `   • voice <#${s.voiceChannelId}> → text ${text}`
  );
}

/** Short choice label for autocomplete (Discord caps option name at 100 chars). */
function autocompleteLabel(s: Schedule): string {
  const label = `${s.name} — ${describeCron(s.cron, s.timezone)}${s.paused ? ' (paused)' : ''} [${s.id}]`;
  return label.length > 100 ? label.slice(0, 99) + '…' : label;
}

/**
 * Shared autocomplete responder for the `schedule:` option (id-valued).
 * Lists this guild's schedules, filtered by the typed substring.
 */
export async function respondScheduleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.respond([]);
    return;
  }
  const focused = (interaction.options.getFocused() || '').toString().toLowerCase();
  const matches = getSchedulesForGuild(interaction.guildId).filter((s) => {
    if (!focused) return true;
    const hay = `${s.name} ${s.id} ${describeCron(s.cron, s.timezone)}`.toLowerCase();
    return hay.includes(focused);
  });
  await interaction.respond(
    matches.slice(0, 25).map((s) => ({ name: autocompleteLabel(s), value: s.id })),
  );
}

/** Resolve the `schedule:` option to a schedule owned by this guild, or null. */
function resolveGuildSchedule(interaction: ChatInputCommandInteraction): Schedule | null {
  const id = interaction.options.getString('schedule', true);
  const schedule = getSchedule(id);
  if (!schedule || schedule.guildId !== interaction.guildId) return null;
  return schedule;
}

export const scheduleCommand = {
  data: new SlashCommandBuilder()
    .setName('schedule')
    .setDescription('Manage standing-call auto-record schedules')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sc) => sc.setName('list').setDescription('List this server\'s schedules'))
    .addSubcommand((sc) =>
      sc
        .setName('add')
        .setDescription('Add a new standing-call schedule')
        .addChannelOption((o) =>
          o
            .setName('voice_channel')
            .setDescription('Voice channel to auto-join and record')
            .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
            .setRequired(true),
        )
        .addStringOption((o) =>
          o
            .setName('days')
            .setDescription('Comma list of weekdays, e.g. mon,fri (also: weekdays, daily, weekends)')
            .setRequired(true),
        )
        .addStringOption((o) =>
          o.setName('time').setDescription('24-hour time HH:MM, e.g. 11:15').setRequired(true),
        )
        .addStringOption((o) =>
          o
            .setName('timezone')
            .setDescription(`IANA timezone (default ${DEFAULT_TIMEZONE})`)
            .setRequired(false),
        )
        .addChannelOption((o) =>
          o
            .setName('text_channel')
            .setDescription('Where to post live transcript and results (default: this channel)')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false),
        )
        .addStringOption((o) =>
          o
            .setName('name')
            .setDescription('Schedule name; also the call-name prefix (e.g. CADS, GS)')
            .setRequired(false),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName('edit')
        .setDescription('Edit an existing schedule (only the fields you provide change)')
        .addStringOption((o) =>
          o.setName('schedule').setDescription('Schedule to edit').setRequired(true).setAutocomplete(true),
        )
        .addChannelOption((o) =>
          o
            .setName('voice_channel')
            .setDescription('New voice channel')
            .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
            .setRequired(false),
        )
        .addStringOption((o) => o.setName('days').setDescription('New days, e.g. mon,fri').setRequired(false))
        .addStringOption((o) => o.setName('time').setDescription('New time HH:MM').setRequired(false))
        .addStringOption((o) => o.setName('timezone').setDescription('New IANA timezone').setRequired(false))
        .addChannelOption((o) =>
          o
            .setName('text_channel')
            .setDescription('New results channel')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false),
        )
        .addStringOption((o) => o.setName('name').setDescription('New name').setRequired(false)),
    )
    .addSubcommand((sc) =>
      sc
        .setName('remove')
        .setDescription('Delete a schedule')
        .addStringOption((o) =>
          o.setName('schedule').setDescription('Schedule to remove').setRequired(true).setAutocomplete(true),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName('pause')
        .setDescription('Pause a schedule (kept but inactive)')
        .addStringOption((o) =>
          o.setName('schedule').setDescription('Schedule to pause').setRequired(true).setAutocomplete(true),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName('resume')
        .setDescription('Resume a paused schedule')
        .addStringOption((o) =>
          o.setName('schedule').setDescription('Schedule to resume').setRequired(true).setAutocomplete(true),
        ),
    ),

  async autocomplete(interaction: AutocompleteInteraction) {
    await respondScheduleAutocomplete(interaction);
  },

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: '❌ This command only works in servers.', ephemeral: true });
      return;
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'list') {
      const list = getSchedulesForGuild(interaction.guildId);
      if (list.length === 0) {
        await interaction.reply({
          content: '🗓️ No schedules configured. Add one with `/schedule add`.',
          ephemeral: true,
        });
        return;
      }
      const body = list.map(describeSchedule).join('\n');
      await interaction.reply({
        content: `🗓️ **Schedules** (${list.length}):\n${body}`,
        ephemeral: true,
      });
      return;
    }

    if (sub === 'add') {
      const voice = interaction.options.getChannel('voice_channel', true);
      const days = interaction.options.getString('days', true);
      const time = interaction.options.getString('time', true);
      const timezone = interaction.options.getString('timezone') || DEFAULT_TIMEZONE;
      const text = interaction.options.getChannel('text_channel');
      let name = interaction.options.getString('name')?.trim() || '';

      if (!isValidTimezone(timezone)) {
        await interaction.reply({ content: `❌ Unknown timezone \`${timezone}\`.`, ephemeral: true });
        return;
      }

      let cron: string;
      try {
        cron = buildCron(days, time);
      } catch (err: any) {
        await interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
        return;
      }

      if (!name) {
        const parsed = parseSimpleCron(cron)!; // buildCron always yields the simple shape
        name = `${parsed.days.map(dayLabel).join('/')} call`;
      }

      const textChannelId = text?.id || interaction.channelId;
      const schedule = createSchedule({
        name,
        guildId: interaction.guildId,
        voiceChannelId: voice.id,
        textChannelId,
        cron,
        timezone,
        paused: false,
        createdBy: interaction.user.id,
      });

      await interaction.reply({
        content:
          `✅ Added schedule **${schedule.name}** \`${schedule.id}\`\n` +
          `${describeSchedule(schedule)}`,
        ephemeral: true,
      });
      return;
    }

    // edit / remove / pause / resume all target a specific schedule.
    const schedule = resolveGuildSchedule(interaction);
    if (!schedule) {
      await interaction.reply({
        content: '❌ Schedule not found in this server. Pick one from the autocomplete list.',
        ephemeral: true,
      });
      return;
    }

    if (sub === 'remove') {
      deleteSchedule(schedule.id);
      await interaction.reply({
        content: `🗑️ Removed schedule **${schedule.name}** \`${schedule.id}\`.`,
        ephemeral: true,
      });
      return;
    }

    if (sub === 'pause') {
      if (schedule.paused) {
        await interaction.reply({ content: `⏸ **${schedule.name}** is already paused.`, ephemeral: true });
        return;
      }
      const updated = pauseSchedule(schedule.id)!;
      await interaction.reply({ content: `⏸ Paused **${updated.name}** \`${updated.id}\`.`, ephemeral: true });
      return;
    }

    if (sub === 'resume') {
      if (!schedule.paused) {
        await interaction.reply({ content: `▶️ **${schedule.name}** is already active.`, ephemeral: true });
        return;
      }
      const updated = resumeSchedule(schedule.id)!;
      await interaction.reply({
        content: `▶️ Resumed **${updated.name}** \`${updated.id}\`\n${describeSchedule(updated)}`,
        ephemeral: true,
      });
      return;
    }

    if (sub === 'edit') {
      const voice = interaction.options.getChannel('voice_channel');
      const days = interaction.options.getString('days');
      const time = interaction.options.getString('time');
      const timezone = interaction.options.getString('timezone');
      const text = interaction.options.getChannel('text_channel');
      const name = interaction.options.getString('name')?.trim();

      const patch: Partial<Omit<Schedule, 'id' | 'createdAt'>> = {};

      if (name) patch.name = name;
      if (voice) patch.voiceChannelId = voice.id;
      if (text) patch.textChannelId = text.id;

      if (timezone) {
        if (!isValidTimezone(timezone)) {
          await interaction.reply({ content: `❌ Unknown timezone \`${timezone}\`.`, ephemeral: true });
          return;
        }
        patch.timezone = timezone;
      }

      if (days || time) {
        // Recompute cron. Fill the unspecified side from the existing cron when possible.
        const existing = parseSimpleCron(schedule.cron);
        const daysStr =
          days ?? (existing ? existing.days.join(',') : null);
        const timeStr =
          time ??
          (existing
            ? `${String(existing.hour).padStart(2, '0')}:${String(existing.minute).padStart(2, '0')}`
            : null);
        if (!daysStr || !timeStr) {
          await interaction.reply({
            content:
              '❌ This schedule uses a custom cron, so editing days/time needs **both** `days` and `time`.',
            ephemeral: true,
          });
          return;
        }
        try {
          patch.cron = buildCron(daysStr, timeStr);
        } catch (err: any) {
          await interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
          return;
        }
      }

      if (Object.keys(patch).length === 0) {
        await interaction.reply({
          content: 'ℹ️ Nothing to change — provide at least one field to edit.',
          ephemeral: true,
        });
        return;
      }

      const updated = editSchedule(schedule.id, patch)!;
      await interaction.reply({
        content: `✏️ Updated **${updated.name}** \`${updated.id}\`\n${describeSchedule(updated)}`,
        ephemeral: true,
      });
      return;
    }
  },
};
