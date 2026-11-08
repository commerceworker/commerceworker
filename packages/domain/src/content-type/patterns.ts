/**
 * Named pattern presets: the patterns content most often needs, written once here so an author
 * picks "Email address" instead of writing (and getting wrong) a regular expression.
 *
 * A preset compiles to an ordinary `validations.regexp` when the type is saved
 * (`compilePatternPresets`): the stored rule keeps the preset's name beside its `pattern` and
 * `flags`, so every reader that only knows `pattern` (an older release, an SDK) enforces the same
 * thing. Each pattern passes `unsafeRegexReason` and is linear or close to it on any input.
 */
export const PATTERN_PRESETS = {
  email: {
    name: 'Email address',
    // The domain's first label excludes the dot, so `\.` can match in one place only and no two
    // quantifiers compete for the same characters: linear on any input. (Letting the first part
    // hold dots made it quadratic; a repeated `(\.label)+` group is refused by the regex screen.)
    pattern: '^[^\\s@]+@[^\\s@.]+\\.[^\\s@]+$',
  },
  url: {
    name: 'Web address (http or https)',
    pattern: '^https?://[^\\s/?#]+(?:[/?#][^\\s]*)?$',
    flags: 'i',
  },
  slug: {
    name: 'Slug (lowercase letters, digits and single hyphens)',
    pattern: '^(?!.*--)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$',
  },
  phone: {
    name: 'Phone number in international format (+14155550123)',
    pattern: '^\\+[1-9][0-9]{6,14}$',
  },
  hexColor: {
    name: 'Hex colour (#fff or #ffffff)',
    pattern: '^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$',
  },
  usZipCode: {
    name: 'US ZIP code (12345 or 12345-6789)',
    pattern: '^[0-9]{5}(?:-[0-9]{4})?$',
  },
} as const satisfies Record<string, { name: string; pattern: string; flags?: string }>;

export type PatternPreset = keyof typeof PATTERN_PRESETS;

export const isPatternPreset = (name: unknown): name is PatternPreset =>
  typeof name === 'string' && Object.hasOwn(PATTERN_PRESETS, name);

/** A preset's rule as stored: its pattern and flags, with its name. */
export function presetRegexp(preset: PatternPreset): {
  pattern: string;
  flags?: string;
  preset: PatternPreset;
} {
  const p: { pattern: string; flags?: string } = PATTERN_PRESETS[preset];
  return { pattern: p.pattern, ...(p.flags ? { flags: p.flags } : {}), preset };
}
