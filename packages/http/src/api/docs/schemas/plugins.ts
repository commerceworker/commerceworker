import { PLUGIN_SETTING_TYPES } from '@commerceworker/domain';
import { z } from 'zod';

// --- plugin settings -----------------------------------------------------------

const settingValue = z.union([z.string(), z.number(), z.boolean()]);

export const pluginSettingField = z.object({
  key: z.string().describe('The name the plugin reads it by'),
  label: z.string(),
  type: z.enum(PLUGIN_SETTING_TYPES),
  description: z.string().optional(),
  required: z.boolean().optional(),
  secret: z
    .boolean()
    .optional()
    .describe('Sealed at rest and never returned: see `secretsSet` for whether it holds a value'),
  options: z.array(z.string()).optional().describe('The allowed values of a `select` field'),
  default: settingValue.optional(),
});

export const pluginSettingsView = z.object({
  pluginId: z.string(),
  fields: z.array(pluginSettingField).describe('What the installed manifest declares, in order'),
  values: z
    .record(z.string(), settingValue)
    .describe('Non-secret values by key, defaults applied. Never a secret'),
  secretsSet: z.array(z.string()).describe('Secret fields that hold a value'),
  version: z.int().describe('0 before the first save; send it back as `expectedVersion`'),
  updatedAt: z.iso.datetime().optional(),
  updatedBy: z.string().optional(),
});
