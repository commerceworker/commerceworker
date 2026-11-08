import { Check, Copy } from 'lucide-react';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { Button } from './button';
import { cn } from './lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip';

interface CopyButtonProps {
  value: string;
  className?: string;
  showLabel?: boolean;
  showToast?: boolean;
  /** Called when the Clipboard API rejects (permissions, insecure context, etc.). */
  onCopyError?: (error: unknown) => void;
}

export function CopyButton({
  value,
  className,
  showLabel,
  showToast = true,
  onCopyError,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (showToast) {
        toast.success('Copied to clipboard');
      }
      window.setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      onCopyError?.(err);
      if (showToast) {
        toast.error('Could not copy to clipboard');
      }
    }
  }, [value, showToast, onCopyError]);

  if (showLabel) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={cn('h-6 shrink-0 gap-1 px-2 text-micro', className)}
        onClick={copy}
      >
        {copied ? <Check className="h-3 w-3 text-primary" /> : <Copy className="h-3 w-3" />}
        <span>{copied ? 'Copied' : 'Copy'}</span>
      </Button>
    );
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn('size-8 text-muted-foreground hover:text-foreground', className)}
            onClick={copy}
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            <span className="sr-only">Copy</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{copied ? 'Copied' : 'Copy'}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
