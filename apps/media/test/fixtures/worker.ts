// Test entry: the media Worker as deployed, except that its cached entrypoint's Images binding is
// the fake below (Miniflare's needs a network-backed image service). The gateway reaches it the
// same way it does in production, through ctx.exports.Media.
import type { ImagesBindingLike } from '@commerceworker/adapters/images-cf';
import worker, { Media as DeployedMedia } from '../../src/index';
import type { MediaDeps } from '../../src/serve';

/** What the fake records about the last transform, so a test can see what was asked for. */
export const fakeImages: ImagesBindingLike = {
  // The media Worker never probes; the binding shape has it for ingest.
  async info() {
    return { format: 'image/png', fileSize: 0, width: 1, height: 1 };
  },
  input(stream) {
    const steps: unknown[] = [];
    const handle = {
      transform(t: unknown) {
        steps.push(t);
        return handle;
      },
      async output(o: { format: string; quality?: number }) {
        await new Response(stream).arrayBuffer();
        return {
          response: () =>
            new Response(JSON.stringify({ transforms: steps, format: o.format }), {
              headers: { 'content-type': o.format },
            }),
        };
      },
    };
    return handle;
  },
};

export class Media extends DeployedMedia {
  protected override deps(): MediaDeps {
    return { ...super.deps(), images: fakeImages };
  }
}

export default worker;
