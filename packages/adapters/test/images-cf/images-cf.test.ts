import { encode } from 'fast-png';
import { thumbHashToAverageRGBA } from 'thumbhash';
import { describe, expect, it } from 'vitest';
import {
  type CfImageTransform,
  type CfOutputFormat,
  cdnCgiOptions,
  createCfImageProbe,
  createCfImageTransformer,
  dominantColor,
  type ImagesBindingLike,
  negotiateFormat,
  parseTransformParams,
  rgbaFromPng,
  transformImage,
} from '../../src/images-cf/index';

/** Signer stand-in: deterministic, records what was signed. */
function fakeSigner() {
  const signed: { key: string; params: string }[] = [];
  return {
    signed,
    async sign(_m: 'GET', key: string, params: URLSearchParams) {
      signed.push({ key, params: params.toString() });
      return 'SIG';
    },
  };
}

/** Images binding fake: records the transform chain and output options. */
function fakeImages() {
  const calls: {
    transforms: CfImageTransform[];
    output?: { format: CfOutputFormat; quality?: number };
  } = { transforms: [] };
  const handle = {
    transform(t: CfImageTransform) {
      calls.transforms.push(t);
      return handle;
    },
    async output(o: { format: CfOutputFormat; quality?: number }) {
      calls.output = o;
      return {
        response: () => new Response('out', { headers: { 'content-type': o.format } }),
      };
    },
  };
  const images: ImagesBindingLike = {
    input: () => handle,
    info: async () => ({ format: 'image/png', fileSize: 3, width: 1, height: 1 }),
  };
  return { images, calls };
}

describe('createCfImageTransformer', () => {
  it('re-signs a /media URL with transform params, focal point as gravity, auto format by default', async () => {
    const signer = fakeSigner();
    const t = createCfImageTransformer({ signer });
    const url = await t.transformUrl(
      'https://api.example/media/s/main/a1/pic%20one.jpg?sig=OLD',
      { width: 400, height: 300, fit: 'crop' },
      { x: 0.25, y: 0.75 },
    );
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://api.example/media/s/main/a1/pic%20one.jpg');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      w: '400',
      h: '300',
      fit: 'crop',
      fm: 'auto',
      g: '0.25x0.75',
      sig: 'SIG',
    });
    expect(signer.signed[0]?.key).toBe('s/main/a1/pic one.jpg');
  });

  it('keeps root-relative media URLs relative', async () => {
    const t = createCfImageTransformer({ signer: fakeSigner() });
    expect(await t.transformUrl('/media/a/b.png?sig=x', { width: 10 })).toMatch(
      /^\/media\/a\/b\.png\?w=10&fm=auto&sig=SIG$/,
    );
  });

  it('uses /cdn-cgi/image on the configured zone for foreign sources, else passes through', async () => {
    const withZone = createCfImageTransformer({
      signer: fakeSigner(),
      zoneOrigin: 'https://img.example',
    });
    expect(
      await withZone.transformUrl(
        'https://bucket.example/a.jpg',
        { width: 100, fit: 'crop', format: 'webp', quality: 80 },
        { x: 0.5, y: 0.1 },
      ),
    ).toBe(
      'https://img.example/cdn-cgi/image/width=100,fit=cover,format=webp,quality=80,gravity=0.5x0.1/https://bucket.example/a.jpg',
    );
    const noZone = createCfImageTransformer({ signer: fakeSigner() });
    expect(await noZone.transformUrl('https://bucket.example/a.jpg', { width: 1 })).toBe(
      'https://bucket.example/a.jpg',
    );
  });
});

