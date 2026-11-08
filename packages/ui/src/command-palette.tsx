import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './command';

export type CommandPaletteGroup = {
  heading: string;
  items: { id: string; label: string; keywords?: string }[];
};

export type CommandPaletteProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: CommandPaletteGroup[];
  onSelect: (id: string) => void;
  placeholder?: string;
  emptyText?: string;
  dialogClassName?: string;
  /** Visually hidden; improves dialog accessibility (e.g. i18n). */
  dialogTitle?: string;
  dialogDescription?: string;
  showCloseButton?: boolean;
};

/**
 * Modal command surface built on `CommandDialog`. Pair with `useCommandPaletteShortcut` for Meta/Ctrl+K.
 */
function CommandPalette({
  open,
  onOpenChange,
  groups,
  onSelect,
  placeholder = 'Search…',
  emptyText = 'No results.',
  dialogClassName,
  dialogTitle,
  dialogDescription,
  showCloseButton,
}: CommandPaletteProps) {
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      {...(dialogClassName !== undefined ? { className: dialogClassName } : {})}
      {...(dialogTitle !== undefined ? { title: dialogTitle } : {})}
      {...(dialogDescription !== undefined ? { description: dialogDescription } : {})}
      {...(showCloseButton !== undefined ? { showCloseButton } : {})}
    >
      <CommandInput placeholder={placeholder} />
      <CommandList>
        <CommandEmpty>{emptyText}</CommandEmpty>
        {groups.map((group) => (
          <CommandGroup key={group.heading} heading={group.heading}>
            {group.items.map((item) => (
              <CommandItem
                key={item.id}
                value={`${item.label} ${item.keywords ?? ''}`.trim()}
                onSelect={() => {
                  onSelect(item.id);
                  onOpenChange(false);
                }}
              >
                {item.label}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}

export { CommandPalette };
