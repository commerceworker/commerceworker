import type { ExtractableFile, TextExtractor } from '@commerceworker/ports';
import {
  asWorkersAIError,
  DEFAULT_TIMEOUT_MS,
  gatewayRunOptions,
  WorkersAIError,
  type WorkersAiRun,
  withTimeout,
} from './transport';

/**
 * The `AI` binding's Markdown conversion (`env.AI.toMarkdown`), typed structurally: one file in,
 * one result out (`data` holds the Markdown, `format` is `error` when it could not convert).
 */
export type WorkersAiToMarkdown = (file: { name: string; blob: Blob }) => Promise<unknown>;

/** Speech to text: Whisper large v3 turbo, which takes the audio as base64. */
export const WORKERS_AI_TRANSCRIBE_MODEL = '@cf/openai/whisper-large-v3-turbo';

/**
 * What Markdown conversion reads, by content type: PDF, the office and OpenDocument formats, and
 * the structured text formats. Images are left out on purpose: converting one runs a vision model
 * to describe it, which is the alt-text step's job, under the AI budget.
 */
const DOCUMENT_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel.sheet.macroenabled.12',
  'application/vnd.ms-excel.sheet.binary.macroenabled.12',
  'application/vnd.ms-excel',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.apple.numbers',
  'text/html',
  'text/csv',
  'application/xml',
  'text/xml',
]);

/** Plain text needs no model: its bytes are the text. */
const PLAIN_TYPES = new Set(['text/plain', 'text/markdown']);

export interface WorkersAITextExtractorOptions {
  /** `env.AI.toMarkdown`, bound to the binding. */
  readonly toMarkdown: WorkersAiToMarkdown;
  /** `env.AI.run`, for Whisper. */
  readonly run: WorkersAiRun;
  readonly gatewayId?: string;
  readonly collectLogs?: boolean;
  readonly timeoutMs?: number;
}

const mimeOf = (contentType: string) => (contentType.split(';')[0] ?? '').trim().toLowerCase();

/**
 * The TextExtractor port on Workers AI: Markdown conversion for documents, Whisper for audio,
 * and a plain UTF-8 read for text files. The result is the file's own words, so it is untrusted:
 * callers store and index it, and never put it in a prompt as instructions.
 */
export function createWorkersAITextExtractor(opts: WorkersAITextExtractorOptions): TextExtractor {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runOpts = gatewayRunOptions(opts.gatewayId, opts.collectLogs);
  return {
    supports(contentType) {
      const mime = mimeOf(contentType);
      return DOCUMENT_TYPES.has(mime) || PLAIN_TYPES.has(mime) || mime.startsWith('audio/');
    },
    async extract(file: ExtractableFile) {
      const mime = mimeOf(file.contentType);
      if (PLAIN_TYPES.has(mime)) return utf8(file.chunks);
      if (mime.startsWith('audio/')) {
        let res: unknown;
        try {
          res = await withTimeout(
            opts.run(WORKERS_AI_TRANSCRIBE_MODEL, { audio: base64(file.chunks) }, runOpts),
            timeoutMs,
          );
        } catch (err) {
          throw asWorkersAIError(err);
        }
        const text = (res as { text?: unknown } | undefined)?.text;
        if (typeof text !== 'string') {
          throw new WorkersAIError('bad_response', 'transcription returned no text');
        }
        return text;
      }
      let res: unknown;
      try {
        res = await withTimeout(
          opts.toMarkdown({
            name: file.fileName,
            // The stream's chunks as they came: the Blob is the one copy the binding reads.
            blob: new Blob(file.chunks as Uint8Array<ArrayBuffer>[], { type: mime }),
          }),
          timeoutMs,
        );
      } catch (err) {
        throw asWorkersAIError(err);
      }
      // One file in gives one result; the binding returns it bare (or in a one-item array).
      const out = (Array.isArray(res) ? res[0] : res) as
        | { format?: unknown; data?: unknown; error?: unknown }
        | undefined;
      if (out?.format === 'error') {
        throw new WorkersAIError('bad_response', `conversion failed: ${String(out.error ?? '')}`);
      }
      return typeof out?.data === 'string' ? out.data : '';
    },
  };
}

/** Chunks decoded as one UTF-8 text (a character split across two chunks stays whole). */
function utf8(chunks: readonly Uint8Array[]): string {
  const decoder = new TextDecoder();
  let out = '';
  for (const chunk of chunks) out += decoder.decode(chunk, { stream: true });
  return out + decoder.decode();
}

/** Bytes of a run of 3 per base64 slice: 4 characters for every 3 bytes, never padded midway. */
const BASE64_SLICE = 3 * 0x2000;

/**
 * Chunks as one base64 string, encoded slice by slice straight from the chunks: never joined
 * into one array first, and no spread of a large array (which would overflow the call stack).
 * Each slice is a multiple of 3 bytes, so only the last one pads.
 */
function base64(chunks: readonly Uint8Array[]): string {
  const parts: string[] = [];
  let carry = new Uint8Array(0);
  const encode = (bytes: Uint8Array) => {
    let binary = '';
    for (let at = 0; at < bytes.length; at += 0x2000) {
      binary += String.fromCharCode(...bytes.subarray(at, at + 0x2000));
    }
    parts.push(btoa(binary));
  };
  for (const chunk of chunks) {
    let bytes = chunk;
    if (carry.length > 0) {
      const joined = new Uint8Array(carry.length + chunk.length);
      joined.set(carry);
      joined.set(chunk, carry.length);
      bytes = joined;
    }
    const whole = bytes.length - (bytes.length % 3);
    for (let at = 0; at < whole; at += BASE64_SLICE) {
      encode(bytes.subarray(at, Math.min(at + BASE64_SLICE, whole)));
    }
    carry = bytes.slice(whole);
  }
  if (carry.length > 0) encode(carry);
  return parts.join('');
}
