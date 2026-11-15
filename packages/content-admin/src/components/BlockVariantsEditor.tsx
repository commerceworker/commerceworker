import {
  type ComponentVariant,
  type FieldDefinition,
  type FieldType,
  isValidApiId,
  type LinkType,
} from '@commerceworker/domain';
import { Button } from '@commerceworker/ui/button';
import { Checkbox } from '@commerceworker/ui/checkbox';
import { Input } from '@commerceworker/ui/input';
import { Label } from '@commerceworker/ui/label';
import { NativeSelect, NativeSelectOption } from '@commerceworker/ui/native-select';
import { Plus, Trash2 } from 'lucide-react';
import { toApiId } from '../lib/api-id';

/** One field inside a variant, as the dialog edits it. */
export interface VariantFieldRow {
  name: string;
  apiId: string;
  apiIdTouched: boolean;
  type: FieldType;
  required: boolean;
  linkType?: LinkType;
  /** The definition it was loaded from: whatever this editor doesn't edit rides along. */
  source?: FieldDefinition;
}

/** One variant of a blocks field, as the dialog edits it. */
export interface VariantRow {
  name: string;
  apiId: string;
  apiIdTouched: boolean;
  fields: VariantFieldRow[];
}

/**
 * The types a block's field can be given here. A variant's fields follow the
 * component rules, so `Slug` is out; a nested component or list needs a shape
 * of its own, which this editor does not author (one made through the API still
 * loads and keeps its type).
 */
const VARIANT_FIELD_TYPES: readonly FieldType[] = [
  'Symbol',
  'Text',
  'RichText',
  'Integer',
  'Number',
  'Boolean',
  'Date',
  'Location',
  'JSON',
  'Link',
];

export const newVariantField = (): VariantFieldRow => ({
  name: '',
  apiId: '',
  apiIdTouched: false,
  type: 'Symbol',
  required: false,
});

export const newVariant = (): VariantRow => ({
  name: '',
  apiId: '',
  apiIdTouched: false,
  fields: [newVariantField()],
});

export function variantRowsFrom(variants: readonly ComponentVariant[]): VariantRow[] {
  return variants.map((v) => ({
    name: v.name,
    apiId: v.apiId,
    apiIdTouched: true,
    fields: v.fields.map((f) => ({
      name: f.name,
      apiId: f.apiId,
      apiIdTouched: true,
      type: f.type,
      required: f.required,
      linkType: f.linkType,
      source: f,
    })),
  }));
}

/**
 * The variants to save. Unnamed rows are dropped, as unnamed fields are at the
 * top level, and anything an edited field doesn't show (validations, defaults,
 * a nested shape) is carried from the definition it came from unless its type
 * changed, since that configuration described the old type.
 */
export function variantsFromRows(rows: readonly VariantRow[]): ComponentVariant[] {
  return rows
    .filter((v) => v.name.trim() && v.apiId)
    .map((v) => ({
      apiId: v.apiId,
      name: v.name.trim(),
      fields: v.fields
        .filter((f) => f.name.trim() && f.apiId)
        .map((f, position) => {
          const retyped = f.source && f.source.type !== f.type;
          const { linkType: _linkType, ...kept }: Partial<FieldDefinition> = retyped
            ? {}
            : (f.source ?? {});
          return {
            ...kept,
            apiId: f.apiId,
            name: f.name.trim(),
            type: f.type,
            // Nested fields are never localized: the blocks field decides that once.
            localized: false,
            required: f.required,
            position,
            ...(f.type === 'Link' ? { linkType: f.linkType ?? 'Entry' } : {}),
          } as FieldDefinition;
        }),
    }));
}

/**
 * What would make the domain refuse these variants, said in the dialog before a
 * save rather than as a server error after one. Null when there is nothing.
 */
export function variantRowsProblem(fieldName: string, rows: readonly VariantRow[]): string | null {
  const named = rows.filter((v) => v.name.trim() || v.apiId);
  if (named.length === 0) return `${fieldName}: add at least one block type.`;
  const ids = new Set<string>();
  for (const v of named) {
    const label = v.name.trim() || v.apiId;
    if (!v.name.trim() || !isValidApiId(v.apiId)) {
      return `${fieldName}: each block type needs a name and a valid API ID.`;
    }
    if (ids.has(v.apiId)) return `${fieldName}: block type API IDs must be unique.`;
    ids.add(v.apiId);
    const fields = v.fields.filter((f) => f.name.trim() && f.apiId);
    if (fields.length === 0) return `${fieldName} › ${label}: add at least one field.`;
    if (fields.some((f) => !isValidApiId(f.apiId))) {
      return `${fieldName} › ${label}: field API IDs must start with a letter.`;
    }
    if (new Set(fields.map((f) => f.apiId)).size !== fields.length) {
      return `${fieldName} › ${label}: field API IDs must be unique.`;
    }
  }
  return null;
}