describe('transform params', () => {
  it('maps provider-neutral fits and clamps garbage', () => {
    expect(
      parseTransformParams(new URLSearchParams('w=200&h=100&fit=crop&g=0.2x0.8&q=70&fm=avif')),
    ).toEqual({
      transform: {
        width: 200,
        height: 100,
        fit: 'cover',
        gravity: { x: 0.2, y: 0.8, mode: 'box-center' },
      },
      format: 'avif',
      quality: 70,
    });
    expect(parseTransformParams(new URLSearchParams('w=-1&fit=bogus&g=2x2&q=500'))).toBeNull();
    expect(cdnCgiOptions({ fit: 'max', format: 'jpg' })).toBe('fit=scale-down,format=jpeg');
  });

  it('negotiates auto format from Accept', () => {
    expect(negotiateFormat('auto', 'image/avif,image/webp,*/*', 'image/jpeg')).toBe('image/avif');
    expect(negotiateFormat('auto', 'image/webp,*/*', 'image/jpeg')).toBe('image/webp');
    expect(negotiateFormat('auto', '*/*', 'image/png')).toBe('image/png');
    expect(negotiateFormat(undefined, null, 'image/gif')).toBe('image/gif');
    expect(negotiateFormat(undefined, null, 'image/tiff')).toBe('image/jpeg');
  });
});

describe('transformImage', () => {
  const body = () => new Response('bytes').body as ReadableStream<Uint8Array>;

  it('runs the binding chain and marks auto responses Vary: Accept', async () => {
    const { images, calls } = fakeImages();
    const res = await transformImage(
      images,
      body(),
      'image/jpeg',
      new URLSearchParams('w=320&fit=crop&g=0.5x0.5&fm=auto&q=60'),
      'image/webp',
    );
    expect(calls.transforms).toEqual([
      { width: 320, fit: 'cover', gravity: { x: 0.5, y: 0.5, mode: 'box-center' } },
    ]);
    expect(calls.output).toEqual({ format: 'image/webp', quality: 60 });
    expect(res?.headers.get('vary')).toBe('Accept');
    expect(res?.headers.get('cache-control')).toContain('max-age');
  });

  it('serves the original (null) for SVG or empty params', async () => {
    const { images } = fakeImages();
    expect(
      await transformImage(images, body(), 'image/svg+xml', new URLSearchParams('w=10'), null),
    ).toBeNull();
    expect(
      await transformImage(images, body(), 'image/png', new URLSearchParams(''), null),
    ).toBeNull();
  });
});

describe('createCfImageProbe', () => {
  const stream = (text: string) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(text));
        c.close();
      },
    });

  it('reads format and dimensions from the bytes', async () => {
    const seen: string[] = [];
    const probe = createCfImageProbe({
      info: async (s) => {
        seen.push(await new Response(s).text());
        return { format: 'image/jpeg', fileSize: 1234, width: 640, height: 480 };
      },
    });
    expect(await probe.info(stream('jpeg-bytes'))).toEqual({
      width: 640,
      height: 480,
      format: 'image/jpeg',
      size: 1234,
    });
    expect(seen).toEqual(['jpeg-bytes']);
  });

  it('answers null for SVG (no intrinsic size) and for bytes it cannot decode', async () => {
    const svg = createCfImageProbe({ info: async () => ({ format: 'image/svg+xml' }) });
    expect(await svg.info(stream('<svg/>'))).toBeNull();
    const notImage = createCfImageProbe({
      info: async () => {
        throw new Error('IMAGES_INFO_ERROR 9412: Unsupported image type');
      },
    });
    expect(await notImage.info(stream('%PDF'))).toBeNull();
  });

  it('throws when the service itself fails, so a durable step retries', async () => {
    const down = createCfImageProbe({
      info: async () => {
        throw new Error('network connection lost');
      },
    });
    await expect(down.info(stream('x'))).rejects.toThrow('network connection lost');
  });

  it('accepts any async-iterable byte stream', async () => {
    const probe = createCfImageProbe({
      info: async (s) => {
        const text = await new Response(s).text();
        return { format: 'image/png', fileSize: text.length, width: 2, height: 3 };
      },
    });
    async function* chunks() {
      yield new TextEncoder().encode('ab');
      yield new TextEncoder().encode('cd');
    }
    expect(await probe.info(chunks())).toMatchObject({ width: 2, height: 3, size: 4 });
  });
});

