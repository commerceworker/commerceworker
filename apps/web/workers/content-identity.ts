import { WorkerEntrypoint } from 'cloudflare:workers';
import { sessionPerson } from '../app/lib/auth.server';
import { contentPerson } from '../app/lib/content.server';
import { authStore, contentAuthStore } from '../app/lib/wire.server';

/** Binding-only identity checks for content sockets; credentials and hashes are never returned. */
export class ContentIdentity extends WorkerEntrypoint<Env> {
  async anyPeople() {
    return (await authStore().userCount()) > 0;
  }

  async personNow(who: { sub: string; sid?: string }, _now: number) {
    const now = Date.now();
    if (who.sid) {
      const found = await sessionPerson(who.sid, now);
      if (!found) return null;
      const person = await contentPerson(found.caller);
      return person?.id === who.sub ? { ...person, seenAt: found.seenAt } : null;
    }
    // A session-free probe distinguishes an ended session from a disabled/deleted account.
    // Resolve only immutable subjects, including explicit legacy links.
    const subject = who.sub.startsWith('commerce:')
      ? who.sub
      : await contentAuthStore()?.commerceSubjectForUser(who.sub);
    const user = subject?.startsWith('commerce:')
      ? await authStore().user(subject.slice('commerce:'.length))
      : undefined;
    if (!user || user.disabledAt) return null;
    const person = await contentPerson({
      ...user,
      kind: 'user',
      role: user.role as import('@commerceworker/core/roles').Role,
    });
    return person?.id === who.sub ? person : null;
  }
}
