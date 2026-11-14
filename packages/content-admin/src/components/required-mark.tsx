/**
 * Marks a required field's label: an asterisk in muted ink for the eye (a status colour here would
 * read as an error before anything is wrong), and the word for a screen reader, so the field's
 * name says it.
 */
export function RequiredMark() {
  return (
    <>
      <span aria-hidden="true" className="text-muted-foreground">
        *
      </span>{' '}
      <span className="sr-only">(required)</span>
    </>
  );
}
