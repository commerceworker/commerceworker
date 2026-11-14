import { useOptionalClient } from '@commerceworker/content-admin/lib/client-context';
import { toDocument, toTiptap } from '@commerceworker/content-admin/lib/rich-text-mapper';
import type { RichTextDocument } from '@commerceworker/domain';
import { EditorContent, useEditor } from '@tiptap/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Pickers } from './EntryForm';
import { RichTextPickersContext } from './rich-text/EmbedNodeView';
import { buildExtensions } from './rich-text/extensions';
import type { EmbedResolver } from './rich-text/external-embed';
import { Toolbar } from './rich-text/Toolbar';

/**
 * Rich-text editor backed by Tiptap (MIT core). The stored document format is
 * unchanged — `@/lib/rich-text-mapper` converts to/from ProseMirror JSON, so
 * embeds keep registering `data.target` links in the reference graph.
 */
export function RichTextEditor(props: {
  id?: string;
  /** id of the field's <Label>, giving the contenteditable its accessible name
   * (label htmlFor can't reach a non-labelable element). */
  ariaLabelledBy?: string;
  /** ids of the help line and error under the field, read after its name. */
  ariaDescribedBy?: string;
  /** The locale the document is written in, and its direction: on the editable text only. */
  lang?: string;
  dir?: 'ltr' | 'rtl';
  /** Shown but not editable: a field its rules make read-only. */
  readOnly?: boolean;
  value: unknown;
  pickers: Pickers;
  onChange: (value: RichTextDocument | undefined) => void;
}) {
  // The last document we emitted (seeded with the mounted value); used to tell
  // external value changes apart from the echo of our own onChange (avoids a
  // setContent feedback loop).
  const lastEmitted = useRef(props.value as RichTextDocument | undefined);

  // Embeds resolve their metadata through the api for the current space and
  // environment; outside the CMS (no client) they go in with what the URL says.
  const client = useOptionalClient()?.client;
  const resolveEmbed = useRef<EmbedResolver | undefined>(undefined);
  resolveEmbed.current = client
    ? (url) => client.resolveEmbed(url).then((r) => r.embed)
    : undefined;

  // useEditor compares options by REFERENCE each render and calls
  // editor.setOptions() when anything differs. Fresh extensions/content/
  // editorProps objects per render would trigger that on every keystroke
  // (each edit re-renders the parent form), and the resulting view churn can
  // swallow in-flight selection keystrokes. Keep every non-handler option
  // referentially stable; `content` only matters at creation anyway.
  const extensions = useMemo(
    () => buildExtensions({ resolveEmbed: () => resolveEmbed.current }),
    [],
  );
  const [initialContent] = useState(() => toTiptap(props.value));
  const editorProps = useMemo(
    () => ({
      attributes: {
        class: 'rich-text-editor min-h-32 px-3 py-2 text-sm focus:outline-none',
        role: 'textbox',
        'aria-multiline': 'true',
        ...(props.ariaLabelledBy ? { 'aria-labelledby': props.ariaLabelledBy } : {}),
        ...(props.ariaDescribedBy ? { 'aria-describedby': props.ariaDescribedBy } : {}),
        // The words' language and direction, not the toolbar's: the admin's chrome reads its way.
        ...(props.lang ? { lang: props.lang } : {}),
        ...(props.dir ? { dir: props.dir } : {}),
      },
    }),
    // Changes only when an error comes or goes (or the space config says a direction), not per
    // keystroke.
    [props.ariaLabelledBy, props.ariaDescribedBy, props.lang, props.dir],
  );

  const editor = useEditor({
    extensions,
    content: initialContent,
    editable: !props.readOnly,
    editorProps,
    onUpdate: ({ editor: e }) => {
      const doc = toDocument(e.getJSON());
      lastEmitted.current = doc;
      props.onChange(doc);
    },
  });

  useEffect(() => {
    if (!editor || editor.isEditable === !props.readOnly) return;
    editor.setEditable(!props.readOnly, false);
  }, [editor, props.readOnly]);

  useEffect(() => {
    if (!editor) return;
    // While the user is typing, parent renders can carry a value one keystroke
    // behind lastEmitted; syncing then would setContent with the stale doc and
    // collapse the selection mid-edit. External updates (AI merge, restore)
    // always originate from a click outside the editor, so an unfocused check
    // cleanly separates the two.
    if (editor.isFocused) return;
    if (props.value === lastEmitted.current) return;
    if (JSON.stringify(props.value) === JSON.stringify(lastEmitted.current)) return;
    editor.commands.setContent(toTiptap(props.value), { emitUpdate: false });
    lastEmitted.current = props.value as RichTextDocument | undefined;
  }, [editor, props.value]);

  return (
    <RichTextPickersContext.Provider value={props.pickers}>
      <div className="rounded-lg border bg-card" id={props.id}>
        {editor && <Toolbar editor={editor} resolveEmbed={() => resolveEmbed.current} />}
        <EditorContent editor={editor} />
      </div>
    </RichTextPickersContext.Provider>
  );
}
