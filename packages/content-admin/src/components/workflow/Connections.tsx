/**
 * Keyboard path for wiring a workflow: each output of the selected step, what it connects to, and
 * a picker to connect it to another step. Mirrors what dragging between handles does on the
 * canvas, including the cycle check (a step that would close a cycle is never offered). Loop
 * back-edges ("next") are still drawn on the canvas.
 */

import { Section } from '@commerceworker/content-admin/components/page';
import {
  builtinNodeRegistry,
  isBackEdge,
  type WorkflowGraph,
  type WorkflowNode,
} from '@commerceworker/domain';
import { Button } from '@commerceworker/ui/button';
import { Item, ItemActions, ItemContent, ItemTitle } from '@commerceworker/ui/item';
import { NativeSelect, NativeSelectOption } from '@commerceworker/ui/native-select';
import { X } from 'lucide-react';
import { useId, useState } from 'react';
import { edgeId, stepName, wouldCycle } from './graph';

export function Connections({
  node,
  graph,
  onChange,
}: {
  node: WorkflowNode;
  graph: WorkflowGraph;
  onChange: (g: WorkflowGraph) => void;
}) {
  const nodes = builtinNodeRegistry;
  const outputs = nodes.outputs(node.type, nodes.withDefaults(node.type, node.config));
  const baseId = useId();
  const [picks, setPicks] = useState<Record<string, string>>({});
  if (!outputs.length) return null;
  const label = (id: string) => {
    const n = graph.nodes.find((x) => x.id === id);
    return n ? stepName(n, nodes) : id;
  };
  // An option is named by its step; two steps of one name tell themselves apart by id.
  const optionName = (n: WorkflowNode, among: readonly WorkflowNode[]) => {
    const name = stepName(n, nodes);
    return among.some((o) => o.id !== n.id && stepName(o, nodes) === name)
      ? `${name} (${n.id})`
      : name;
  };
  const forward = graph.edges.filter((e) => e.source === node.id && !isBackEdge(e));

  const connect = (output: string, target: string) => {
    // Checked again here: the list could be stale by a frame after another edit.
    if (wouldCycle(graph, node.id, target)) return;
    const handle = output === 'out' ? null : output;
    const edge = { source: node.id, target, sourceHandle: handle, targetHandle: null };
    const id = edgeId(edge);
    if (graph.edges.some((e) => e.id === id)) return;
    onChange({ ...graph, edges: [...graph.edges, { id, ...edge }] });
  };
  const disconnect = (id: string, output: string) => {
    onChange({ ...graph, edges: graph.edges.filter((e) => e.id !== id) });
    // Keep keyboard focus in the same output instead of dropping it to the page.
    requestAnimationFrame(() => document.getElementById(`${baseId}-${output}`)?.focus());
  };

  return (
    <Section
      title="Connections"
      description="Where each output goes next. Same as dragging between dots on the canvas."
    >
      <ul className="flex flex-col gap-4">
        {outputs.map((o) => {
          const edges = forward.filter((e) => (e.sourceHandle || 'out') === o);
          const taken = new Set(edges.map((e) => e.target));
          const options = graph.nodes.filter(
            (n) =>
              n.id !== node.id &&
              !n.type.startsWith('trigger.') &&
              !taken.has(n.id) &&
              !wouldCycle(graph, node.id, n.id),
          );
          const selectId = `${baseId}-${o}`;
          const pick = picks[o] ?? '';
          return (
            <li key={o} className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-mono text-xs">{o}</span>
                {!edges.length ? (
                  <span className="text-muted-foreground text-xs">Not connected</span>
                ) : null}
              </div>
              {edges.length ? (
                <ul className="flex flex-col gap-1">
                  {edges.map((e) => (
                    <Item
                      key={e.id}
                      asChild
                      variant="outline"
                      size="xs"
                      className="flex-nowrap py-1 pr-1"
                    >
                      <li>
                        <ItemContent className="min-w-0">
                          <ItemTitle className="block w-full truncate font-normal">
                            {label(e.target)}
                          </ItemTitle>
                        </ItemContent>
                        <ItemActions>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            onClick={() => disconnect(e.id, o)}
                            className="text-muted-foreground hover:text-foreground"
                            aria-label={`Disconnect ${o} from ${label(e.target)}`}
                          >
                            <X className="size-3.5" aria-hidden="true" />
                          </Button>
                        </ItemActions>
                      </li>
                    </Item>
                  ))}
                </ul>
              ) : null}
              {options.length ? (
                // Choosing is separate from connecting, so arrowing through the list is harmless.
                <Item size="xs" className="flex-nowrap gap-1.5 p-0">
                  <ItemContent className="min-w-0">
                    <label htmlFor={selectId} className="sr-only">
                      Connect {o} to
                    </label>
                    <NativeSelect
                      id={selectId}
                      value={pick}
                      onChange={(e) => setPicks((p) => ({ ...p, [o]: e.target.value }))}
                      className="h-8"
                      wrapperClassName="w-full"
                    >
                      <NativeSelectOption value="">Connect to…</NativeSelectOption>
                      {options.map((n) => (
                        <NativeSelectOption key={n.id} value={n.id}>
                          {optionName(n, options)}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={!pick}
                      aria-label={`Connect ${o}`}
                      onClick={() => {
                        connect(o, pick);
                        setPicks((p) => ({ ...p, [o]: '' }));
                      }}
                    >
                      Connect
                    </Button>
                  </ItemActions>
                </Item>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
