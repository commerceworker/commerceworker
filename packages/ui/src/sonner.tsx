import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import * as React from 'react';
import { Toaster as Sonner, type ToasterProps } from 'sonner';

/** The theme the admins put on <html> as `data-theme`, kept current as the reader switches it. */
function useDocumentTheme(): NonNullable<ToasterProps['theme']> {
  const read = (): NonNullable<ToasterProps['theme']> => {
    if (typeof document === 'undefined') return 'system';
    const t = document.documentElement.dataset.theme;
    return t === 'dark' || t === 'light' ? t : 'system';
  };
  const [theme, setTheme] = React.useState(read);
  React.useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);
  return theme;
}

const Toaster = ({ ...props }: ToasterProps) => {
  // Both admins set the chosen theme as `data-theme` on <html> (absent: follow the system).
  const theme = useDocumentTheme();

  return (
    <Sonner
      theme={theme}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--border-radius': 'var(--radius)',
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: 'cn-toast',
        },
      }}
      {...props}
    />
  );
};

export { toast } from 'sonner';
export { Toaster };
