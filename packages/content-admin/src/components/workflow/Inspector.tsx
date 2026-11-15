/**
 * Node inspector: a form generated from the node's catalog fields, plus label, retries and timeout.
 * JSON Logic and JSON fields are edited as text and only committed when they parse.
 *
 * There is no `provider` field kind (plugin providers are deferred); `contentType`, `field` and
 * `release` pickers read their options from the space (unknown values stay listed, marked as not found); a
 * duration says when it doesn't parse; the node's own validation problems (the same `validateGraph`
 * the server runs) lead the form; the "Last run" block waits for the run page (PR 8).
 */

import {
  builtinNodeRegistry,
  type ConfigField,
  DURATION_RE,
  WORKFLOW_NODE_RETRIES_MAX,
  type WorkflowNode,
} from '@commerceworker/domain';
import {
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  Field as FieldRoot,
} from '@commerceworker/ui/field';
import { Input } from '@commerceworker/ui/input';
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@commerceworker/ui/item';
import { NativeSelect, NativeSelectOption } from '@commerceworker/ui/native-select';
import { Switch } from '@commerceworker/ui/switch';
import { Textarea } from '@commerceworker/ui/textarea';
import { AlertTriangle } from 'lucide-react';
import { cloneElement, useEffect, useId, useState } from 'react';
import { stepName } from './graph';
import { CATEGORY_COLOR, NodeIcon } from './NodeIcon';

/** What the pickers offer, read from the space by the editor. */
export interface InspectorOptions {
  contentTypes: readonly { apiId: string; name: string }[];
  /** Fields of the workflow's content types (all types when it covers every type). */
  fields: readonly { apiId: string; name: string; contentType: string }[];
  releases: readonly { id: string; title: string }[];
}

const NO_OPTIONS: InspectorOptions = { contentTypes: [], fields: [], releases: [] };

/**
 * One setting: its label, the control (given the label's id, and the hint as its description) and
 * the hint beneath it. `*:w-auto` lets a control keep its own width; inputs fill by default.
 */
function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: React.ReactElement<{
    id?: string;
    'aria-describedby'?: string;
    'aria-invalid'?: boolean;
  }>;
}) {
  const id = useId();
  const hintId = useId();
  const errorId = useId();
  const controlId = children.props.id ?? id;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');
  return (
    <FieldRoot className="min-w-0 gap-1.5 *:w-auto">
      <FieldLabel htmlFor={controlId}>{label}</FieldLabel>
      {cloneElement(children, {
        id: controlId,
        'aria-describedby': describedBy || undefined,
        ...(error ? { 'aria-invalid': true } : {}),
      })}
      {hint ? (
        <FieldDescription id={hintId} className="text-xs leading-snug">
          {hint}
        </FieldDescription>
      ) : null}
      {error ? (
        <span id={errorId} className="text-bad text-xs">
          {error}
        </span>
      ) : null}
    </FieldRoot>
  );
}

