// @vitest-environment jsdom
import type { ContentTypeGrant } from '@commerceworker/domain';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoleAccessSheet } from '~/cms/components/RoleAccessSheet';
import type { RoleSummary } from '~/cms/lib/management';

afterEach(cleanup);

const role: RoleSummary = {
  id: 'r1',
  name: 'Editor',
  scopes: ['content:write', 'content:publish'],
  contentGrants: [{ contentTypeApiId: 'post', actions: ['read', 'write', 'publish'] }],
};

function open(onSave: (grants: readonly ContentTypeGrant[]) => Promise<void>) {
  render(
    <RoleAccessSheet
      role={role}
      contentTypes={[
        { apiId: 'post', name: 'Post' },
        { apiId: 'page', name: 'Page' },
      ]}
      open
      onOpenChange={() => {}}
      onSave={onSave}
    />,
  );
}

describe('a role’s content access', () => {
  it('saves write without delete and publish without unpublish as withheld actions', async () => {
    const onSave = vi.fn(async () => {});
    open(onSave);
    const del = screen.getByRole('checkbox', { name: 'Delete Post' });
    const unpublish = screen.getByRole('checkbox', { name: 'Unpublish Post' });
    expect(del.getAttribute('aria-checked')).toBe('true');
    expect(unpublish.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(del);
    fireEvent.click(unpublish);
    fireEvent.click(screen.getByRole('button', { name: 'Save access' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith([
      {
        contentTypeApiId: 'post',
        actions: ['read', 'write', 'publish'],
        deniedActions: ['delete', 'unpublish'],
      },
    ]);
  });

  it('offers delete only with write or publish, and unpublish only with publish', () => {
    open(async () => {});
    fireEvent.change(screen.getByRole('combobox', { name: 'Content type to add' }), {
      target: { value: 'page' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('checkbox', { name: 'Read Page' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(
      (screen.getByRole('checkbox', { name: 'Delete Page' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('checkbox', { name: 'Unpublish Page' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Write Page' }));
    expect(
      (screen.getByRole('checkbox', { name: 'Delete Page' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (screen.getByRole('checkbox', { name: 'Unpublish Page' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('keeps the sheet open with the server’s reason when saving is refused', async () => {
    open(async () => {
      throw new Error('Unknown action "destroy"');
    });
    const save = screen.getByRole('button', { name: 'Save access' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Delete Post' }));
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect((await screen.findByText('Unknown action "destroy"')).textContent).toBe(
      'Unknown action "destroy"',
    );
  });

  it('says why a box is disabled, and describes each box by its hint', () => {
    open(async () => {});
    fireEvent.change(screen.getByRole('combobox', { name: 'Content type to add' }), {
      target: { value: 'page' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    const describedBy = (name: string) =>
      document.getElementById(
        screen.getByRole('checkbox', { name }).getAttribute('aria-describedby') ?? '',
      )?.textContent;
    expect(describedBy('Delete Page')).toBe('Needs Write or Publish');
    expect(describedBy('Unpublish Page')).toBe('Needs Publish');
    expect(describedBy('Write Page')).toBe('Create and edit drafts');
  });

  it('asks before discarding unsaved changes, and closes at once when there are none', () => {
    const onOpenChange = vi.fn();
    render(
      <RoleAccessSheet
        role={role}
        contentTypes={[{ apiId: 'post', name: 'Post' }]}
        open
        onOpenChange={onOpenChange}
        onSave={async () => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    onOpenChange.mockClear();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Unpublish Post' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).not.toHaveBeenCalled();
    const ask = screen.getByRole('alertdialog');
    expect(ask.textContent).toContain('Discard your changes to Editor’s access?');
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
