import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import {
  type CartIndexRow,
  type CartView,
  type cancelResultSchema,
  type cartRowSchema,
  decisionResultSchema,
  type EngineRpc,
  type ErasureResult,
  erasureResultSchema,
  type FlowVersion,
  type flowVersionSchema,
  type InboundOrder,
  type inboundOrderResultSchema,
  type NodeRun,
  type Order,
  type OrderState,
  type orderSchema,
  type orderStateSchema,
  type PaymentEventResult,
  type PendingWait,
  type PluginInstallView,
  type PluginUsage,
  type paymentEventResultSchema,
  type pluginInstallViewSchema,
  type pluginUsageSchema,
  type StartOrderResult,
  type SubjectExport,
  type sendEventResultSchema,
  type startOrderResultSchema,
  type subjectExportSchema,
  type TimelineEntry,
  type UcpSettings,
  type ucpAdminSchema,
} from '../src';
import {
  type BoardCard,
  type BoardSummary,
  type boardCardSchema,
  type boardSummarySchema,
  type Draft,
  type draftSchema,
  type EditResult,
  editResultSchema,
  type FeedStatus,
  type FieldOverride,
  type feedStatusSchema,
  type fieldOverrideSchema,
  type Gap,
  type gapSchema,
  type Product,
  type ProductData,
  type ProductDraftResult,
  type ProductSheet,
  type PublishResult,
  type productDataSchema,
  type productDraftResultSchema,
  type productSchema,
  type productSheetSchema,
  type publishResultSchema,
  type Rejection,
  type Revision,
  type rejectionSchema,
  type revisionSchema,
  type StagedEdit,
  type stagedEditSchema,
  type WriteResult,
  type writeResultSchema,
} from '../src/product';

/**
 * The REST API documents its responses from these schemas, so each must say what the type it
 * describes says: the same fields, optional where that type's are. `branded.toEqualTypeOf` fails
 * on a field added to one side only, optional or not, and sees through intersections.
 */
type Out<S extends z.ZodType> = z.output<S>;
type Rpc<K extends keyof EngineRpc> = Awaited<
  EngineRpc[K] extends (...args: never[]) => infer R ? R : never
>;

describe('the engine’s response schemas say what its types say', () => {
  it('an order, its flow and its state', () => {
    expectTypeOf<Order>().branded.toEqualTypeOf<Out<typeof orderSchema>>();
    expectTypeOf<FlowVersion>().branded.toEqualTypeOf<Out<typeof flowVersionSchema>>();
    expectTypeOf<OrderState>().branded.toEqualTypeOf<Out<typeof orderStateSchema>>();
    expectTypeOf<NodeRun>().branded.toEqualTypeOf<Out<typeof orderStateSchema>['nodes'][string]>();
    expectTypeOf<PendingWait>().branded.toEqualTypeOf<
      Out<typeof orderStateSchema>['waits'][number]
    >();
    expectTypeOf<TimelineEntry>().branded.toEqualTypeOf<
      Out<typeof orderStateSchema>['timeline'][number]
    >();
    expectTypeOf<OrderState['edges']>().branded.toEqualTypeOf<
      Out<typeof orderStateSchema>['edges']
    >();
  });

  it('starting an order, delivering an event, deciding and cancelling', () => {
    expectTypeOf<StartOrderResult>().branded.toEqualTypeOf<Out<typeof startOrderResultSchema>>();
    expectTypeOf<Omit<Rpc<'sendEvent'>, 'notFound'>>().branded.toEqualTypeOf<
      Out<typeof sendEventResultSchema>
    >();
    expectTypeOf<Extract<Rpc<'decide'>, { ok: true }>>().branded.toEqualTypeOf<
      Out<typeof decisionResultSchema>
    >();
    expectTypeOf<Extract<Rpc<'cancel'>, { ok: true }>>().branded.toEqualTypeOf<
      Out<typeof cancelResultSchema>
    >();
    expectTypeOf<PaymentEventResult>().branded.toEqualTypeOf<
      Out<typeof paymentEventResultSchema>
    >();
  });

  it('what a data subject request answers', () => {
    expectTypeOf<SubjectExport>().branded.toEqualTypeOf<Out<typeof subjectExportSchema>>();
    expectTypeOf<ErasureResult>().branded.toEqualTypeOf<Out<typeof erasureResultSchema>>();
  });

  it('a plugin install and what uses a plugin', () => {
    expectTypeOf<PluginInstallView>().branded.toEqualTypeOf<Out<typeof pluginInstallViewSchema>>();
    expectTypeOf<PluginUsage>().branded.toEqualTypeOf<Out<typeof pluginUsageSchema>>();
  });

  it('a staff cart row, an inbound order’s result and agentic checkout’s settings', () => {
    expectTypeOf<
      Pick<CartIndexRow, 'id' | 'title' | 'customerId' | 'orderId' | 'createdBy'>
    >().branded.toEqualTypeOf<
      Pick<Out<typeof cartRowSchema>, 'id' | 'title' | 'customerId' | 'orderId' | 'createdBy'>
    >();
    // The row's status is a string in the index; the schema names the ones a cart has.
    expectTypeOf<Out<typeof cartRowSchema>['status']>().toExtend<CartIndexRow['status']>();
    expectTypeOf<StartOrderResult & { flowId?: string }>().branded.toEqualTypeOf<
      Out<typeof inboundOrderResultSchema>
    >();
    expectTypeOf<UcpSettings>().branded.toEqualTypeOf<Out<typeof ucpAdminSchema>['settings']>();
    // A cart view is described by the hand-written Cart component.
    expectTypeOf<CartView>().not.toBeAny();
    expectTypeOf<InboundOrder>().not.toBeAny();
  });
});

