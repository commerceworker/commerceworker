import { describe, expect, it } from 'vitest';
import {
  createWorkersAITextExtractor,
  NO_LOG_PAYLOAD,
  WORKERS_AI_TRANSCRIBE_MODEL,
  WorkersAIError,
  type WorkersAiRun,
  type WorkersAiToMarkdown,
} from '../../src/ai-workers/index';

const bytes = (text: string) => new TextEncoder().encode(text);
/** A file's bytes as a stream hands them over: in chunks. */
const chunked = (...parts: (string | Uint8Array)[]) => {
  const chunks = parts.map((p) => (typeof p === 'string' ? bytes(p) : p));
  return { chunks, size: chunks.reduce((n, c) => n + c.byteLength, 0) };
};

function fakes(markdown: unknown = { format: 'markdown', data: '# Report\n\nBody' }) {
  const converted: { name: string; type: string; text: string }[] = [];
  const runs: { model: string; input: Record<string, unknown>; opts?: unknown }[] = [];
  const toMarkdown: WorkersAiToMarkdown = async ({ name, blob }) => {
    converted.push({ name, type: blob.type, text: await blob.text() });
    return markdown;
  };
  const run: WorkersAiRun = async (model, input, opts) => {
    runs.push({ model, input, opts });
    return { text: 'spoken words' };
  };
  return { toMarkdown, run, converted, runs };
}

describe('workers-ai text extractor', () => {
  it('converts documents to Markdown and says which types it reads', async () => {
    const f = fakes();
    const x = createWorkersAITextExtractor({ toMarkdown: f.toMarkdown, run: f.run });
    expect(x.supports('application/pdf')).toBe(true);
    expect(
      x.supports('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    ).toBe(true);
    expect(x.supports('audio/mpeg')).toBe(true);
    expect(x.supports('image/png')).toBe(false);
    expect(x.supports('application/zip')).toBe(false);
    const text = await x.extract({
      fileName: 'report.pdf',
      contentType: 'application/pdf; charset=binary',
      ...chunked('%PDF-1.7'),
    });
    expect(text).toBe('# Report\n\nBody');
    expect(f.converted).toEqual([
      { name: 'report.pdf', type: 'application/pdf', text: '%PDF-1.7' },
    ]);
  });

  it('reads plain text itself, without a model', async () => {
    const f = fakes();
    const x = createWorkersAITextExtractor({ toMarkdown: f.toMarkdown, run: f.run });
    expect(
      await x.extract({ fileName: 'a.txt', contentType: 'text/plain', ...chunked('héllo') }),
    ).toBe('héllo');
    expect(f.converted).toEqual([]);
    expect(f.runs).toEqual([]);
  });

  it('transcribes audio with Whisper through the gateway, payload logging off', async () => {
    const f = fakes();
    const x = createWorkersAITextExtractor({
      toMarkdown: f.toMarkdown,
      run: f.run,
      gatewayId: 'gw',
    });
    const text = await x.extract({
      fileName: 'talk.mp3',
      contentType: 'audio/mpeg',
      ...chunked('ID3'),
    });
    expect(text).toBe('spoken words');
    expect(f.runs[0]?.model).toBe(WORKERS_AI_TRANSCRIBE_MODEL);
    expect(f.runs[0]?.input).toEqual({ audio: btoa('ID3') });
    expect(f.runs[0]?.opts).toMatchObject({ gateway: { id: 'gw' }, extraHeaders: NO_LOG_PAYLOAD });
  });

  it('throws a typed error when conversion reports one, so the step retries or records it', async () => {
    const f = fakes([{ format: 'error', error: 'encrypted PDF' }]);
    const x = createWorkersAITextExtractor({ toMarkdown: f.toMarkdown, run: f.run });
    await expect(
      x.extract({ fileName: 'x.pdf', contentType: 'application/pdf', ...chunked('x') }),
    ).rejects.toBeInstanceOf(WorkersAIError);
  });

  it('builds the conversion Blob and the base64 audio from the chunks, whatever their sizes', async () => {
    const f = fakes();
    const x = createWorkersAITextExtractor({ toMarkdown: f.toMarkdown, run: f.run });
    await x.extract({
      fileName: 'a.pdf',
      contentType: 'application/pdf',
      ...chunked('%PD', 'F-', '1.7'),
    });
    expect(f.converted[0]?.text).toBe('%PDF-1.7');

    // Uneven chunks (not multiples of 3) and one long enough to need several slices.
    const long = new Uint8Array(70_001).map((_, i) => (i * 7) % 256);
    const parts = [bytes('I'), bytes('D3\u0001'), long, bytes('xy')];
    await x.extract({ fileName: 't.mp3', contentType: 'audio/mpeg', ...chunked(...parts) });
    const whole = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      whole.set(p, at);
      at += p.length;
    }
    expect(f.runs[0]?.input).toEqual({ audio: Buffer.from(whole).toString('base64') });
  });

  it('decodes UTF-8 split across chunks as one text', async () => {
    const f = fakes();
    const x = createWorkersAITextExtractor({ toMarkdown: f.toMarkdown, run: f.run });
    const e = bytes('é');
    const text = await x.extract({
      fileName: 'a.txt',
      contentType: 'text/plain',
      ...chunked(bytes('h'), e.subarray(0, 1), e.subarray(1), bytes('llo')),
    });
    expect(text).toBe('héllo');
  });
});
