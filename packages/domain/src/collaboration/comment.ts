/**
 * A comment on an entry. Comments thread via `parentId` (a reply points at the
 * comment it answers). There is no user model yet, so `author` is a
 * caller-supplied label rather than a resolved identity.
 */
export interface Comment {
  readonly id: string;
  readonly entryId: string;
  /** The comment this one replies to, or null for a top-level comment. */
  readonly parentId: string | null;
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
}
