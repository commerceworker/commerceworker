/**
 * Who wrote something, as a person reads it. The api records an actor id (an entry's
 * `createdBy`/`updatedBy`, an asset version's `createdBy`): a person's id, the admin token, an API
 * key's kind, or what acted on nobody's keystroke (`agent:<name>`, `workflow:<id>`, `plugin:<id>`,
 * `system`). This turns one into words, never showing a raw id: a teammate by name when the team
 * is known (only administrators can read it), "You" for the signed-in person, else what kind of
 * writer it was.
 */

export interface ActorDirectory {
  /** The signed-in person's id (`subject`), so their own work reads "You". */
  readonly me?: string;
  readonly people?: readonly {
    readonly id: string;
    readonly email: string;
    readonly name?: string;
  }[];
}

/**
 * Where the words go: `label` stands on its own ("An API key", in a `<dd>`); `inSentence` runs on
 * from other words ("by an API key"), so a kind of writer starts lower-case. A name never changes.
 */
export type ActorForm = 'label' | 'inSentence';

const KEY_KINDS = new Set(['cma', 'cda', 'cpa', 'api_key']);

/** The kind of writer, lower-case, or `null` when the actor is a person (named as recorded). */
function kindOf(actor: string): string | null {
  if (actor === 'admin-token' || actor === 'admin') return 'the admin token';
  if (KEY_KINDS.has(actor)) return 'an API key';
  if (actor === 'system') return 'a schedule';
  if (actor.startsWith('agent:')) return `the ${actor.slice('agent:'.length)} agent`;
  if (actor.startsWith('workflow:')) return 'a workflow';
  if (actor.startsWith('plugin:')) return 'a plugin';
  return null;
}

const capitalized = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** An actor id in words; `null` (not recorded) reads "Unknown". */
export function actorLabel(
  actor: string | null | undefined,
  directory: ActorDirectory = {},
  form: ActorForm = 'label',
): string {
  const kind = (words: string) => (form === 'label' ? capitalized(words) : words);
  if (!actor) return kind('unknown');
  if (directory.me && actor === directory.me) return kind('you');
  const person = directory.people?.find((p) => p.id === actor);
  if (person) return person.name?.trim() || person.email;
  const known = kindOf(actor);
  if (known) return kind(known);
  // An email recorded as itself reads fine; any other id is a teammate the reader can't look up.
  return actor.includes('@') ? actor : kind('a teammate');
}
