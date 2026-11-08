/**
 * The pieces of turning on two-factor sign-in that more than one page shows: the QR code an
 * authenticator app scans, and the recovery codes shown once it is on. Account's Two-factor
 * section and setup's two-factor step (routes/setup-two-factor.tsx) both draw them.
 */

import { Button } from '@commerceworker/ui/button';
import { Download } from 'lucide-react';
import { encode } from 'uqr';
import { CopyButton } from '~/components/copy-button';

/** Dark modules on a white field whatever the theme, which is what scanners expect. */
export function QrCode({ value }: { value: string }) {
  const { data: rows, size } = encode(value, { ecc: 'M', border: 2 });
  let path = '';
  rows.forEach((row, y) => {
    row.forEach((on, x) => {
      if (on) path += `M${x} ${y}h1v1h-1z`;
    });
  });
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className="size-40 shrink-0 rounded-sm"
      shapeRendering="crispEdges"
      role="img"
      aria-label="QR code for your authenticator app"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

/** A setup secret as the app's manual entry wants it: groups of four. */
export const groupedKey = (secret: string) => secret.match(/.{1,4}/g)?.join(' ') ?? secret;

/** The recovery codes, with Copy and Download, and the one button that says they are kept. */
export function RecoveryCodes({
  codes,
  done,
  onDone,
}: {
  codes: readonly string[];
  /** The button that moves on once they are saved: "I’ve saved them", "Continue". */
  done: string;
  onDone: () => void;
}) {
  const text = codes.join('\n');
  return (
    <>
      <ul
        aria-label="Recovery codes"
        className="grid select-all grid-cols-2 gap-x-6 gap-y-0.5 rounded-sm border bg-card px-3 py-2 font-mono text-sm"
      >
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <CopyButton text={text} />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            const url = URL.createObjectURL(new Blob([`${text}\n`], { type: 'text/plain' }));
            const a = document.createElement('a');
            a.href = url;
            a.download = 'commerceworker-recovery-codes.txt';
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          <Download /> Download
        </Button>
        <Button type="button" size="sm" className="ml-auto" onClick={onDone}>
          {done}
        </Button>
      </div>
    </>
  );
}
