import { useCallback, useEffect, useRef } from 'react';
import type { AppExtension } from '../lib/management';

/**
 * Message protocol between the admin (host) and a UI extension (guest iframe):
 *
 *  guest → host  `{ type: 'commerceworker-extension:ready' }`             — guest mounted, request context
 *  host  → guest `{ type: 'commerceworker-extension:init', context }`     — editing context (+ field value,
 *                                                                          and `readOnly` while the field's rules
 *                                                                          disable it: a setValue is then ignored)
 *  guest → host  `{ type: 'commerceworker-extension:setValue', value }`   — field-editor value update
 *  guest → host  `{ type: 'commerceworker-extension:resize', height }`    — request a new iframe height
 *
 * The iframe is sandboxed (scripts only, no same-origin) so an extension cannot
 * reach the host's cookies or DOM; all interaction flows over `postMessage`.
 */
const READY = 'commerceworker-extension:ready';
const INIT = 'commerceworker-extension:init';
const SET_VALUE = 'commerceworker-extension:setValue';
const RESIZE = 'commerceworker-extension:resize';

export interface ExtensionContext {
  readonly target: AppExtension['target'];
  readonly spaceId: string;
  readonly environmentId: string;
  readonly entryId?: string;
  readonly contentType?: string;
  /** For `field-editor`: the field being edited. */
  readonly field?: { readonly apiId: string; readonly type: string; readonly locale: string };
  /** For `field-editor`: the current field value. */
  readonly value?: unknown;
  /**
   * For `field-editor`: true while the field's rules make it read-only. The editor should show the
   * value without letting it change; the host ignores a `setValue` meanwhile.
   */
  readonly readOnly?: boolean;
}

/**
 * Hosts a UI extension in a sandboxed iframe and bridges the editing context to
 * it over `postMessage`. For `field-editor` extensions, value updates posted by
 * the guest are surfaced through `onChange`.
 */
export function ExtensionFrame(props: {
  extension: AppExtension;
  context: ExtensionContext;
  onChange?: (value: unknown) => void;
  className?: string;
}) {
  const { extension, context, onChange } = props;
  const frameRef = useRef<HTMLIFrameElement>(null);
  // Keep the latest context in a ref so the init reply always sends current data
  // without re-subscribing the message listener on every keystroke.
  const contextRef = useRef(context);
  contextRef.current = context;

  const post = useCallback((message: unknown) => {
    frameRef.current?.contentWindow?.postMessage(message, '*');
  }, []);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // Only trust messages from this extension's own frame.
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const data = e.data as { type?: string; value?: unknown; height?: number };
      if (data?.type === READY) {
        post({ type: INIT, context: contextRef.current });
      } else if (data?.type === SET_VALUE) {
        // A read-only field takes no value, whatever the guest posts.
        if (!contextRef.current.readOnly) onChange?.(data.value);
      } else if (data?.type === RESIZE && typeof data.height === 'number') {
        if (frameRef.current) frameRef.current.style.height = `${Math.max(40, data.height)}px`;
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [post, onChange]);

  // Re-send context whenever it changes (e.g. value edited elsewhere, locale switch).
  useEffect(() => {
    post({ type: INIT, context });
  }, [post, context]);

  return (
    <iframe
      ref={frameRef}
      src={extension.entryUrl}
      title={extension.name}
      // No allow-same-origin: the guest gets an opaque origin and cannot touch the host.
      sandbox="allow-scripts allow-forms"
      className={props.className ?? 'h-40 w-full rounded-md border bg-background'}
    />
  );
}
