/**
 * EDI X12 850 purchase orders as inbound orders. Pure: `parseX12` splits an interchange into its
 * transactions using the delimiters its ISA header declares, `x12850ToInbound` maps one 850 onto
 * an inbound order for the trading partner's customer, and `x12FunctionalAck` writes the 997 that
 * acknowledges what was taken. Transport (AS2, SFTP, a VAN) is out of scope; a partner's provider
 * posts the raw X12 to the API and relays the 997 from its answer.
 */

import type { ChannelResult } from './shopify';

export type X12Segment = { id: string; el: string[] };
/** One transaction set (ST to SE); `group` is its functional group's control number (GS06). */
export type X12Transaction = {
  type: string;
  control: string;
  group: string;
  segments: X12Segment[];
};
/** A functional group's GS header: GS01, GS02, GS03, GS06 and GS08. */
export type X12Group = {
  functionalId: string;
  sender: string;
  receiver: string;
  control: string;
  version: string;
};
/** What a reply needs from the ISA header: its parties, control number, version and delimiters. */
export type X12Envelope = {
  senderQualifier: string;
  receiverQualifier: string;
  control: string;
  version: string;
  usage: string;
  repetition: string;
  element: string;
  component: string;
  terminator: string;
};
export type X12Interchange = {
  sender: string;
  receiver: string;
  envelope: X12Envelope;
  groups: X12Group[];
  transactions: X12Transaction[];
};

export type X12Parse = { ok: true; interchange: X12Interchange } | { ok: false; error: string };

/**
 * The ISA segment is fixed width: the element separator is its 4th character, the component
 * separator the 105th and the segment terminator the 106th.
 */
/** A segment without the CR and LF around it, in linear time (no backtracking regex on partner input). */
function trimLineBreaks(s: string): string {
  const isBreak = (c: number) => c === 10 || c === 13;
  let start = 0;
  let end = s.length;
  while (start < end && isBreak(s.charCodeAt(start))) start += 1;
  while (end > start && isBreak(s.charCodeAt(end - 1))) end -= 1;
  return s.slice(start, end);
}

export function parseX12(text: string): X12Parse {
  const raw = text.replace(/^﻿/, '').trimStart();
  if (!raw.startsWith('ISA') || raw.length < 106)
    return {
      ok: false,
      error: 'Not an X12 interchange: it must start with a 106-character ISA segment',
    };
  const element = raw[3]!;
  const terminator = raw[105]!;
  const segments = raw
    .split(terminator)
    .map(trimLineBreaks)
    .filter(Boolean)
    .map((s) => {
      const [id, ...el] = s.split(element);
      return { id: id!.trim(), el: el.map((e) => e.trim()) };
    });
  const isa = segments[0]!;
  const transactions: X12Transaction[] = [];
  const groups: X12Group[] = [];
  let open: X12Transaction | null = null;
  for (const seg of segments) {
    if (seg.id === 'GS')
      groups.push({
        functionalId: seg.el[0] ?? '',
        sender: seg.el[1] ?? '',
        receiver: seg.el[2] ?? '',
        control: seg.el[5] ?? '',
        version: seg.el[7] ?? '',
      });
    else if (seg.id === 'ST') {
      if (open) return { ok: false, error: `ST ${open.control} has no SE before the next ST` };
      open = {
        type: seg.el[0] ?? '',
        control: seg.el[1] ?? '',
        group: groups.at(-1)?.control ?? '',
        segments: [],
      };
    } else if (seg.id === 'SE') {
      if (!open) return { ok: false, error: 'SE without an ST' };
      // SE01 counts the segments from ST to SE inclusive.
      const count = Number(seg.el[0]);
      if (count !== open.segments.length + 2)
        return {
          ok: false,
          error: `SE for ${open.control} counts ${seg.el[0]} segments; the transaction has ${open.segments.length + 2}`,
        };
      transactions.push(open);
      open = null;
    } else if (open) open.segments.push(seg);
  }
  if (open) return { ok: false, error: `ST ${open.control} has no SE` };
  if (!transactions.length) return { ok: false, error: 'The interchange has no transactions' };
  return {
    ok: true,
    interchange: {
      sender: isa.el[5] ?? '',
      receiver: isa.el[7] ?? '',
      envelope: {
        senderQualifier: isa.el[4] ?? '',
        receiverQualifier: isa.el[6] ?? '',
        control: isa.el[12] ?? '',
        version: isa.el[11] ?? '',
        usage: isa.el[14] ?? '',
        repetition: isa.el[10] ?? '',
        element,
        component: raw[104]!,
        terminator,
      },
      groups,
      transactions,
    },
  };
}