describe('image placeholders', () => {
  /** A width × height image, three quarters red and the last quarter blue, as RGBA. */
  const mostlyRed = (width: number, height: number) => {
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const blue = i >= (width * height * 3) / 4;
      rgba.set(blue ? [0, 0, 255, 255] : [255, 0, 0, 255], i * 4);
    }
    return rgba;
  };

  it('reads 8-bit RGB and RGBA, 16-bit and grey PNGs as 8-bit RGBA', () => {
    const rgb = encode({ width: 1, height: 1, data: new Uint8Array([10, 20, 30]), channels: 3 });
    expect([...(rgbaFromPng(rgb)?.rgba ?? [])]).toEqual([10, 20, 30, 255]);
    const rgba = encode({ width: 1, height: 1, data: new Uint8Array([1, 2, 3, 4]), channels: 4 });
    expect([...(rgbaFromPng(rgba)?.rgba ?? [])]).toEqual([1, 2, 3, 4]);
    const deep = encode({
      width: 1,
      height: 1,
      depth: 16,
      data: new Uint16Array([0xff00, 0x8000, 0x0100]),
      channels: 3,
    });
    expect([...(rgbaFromPng(deep)?.rgba ?? [])]).toEqual([255, 128, 1, 255]);
    const grey = encode({ width: 1, height: 1, data: new Uint8Array([7, 9]), channels: 2 });
    expect([...(rgbaFromPng(grey)?.rgba ?? [])]).toEqual([7, 7, 7, 9]);
    expect(rgbaFromPng(new TextEncoder().encode('not a png'))).toBeNull();
  });

  it('picks the colour most of the image is, not the mean of it, and skips the transparent', () => {
    expect(dominantColor(mostlyRed(4, 4))).toBe('#ff0000');
    // A transparent majority doesn't count against the visible part.
    const mostlyClear = new Uint8Array([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255]);
    expect(dominantColor(mostlyClear)).toBe('#0000ff');
    // Nothing visible at all: the colour of what's there.
    expect(dominantColor(new Uint8Array([0, 255, 0, 0]))).toBe('#00ff00');
  });

  /** An Images binding whose output is `png`, recording the transforms asked of it. */
  const binding = (png: Uint8Array, asked: unknown[] = []) => ({
    info: async () => ({ format: 'image/png', fileSize: png.byteLength, width: 4, height: 4 }),
    input(stream: ReadableStream<Uint8Array>) {
      const handle = {
        transform(t: CfImageTransform) {
          asked.push(t);
          return handle;
        },
        async output(o: { format: CfOutputFormat }) {
          asked.push(o);
          await new Response(stream).arrayBuffer();
          return { response: () => new Response(png, { headers: { 'content-type': o.format } }) };
        },
      };
      return handle;
    },
  });

  it('shrinks the image through the binding and hashes the thumbnail', async () => {
    const asked: unknown[] = [];
    const png = encode({ width: 8, height: 8, data: mostlyRed(8, 8), channels: 4 });
    const probe = createCfImageProbe(binding(png, asked));
    const placeholder = await probe.placeholder?.(
      new Response(new Uint8Array([1, 2, 3])).body as ReadableStream<Uint8Array>,
    );
    expect(asked).toEqual([{ width: 32, height: 32, fit: 'scale-down' }, { format: 'image/png' }]);
    expect(placeholder?.dominantColor).toBe('#ff0000');
    const hash = Uint8Array.from(atob(placeholder?.thumbhash ?? ''), (c) => c.charCodeAt(0));
    const average = thumbHashToAverageRGBA(hash);
    expect(average.r).toBeGreaterThan(average.b);
    expect(average.a).toBeCloseTo(1, 1);
  });

  it('answers null for what the binding cannot decode, and throws when the service fails', async () => {
    const refusing = createCfImageProbe({
      ...binding(new Uint8Array()),
      input() {
        throw new Error('IMAGES_TRANSFORM_ERROR 9412: Unsupported image type');
      },
    });
    expect(await refusing.placeholder?.(new Response('%PDF').body as never)).toBeNull();
    const down = createCfImageProbe({
      ...binding(new Uint8Array()),
      input() {
        throw new Error('network connection lost');
      },
    });
    await expect(down.placeholder?.(new Response('x').body as never)).rejects.toThrow(
      'network connection lost',
    );
    // Without `input` (an info-only binding), there is no placeholder to make.
    expect(
      createCfImageProbe({ info: binding(new Uint8Array()).info }).placeholder,
    ).toBeUndefined();
  });
});
