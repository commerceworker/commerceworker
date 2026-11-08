/** Hints up to this long sit on the label's line; longer ones wrap beneath it. */
const SHORT_HINT = 32;

/** A labelled form control: a caption above, an optional hint, and the control itself. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed as children, inside the label
    <label className="block min-w-0">
      <span className="mb-1 flex items-baseline justify-between gap-2">
        <span className="caption">{label}</span>
        {hint && hint.length <= SHORT_HINT ? (
          <span className="truncate text-muted-foreground text-xs">{hint}</span>
        ) : null}
      </span>
      {hint && hint.length > SHORT_HINT ? (
        <span className="mb-1.5 block text-muted-foreground text-xs leading-snug">{hint}</span>
      ) : null}
      {children}
    </label>
  );
}