/** How one transaction set was taken: accepted (an order started, or one already started) or not. */
export type X12TransactionAck = { control: string; accepted: boolean };

/**
 * The 997 functional acknowledgement for an interchange we received, back to its sender with the
 * parties swapped and the same delimiters: one ST*997 per functional group, an AK2/AK5 per
 * transaction set (`A` accepted, `R` rejected with code 5, "one or more segments in error"), and
 * an AK9 that is `A` when all were accepted, `R` when none were and `P` otherwise. The interchange
 * and group control numbers repeat the received ones, so a resent interchange is acknowledged the
 * same way; `now` dates it.
 */
export function x12FunctionalAck(
  interchange: X12Interchange,
  acks: readonly X12TransactionAck[],
  now: Date,
): string {
  const { envelope: e } = interchange;
  const el = e.element;
  const seg = (...parts: string[]) => parts.join(el);
  const pad = (s: string, n: number) => s.slice(0, n).padEnd(n, ' ');
  const iso = now.toISOString();
  const yymmdd = iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10);
  const ccyymmdd = iso.slice(0, 4) + iso.slice(5, 7) + iso.slice(8, 10);
  const hhmm = iso.slice(11, 13) + iso.slice(14, 16);
  const accepted = new Map(acks.map((a) => [a.control, a.accepted]));
  const control = pad(e.control.replace(/\D/g, '').padStart(9, '0'), 9);

  const out: string[] = [
    seg(
      'ISA',
      '00',
      pad('', 10),
      '00',
      pad('', 10),
      pad(e.receiverQualifier, 2),
      pad(interchange.receiver, 15),
      pad(e.senderQualifier, 2),
      pad(interchange.sender, 15),
      yymmdd,
      hhmm,
      e.repetition || 'U',
      e.version || '00401',
      control,
      '0',
      e.usage || 'P',
      e.component,
    ),
  ];
  const groups = interchange.groups.length
    ? interchange.groups
    : [{ functionalId: 'PO', sender: '', receiver: '', control: '1', version: '004010' }];
  for (const [i, g] of groups.entries()) {
    const txs = interchange.transactions.filter((t) => t.group === g.control);
    const taken = txs.filter((t) => accepted.get(t.control) === true).length;
    const body = [
      seg('AK1', g.functionalId, g.control),
      ...txs.flatMap((t) => {
        const ok = accepted.get(t.control) === true;
        return [seg('AK2', t.type, t.control), ok ? seg('AK5', 'A') : seg('AK5', 'R', '5')];
      }),
      seg(
        'AK9',
        taken === txs.length ? 'A' : taken === 0 ? 'R' : 'P',
        String(txs.length),
        String(txs.length),
        String(taken),
      ),
    ];
    const st = String(i + 1).padStart(4, '0');
    out.push(
      seg('GS', 'FA', g.receiver, g.sender, ccyymmdd, hhmm, g.control, 'X', g.version || '004010'),
      seg('ST', '997', st),
      ...body,
      seg('SE', String(body.length + 2), st),
      seg('GE', '1', g.control),
    );
  }
  out.push(seg('IEA', String(groups.length), control));
  return out.join(e.terminator) + e.terminator;
}

/** Part-number qualifiers in a PO1, in the order they are trusted as CommerceWorker's SKU. */
const SKU_QUALIFIERS = ['VP', 'SK', 'BP', 'IN'];