export function Inspector({
  node,
  issues = [],
  options = NO_OPTIONS,
  onChange,
}: {
  node: WorkflowNode;
  /** This node's validation errors, from `validateGraph`. */
  issues?: readonly string[];
  options?: InspectorOptions;
  onChange?: (n: WorkflowNode) => void;
}) {
  const nodes = builtinNodeRegistry;
  const spec = nodes.spec(node.type);
  const config = nodes.withDefaults(node.type, node.config);
  const readOnly = !onChange;
  const set = (key: string, value: unknown) =>
    onChange?.({ ...node, config: { ...node.config, [key]: value } });

  return (
    <div className="flex flex-col gap-6">
      {/* The step's own name leads; its type and what the type does sit beneath. */}
      <Item size="xs" className="items-start p-0">
        {spec ? (
          <ItemMedia
            className="size-8 rounded-md"
            style={{
              background: `color-mix(in oklch, ${CATEGORY_COLOR[spec.category]} 16%, transparent)`,
              color: CATEGORY_COLOR[spec.category],
            }}
          >
            <NodeIcon name={spec.icon} className="size-4" />
          </ItemMedia>
        ) : null}
        <ItemContent className="min-w-0">
          <ItemTitle className="line-clamp-none font-semibold">
            <h2>{stepName(node, builtinNodeRegistry)}</h2>
          </ItemTitle>
          <ItemDescription className="line-clamp-none text-xs leading-snug">
            <span className="font-medium text-foreground/80">{spec?.label ?? node.type}</span>
            {spec?.description ? ` · ${spec.description}` : ''}
          </ItemDescription>
        </ItemContent>
      </Item>

      {issues.length ? (
        <ul aria-label="Problems with this step" className="flex flex-col gap-1 text-bad text-sm">
          {issues.map((m) => (
            <li key={m} className="flex items-start gap-1.5">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>{m}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <FieldGroup className="gap-4">
        <Field label="Label">
          <Input
            value={node.label}
            disabled={readOnly}
            onChange={(e) => onChange?.({ ...node, label: e.target.value })}
            className="h-8"
          />
        </Field>
        <Field label="Step id" hint="Used in expressions: nodes.<id>">
          <Input value={node.id} disabled className="h-8 font-mono text-xs" />
        </Field>

        {spec?.fields.map((f) => (
          <ConfigInput
            key={`${node.id}:${f.key}`}
            field={f}
            value={config[f.key]}
            readOnly={readOnly}
            options={options}
            onChange={(v) => set(f.key, v)}
          />
        ))}

        {spec?.category === 'content' || spec?.category === 'ai' ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Retries">
              <Input
                type="number"
                min={0}
                max={WORKFLOW_NODE_RETRIES_MAX}
                disabled={readOnly}
                value={node.retries ?? spec.retries ?? 3}
                onChange={(e) => onChange?.({ ...node, retries: Number(e.target.value) })}
                className="h-8"
              />
            </Field>
            <Field
              label="Timeout"
              error={
                node.timeout && !DURATION_RE.test(node.timeout) ? 'Use e.g. “5 minutes”' : null
              }
            >
              <Input
                disabled={readOnly}
                value={node.timeout ?? '5 minutes'}
                onChange={(e) => onChange?.({ ...node, timeout: e.target.value })}
                className="h-8"
              />
            </Field>
          </div>
        ) : null}
      </FieldGroup>

      <div>
        <h3 className="section-title mb-1.5">Outputs</h3>
        <div className="flex flex-wrap gap-1">
          {nodes.outputs(node.type, config).map((o) => (
            <span key={o} className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              {o}
            </span>
          ))}
          {spec?.loop ? (
            <span className="rounded border border-ink border-dashed px-1.5 py-0.5 font-mono text-xs">
              next (loop back)
            </span>
          ) : null}
          {spec?.rollback ? (
            <span className="rounded bg-undo/15 px-1.5 py-0.5 text-undo text-xs">
              compensated on failure
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

type InputProps = {
  field: ConfigField;
  value: unknown;
  readOnly: boolean;
  options: InspectorOptions;
  onChange: (v: unknown) => void;
};

/** A picker over the space's things; a value it doesn't know stays listed, marked. */
function Picker({
  field: f,
  value,
  readOnly,
  onChange,
  choices,
  none,
}: InputProps & { choices: readonly { value: string; label: string }[]; none: string }) {
  const current = typeof value === 'string' ? value : '';
  const listed = !current || choices.some((c) => c.value === current);
  return (
    <Field label={f.label} hint={f.hint}>
      <NativeSelect
        disabled={readOnly}
        value={current}
        onChange={(e) => onChange(e.target.value)}
        className="h-8"
        wrapperClassName="w-full"
      >
        <NativeSelectOption value="">{none}</NativeSelectOption>
        {choices.map((c) => (
          <NativeSelectOption key={c.value} value={c.value}>
            {c.label}
          </NativeSelectOption>
        ))}
        {listed ? null : (
          <NativeSelectOption value={current}>{current} (not found)</NativeSelectOption>
        )}
      </NativeSelect>
    </Field>
  );
}

function ConfigInput(props: InputProps) {
  const { field: f, value, readOnly, options, onChange } = props;
  switch (f.kind) {
    case 'boolean':
      return <BooleanInput {...props} />;
    case 'contentType':
      return (
        <Picker
          {...props}
          none="Choose a content type"
          choices={options.contentTypes.map((t) => ({ value: t.apiId, label: t.name }))}
        />
      );
    case 'field':
      return (
        <Picker
          {...props}
          none="Choose a field"
          choices={options.fields.map((x) => ({
            value: x.apiId,
            label: `${x.name} (${x.contentType})`,
          }))}
        />
      );
    case 'release':
      return (
        <Picker
          {...props}
          none="Choose a release"
          choices={options.releases.map((r) => ({ value: r.id, label: r.title }))}
        />
      );
    case 'number':
      return (
        <Field label={f.label} hint={f.hint}>
          <Input
            type="number"
            step="any"
            disabled={readOnly}
            value={Number(value ?? 0)}
            onChange={(e) => onChange(Number(e.target.value))}
            className="h-8"
          />
        </Field>
      );
    case 'select':
      return (
        <Field label={f.label} hint={f.hint}>
          <NativeSelect
            disabled={readOnly}
            value={String(value ?? '')}
            onChange={(e) => onChange(e.target.value)}
            className="h-8"
            wrapperClassName="w-full"
          >
            {f.required || f.default !== undefined ? null : (
              <NativeSelectOption value="">None</NativeSelectOption>
            )}
            {(f.options ?? []).map((o) => (
              <NativeSelectOption key={o} value={o}>
                {o}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      );
    case 'textarea':
      return (
        <Field label={f.label} hint={f.hint}>
          <Textarea
            disabled={readOnly}
            value={String(value ?? '')}
            onChange={(e) => onChange(e.target.value)}
            rows={4}
            className="text-xs"
          />
        </Field>
      );
    case 'list':
      return <ListInput {...props} />;
    case 'logic':
    case 'json':
      return <JsonInput {...props} />;
    case 'duration': {
      const text = String(value ?? '');
      return (
        <Field
          label={f.label}
          hint={f.hint ?? 'e.g. 2 days'}
          error={text && !DURATION_RE.test(text) ? 'Use e.g. “30 minutes” or “2 days”' : null}
        >
          <Input
            disabled={readOnly}
            value={text}
            onChange={(e) => onChange(e.target.value)}
            className="h-8"
          />
        </Field>
      );
    }
    default:
      return (
        <Field label={f.label} hint={f.hint}>
          <Input
            disabled={readOnly}
            value={String(value ?? '')}
            onChange={(e) => onChange(e.target.value)}
            className="h-8"
          />
        </Field>
      );
  }
}

/** A comma-separated list, committed on blur so a half-typed item isn't split. */
function ListInput({ field: f, value, readOnly, onChange }: InputProps) {
  const joined = Array.isArray(value) ? value.join(', ') : '';
  const [text, setText] = useState(joined);
  useEffect(() => setText(joined), [joined]);
  return (
    <Field label={f.label} hint={f.hint ?? 'Comma-separated'}>
      <Input
        disabled={readOnly}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() =>
          onChange(
            text
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          )
        }
        className="h-8 font-mono text-xs"
      />
    </Field>
  );
}

function JsonInput({ field: f, value, readOnly, onChange }: InputProps) {
  const serialized = JSON.stringify(value ?? null, null, 2);
  const [text, setText] = useState(serialized);
  const [error, setError] = useState<string | null>(null);
  // An outside change (undo, a proposal) replaces the text; the person's own edit already matches.
  useEffect(() => {
    setText((t) => {
      try {
        if (JSON.stringify(JSON.parse(t), null, 2) === serialized) return t;
      } catch {
        // Unparsable text is the person's work in progress until the value moves on.
      }
      return serialized;
    });
    setError(null);
  }, [serialized]);
  return (
    <Field
      label={f.label}
      hint={f.kind === 'logic' ? (f.hint ?? 'JSON Logic over {entry, input, nodes, vars}') : f.hint}
      error={error}
    >
      <Textarea
        disabled={readOnly}
        value={text}
        rows={Math.min(8, text.split('\n').length + 1)}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          try {
            const v = JSON.parse(e.target.value);
            setError(null);
            onChange(v);
          } catch {
            setError('Not valid JSON yet');
          }
        }}
        className="font-mono text-xs"
      />
    </Field>
  );
}

/** A switch beside its label and hint, which name and describe it. */
function BooleanInput({ field: f, value, readOnly, onChange }: InputProps) {
  const id = useId();
  const hintId = useId();
  return (
    <FieldRoot orientation="horizontal" className="min-w-0 items-start justify-between">
      <FieldContent className="min-w-0">
        <FieldLabel htmlFor={id}>{f.label}</FieldLabel>
        {f.hint ? (
          <FieldDescription id={hintId} className="text-xs leading-snug">
            {f.hint}
          </FieldDescription>
        ) : null}
      </FieldContent>
      <Switch
        id={id}
        checked={Boolean(value)}
        disabled={readOnly}
        onCheckedChange={(v) => onChange(v)}
        aria-describedby={f.hint ? hintId : undefined}
        className="mt-0.5"
      />
    </FieldRoot>
  );
}
