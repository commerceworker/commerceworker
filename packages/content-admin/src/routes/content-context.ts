import { useOutletContext } from '@commerceworker/content-admin/router';
import type { ContentType } from '@commerceworker/domain';
import type { ContentTypeDeleteJob } from '../components/ContentTypeDeleteJob';
import type { TextDirection } from '../lib/management';

/** Shared data the Content layout provides to its nested entry routes. */
export interface ContentOutlet {
  readonly types: ContentType[];
  /** The types haven't arrived yet: a missing type is still loading, not missing. */
  readonly typesPending: boolean;
  readonly locales: readonly string[];
  readonly defaultLocale: string;
  readonly fallbacks?: Readonly<Record<string, string | null>>;
  /** Each locale's text direction (`dir` on its inputs); absent until the config loads. */
  readonly directions?: Readonly<Record<string, TextDirection>>;
  /** Whether Delivery serves each locale ("Not delivered" on its tab); absent until it loads. */
  readonly delivered?: Readonly<Record<string, boolean>>;
  reload(): void;
  /** A content type's delete job, followed from the layout so it outlives navigation. */
  readonly deleteJob: ContentTypeDeleteJob;
}

export function useContentOutlet(): ContentOutlet {
  return useOutletContext<ContentOutlet>();
}