/** One 850 as an inbound B2B order from the partner `sender`, billed to `customerId`. */
export function x12850ToInbound(
  tx: X12Transaction,
  partner: { sender: string; customerId: string },
): ChannelResult {
  if (tx.type !== '850')
    return { ok: false, error: `Transaction ${tx.control} is a ${tx.type}, not an 850` };
  const first = (id: string) => tx.segments.find((s) => s.id === id);
  const beg = first('BEG');
  const po = beg?.el[2];
  if (!po)
    return { ok: false, error: `Transaction ${tx.control} has no BEG03 purchase order number` };

  const lines = [];
  for (const [i, s] of tx.segments.entries()) {
    if (s.id !== 'PO1') continue;
    const qty = Number(s.el[1]);
    const price = s.el[3] ? Number(s.el[3]) : undefined;
    const ids = new Map<string, string>();
    for (let k = 5; k + 1 < s.el.length; k += 2)
      if (s.el[k] && s.el[k + 1]) ids.set(s.el[k]!, s.el[k + 1]!);
    const sku = SKU_QUALIFIERS.map((q) => ids.get(q)).find(Boolean);
    if (!sku)
      return {
        ok: false,
        error: `PO ${po} line ${s.el[0] || lines.length + 1} has no VP, SK, BP or IN part number`,
      };
    if (!(qty > 0))
      return { ok: false, error: `PO ${po} line ${s.el[0] || lines.length + 1} has no quantity` };
    // A PID right after the PO1 describes the item.
    const pid = tx.segments[i + 1]?.id === 'PID' ? tx.segments[i + 1]!.el[4] : undefined;
    lines.push({
      sku,
      qty,
      ...(price !== undefined && Number.isFinite(price) ? { unitPrice: price } : {}),
      ...(pid ? { name: pid } : {}),
    });
  }
  if (!lines.length) return { ok: false, error: `PO ${po} has no PO1 lines` };
  const ctt = first('CTT')?.el[0];
  if (ctt && Number(ctt) !== lines.length)
    return {
      ok: false,
      error: `PO ${po}: CTT says ${ctt} lines, the transaction has ${lines.length}`,
    };

  // Ship-to: the N1*ST loop, with its N3 street and N4 city, region, postcode and country.
  const n1 = tx.segments.findIndex((s) => s.id === 'N1' && s.el[0] === 'ST');
  const loop = n1 < 0 ? [] : tx.segments.slice(n1 + 1, n1 + 4);
  const n3 = loop.find((s) => s.id === 'N3');
  const n4 = loop.find((s) => s.id === 'N4');
  const shipTo =
    n3?.el[0] && n4?.el[0] && n4.el[2]
      ? {
          ...(tx.segments[n1]!.el[1] ? { name: tx.segments[n1]!.el[1] } : {}),
          line1: n3.el[0],
          ...(n3.el[1] ? { line2: n3.el[1] } : {}),
          city: n4.el[0],
          ...(n4.el[1] ? { region: n4.el[1] } : {}),
          postalCode: n4.el[2],
          country: n4.el[3] || 'US',
        }
      : undefined;

  return {
    ok: true,
    order: {
      model: 'b2b',
      channel: 'edi',
      externalId: `${partner.sender}:${po}`,
      source: 'x12-850',
      title: `PO ${po}`,
      customerId: partner.customerId,
      currency: first('CUR')?.el[1] || 'USD',
      lines,
      ...(shipTo ? { shipTo } : {}),
      meta: {
        edi: {
          sender: partner.sender,
          poNumber: po,
          control: tx.control,
          date: beg?.el[4] ?? null,
        },
      },
    },
  };
}

/** `EDI_PARTNERS`: JSON from an interchange sender id (ISA06) to the customer it orders for. */
export function parseEdiPartners(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v))
      return Object.fromEntries(
        Object.entries(v)
          .filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '')
          .map(([k, c]) => [k.trim(), c]),
      );
  } catch {
    // no partners
  }
  return {};
}