/**
 * Authoring the block types of a blocks field: each a name, an API ID and a
 * short list of fields. Drawn as tiles under the field's row, not cards: the
 * dialog is already the container (the No Nested Cards Rule).
 *
 * Removing a block type that entries still use is refused by the server, which
 * names the entries; the dialog shows that message as it shows any save error.
 */
export function BlockVariantsEditor(props: {
  fieldLabel: string;
  value: VariantRow[];
  onChange: (rows: VariantRow[]) => void;
}) {
  const { fieldLabel, value, onChange } = props;
  const setVariant = (i: number, patch: Partial<VariantRow>) =>
    onChange(value.map((v, idx) => (idx === i ? { ...v, ...patch } : v)));
  const setField = (vi: number, fi: number, patch: Partial<VariantFieldRow>) =>
    setVariant(vi, {
      fields: (value[vi]?.fields ?? []).map((f, idx) => (idx === fi ? { ...f, ...patch } : f)),
    });

  return (
    <fieldset className="basis-full space-y-2 pt-1">
      <legend className="sr-only">Block types for {fieldLabel}</legend>
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">Block types</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onChange([...value, newVariant()])}
        >
          <Plus className="size-4" /> Add block type
        </Button>
      </div>
      {value.map((v, vi) => {
        const label = v.name || v.apiId || `block type ${vi + 1}`;
        return (
          <div key={vi} className="space-y-2 rounded-xl bg-secondary/40 p-3">
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex-1 space-y-1">
                <span className="text-xs text-muted-foreground">Block type</span>
                <Input
                  aria-label={`Name for block type ${vi + 1} of ${fieldLabel}`}
                  value={v.name}
                  placeholder="Hero"
                  onChange={(e) =>
                    setVariant(vi, {
                      name: e.target.value,
                      ...(v.apiIdTouched ? {} : { apiId: toApiId(e.target.value) }),
                    })
                  }
                />
              </div>
              <div className="w-32 space-y-1">
                <span className="text-xs text-muted-foreground">API ID</span>
                <Input
                  aria-label={`API ID for block type ${label}`}
                  value={v.apiId}
                  className="font-mono text-xs"
                  onChange={(e) => setVariant(vi, { apiId: e.target.value, apiIdTouched: true })}
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove block type ${label}`}
                onClick={() => onChange(value.filter((_, idx) => idx !== vi))}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>

            <ul className="space-y-2" aria-label={`Fields of block type ${label}`}>
              {v.fields.map((f, fi) => {
                const fieldName = f.name || f.apiId || `field ${fi + 1}`;
                // A type this editor doesn't author stays selectable on the
                // field that already has it, so loading never changes it.
                const types = VARIANT_FIELD_TYPES.includes(f.type)
                  ? VARIANT_FIELD_TYPES
                  : [...VARIANT_FIELD_TYPES, f.type];
                return (
                  <li key={fi} className="flex flex-wrap items-center gap-2">
                    <Input
                      className="min-w-32 flex-1"
                      aria-label={`Name for field ${fi + 1} of ${label}`}
                      value={f.name}
                      placeholder="Heading"
                      onChange={(e) =>
                        setField(vi, fi, {
                          name: e.target.value,
                          ...(f.apiIdTouched ? {} : { apiId: toApiId(e.target.value) }),
                        })
                      }
                    />
                    <Input
                      className="w-28 font-mono text-xs"
                      aria-label={`API ID for ${fieldName} in ${label}`}
                      value={f.apiId}
                      onChange={(e) =>
                        setField(vi, fi, { apiId: e.target.value, apiIdTouched: true })
                      }
                    />
                    <NativeSelect
                      size="sm"
                      aria-label={`Type for ${fieldName} in ${label}`}
                      value={f.type}
                      onChange={(e) => setField(vi, fi, { type: e.target.value as FieldType })}
                    >
                      {types.map((t) => (
                        <NativeSelectOption key={t} value={t}>
                          {t}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                    {f.type === 'Link' && (
                      <NativeSelect
                        size="sm"
                        aria-label={`Link target for ${fieldName} in ${label}`}
                        value={f.linkType ?? 'Entry'}
                        onChange={(e) => setField(vi, fi, { linkType: e.target.value as LinkType })}
                      >
                        <NativeSelectOption value="Entry">Entry</NativeSelectOption>
                        <NativeSelectOption value="Asset">Asset</NativeSelectOption>
                      </NativeSelect>
                    )}
                    <Label className="h-8 gap-1.5 font-normal">
                      <Checkbox
                        aria-label={`${fieldName} in ${label}: required`}
                        checked={f.required}
                        onCheckedChange={(c) => setField(vi, fi, { required: c === true })}
                      />
                      Req
                    </Label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${fieldName} from ${label}`}
                      onClick={() =>
                        setVariant(vi, { fields: v.fields.filter((_, idx) => idx !== fi) })
                      }
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </li>
                );
              })}
            </ul>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setVariant(vi, { fields: [...v.fields, newVariantField()] })}
            >
              <Plus className="size-4" /> Add field to {v.name || 'block type'}
            </Button>
          </div>
        );
      })}
    </fieldset>
  );
}