describe('the catalog’s response schemas say what its types say', () => {
  it('a product', () => {
    expectTypeOf<ProductData>().branded.toEqualTypeOf<Out<typeof productDataSchema>>();
    expectTypeOf<Product>().branded.toEqualTypeOf<Out<typeof productSchema>>();
  });

  it('writes, feeds and the board', () => {
    expectTypeOf<WriteResult>().branded.toEqualTypeOf<Out<typeof writeResultSchema>>();
    expectTypeOf<FeedStatus>().branded.toEqualTypeOf<Out<typeof feedStatusSchema>>();
    expectTypeOf<Rejection>().branded.toEqualTypeOf<Out<typeof rejectionSchema>>();
    expectTypeOf<BoardCard>().branded.toEqualTypeOf<Out<typeof boardCardSchema>>();
    expectTypeOf<BoardSummary>().branded.toEqualTypeOf<Out<typeof boardSummarySchema>>();
    expectTypeOf<Gap>().branded.toEqualTypeOf<Out<typeof gapSchema>>();
  });

  it('the editor’s sheet, edits, drafts and publishing', () => {
    expectTypeOf<ProductSheet>().branded.toEqualTypeOf<Out<typeof productSheetSchema>>();
    expectTypeOf<StagedEdit>().branded.toEqualTypeOf<Out<typeof stagedEditSchema>>();
    expectTypeOf<Draft>().branded.toEqualTypeOf<Out<typeof draftSchema>>();
    expectTypeOf<FieldOverride>().branded.toEqualTypeOf<Out<typeof fieldOverrideSchema>>();
    expectTypeOf<Revision>().branded.toEqualTypeOf<Out<typeof revisionSchema>>();
    expectTypeOf<EditResult>().branded.toEqualTypeOf<Out<typeof editResultSchema>>();
    expectTypeOf<PublishResult>().branded.toEqualTypeOf<Out<typeof publishResultSchema>>();
    expectTypeOf<ProductDraftResult>().branded.toEqualTypeOf<
      Out<typeof productDraftResultSchema>
    >();
  });
});

describe('a schema refuses what its type would', () => {
  it('a vote that did not count is not a decision', () => {
    expect(decisionResultSchema.safeParse({ ok: false, reason: 'refused' }).success).toBe(false);
    expect(
      decisionResultSchema.safeParse({ ok: true, outcome: 'recorded', tally: '1 of 2' }).success,
    ).toBe(true);
  });

  it('an erasure is done or refused for active orders, nothing else', () => {
    expect(
      erasureResultSchema.safeParse({ ok: false, reason: 'active_orders', orders: ['ord_1'] })
        .success,
    ).toBe(true);
    expect(erasureResultSchema.safeParse({ ok: false, reason: 'busy', orders: [] }).success).toBe(
      false,
    );
  });

  it('an edit that failed says why', () => {
    const ref = { field: 'title', locale: 'en' };
    expect(editResultSchema.safeParse({ key: 'k', ref, ok: false }).success).toBe(false);
    expect(editResultSchema.safeParse({ key: 'k', ref, ok: false, issues: ['x'] }).success).toBe(
      true,
    );
    expect(editResultSchema.safeParse({ key: 'k', ref, ok: true }).success).toBe(true);
  });
});
