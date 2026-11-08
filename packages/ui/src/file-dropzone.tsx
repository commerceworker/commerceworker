import { CircleAlert, Upload } from 'lucide-react';
import { type DropzoneOptions, useDropzone } from 'react-dropzone';
import { Alert, AlertDescription, AlertTitle } from './alert';
import { Button } from './button';
import { cn } from './lib/utils';

export type FileDropzoneProps = {
  onFilesAccepted: (files: File[]) => void;
  emptyLabel?: string;
  description?: string;
  className?: string;
  disabled?: boolean;
  /** Accessible name for the drop target (use when there is no adjacent `<Label>`). */
  ariaLabel?: string;
  /** For e2e / forms; forwarded to the hidden file input. */
  inputId?: string;
  /** When true, only drag-and-drop and this button open the picker (zone is not clicked). */
  showBrowseButton?: boolean;
  /** Shorter drop target (e.g. page header). */
  compact?: boolean;
} & Pick<
  Partial<DropzoneOptions>,
  'accept' | 'maxFiles' | 'maxSize' | 'minSize' | 'multiple' | 'noKeyboard'
>;

export function FileDropzone({
  onFilesAccepted,
  emptyLabel = 'Drag and drop a file here, or click to choose',
  description,
  className,
  disabled = false,
  ariaLabel,
  inputId,
  showBrowseButton = false,
  compact = false,
  accept,
  maxFiles = 1,
  maxSize,
  minSize,
  multiple,
  noKeyboard,
}: FileDropzoneProps) {
  const { getRootProps, getInputProps, isDragActive, fileRejections, open } = useDropzone({
    disabled,
    noClick: showBrowseButton,
    onDropAccepted: onFilesAccepted,
    maxFiles,
    ...(accept !== undefined ? { accept } : {}),
    ...(maxSize !== undefined ? { maxSize } : {}),
    ...(minSize !== undefined ? { minSize } : {}),
    ...(multiple !== undefined ? { multiple } : {}),
    ...(noKeyboard !== undefined ? { noKeyboard } : {}),
  });

  const rootProps = getRootProps(ariaLabel !== undefined ? { 'aria-label': ariaLabel } : {});

  return (
    <div className={cn('space-y-2', className)}>
      <div
        {...rootProps}
        className={cn(
          'flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed px-4 text-center',
          'outline-none transition-[color,background-color,border-color,box-shadow] duration-200 ease-out',
          'ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          compact ? 'min-h-[72px] py-3' : 'min-h-[120px] py-6',
          'border-border bg-muted/30 hover:bg-muted/50',
          isDragActive &&
            'border-primary bg-primary/5 shadow-sm ring-2 ring-primary/15 dark:ring-primary/25',
          !disabled && !showBrowseButton && 'cursor-pointer',
          disabled && 'pointer-events-none cursor-not-allowed opacity-50',
        )}
      >
        <input {...getInputProps(inputId !== undefined ? { id: inputId } : {})} />
        <Upload
          className={cn(
            'shrink-0 transition-colors duration-200',
            compact ? 'size-6' : 'size-8',
            isDragActive ? 'text-primary' : 'text-muted-foreground',
          )}
          aria-hidden
        />
        <p
          className={cn(
            'text-foreground',
            compact ? 'text-xs leading-snug' : 'text-sm font-medium leading-snug',
          )}
        >
          {emptyLabel}
        </p>
        {description ? (
          <p
            className={cn(
              'max-w-md text-muted-foreground',
              compact ? 'line-clamp-2 text-micro leading-tight' : 'text-xs leading-relaxed',
            )}
          >
            {description}
          </p>
        ) : null}
      </div>
      {showBrowseButton ? (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => open()}
          >
            Browse files
          </Button>
        </div>
      ) : null}
      {fileRejections.length > 0 ? (
        <Alert variant="destructive">
          <CircleAlert className="size-4" aria-hidden />
          <AlertTitle>
            {fileRejections.length === 1 ? 'File not accepted' : 'Some files were not accepted'}
          </AlertTitle>
          <AlertDescription className="text-sm">
            <ul className="mt-1.5 list-inside list-disc space-y-1.5 text-destructive/90">
              {fileRejections.map(({ file, errors }) => (
                <li key={`${file.name}-${file.size}`}>
                  <span className="font-medium text-destructive">{file.name}</span>
                  {': '}
                  {errors.map((e) => e.message).join(', ')}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
