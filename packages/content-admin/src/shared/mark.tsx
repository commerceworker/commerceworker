/** The CommerceWorker mark: a page of content, a filled title block over two lines of body. */
export function Mark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
      <rect x="7.5" y="7.5" width="9" height="3" rx="0.75" fill="currentColor" stroke="none" />
      <path d="M7.5 14h9" />
      <path d="M7.5 17h5" />
    </svg>
  );
}
