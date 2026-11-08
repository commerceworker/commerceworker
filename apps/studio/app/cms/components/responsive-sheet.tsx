import { SheetContent } from '@commerceworker/ui/sheet';
import type { ComponentProps } from 'react';
import { PHONE, useMedia } from '~/cms/lib/device';

/**
 * A sheet from the side, and from the bottom on a phone, where a side drawer leaves its form out of
 * thumb reach. It pads for the home indicator there.
 */
export function ResponsiveSheetContent(props: Omit<ComponentProps<typeof SheetContent>, 'side'>) {
  const phone = useMedia(PHONE);
  return <SheetContent side={phone ? 'bottom' : 'right'} {...props} />;
}
