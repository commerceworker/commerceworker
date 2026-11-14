import { Ago } from '@commerceworker/content-admin/components/ago';
import { partsLine } from '@commerceworker/content-admin/components/assets/AssetUploadList';
import { InlineConfirm } from '@commerceworker/content-admin/components/InlineConfirm';
import { LoadingStatus } from '@commerceworker/content-admin/components/loading';
import { StatusBadge } from '@commerceworker/content-admin/components/status';
import {
  fileSize,
  type PartsProgress,
  replaceInParts,
  uploadsInParts,
} from '@commerceworker/content-admin/lib/assets';
import { actorLabel } from '@commerceworker/content-admin/lib/authorship';
import { useClient } from '@commerceworker/content-admin/lib/client-context';
import {
  ApiError,
  apiErrorMessage,
  type TeamPerson,
} from '@commerceworker/content-admin/lib/management';
import { useToast } from '@commerceworker/content-admin/lib/toast';
import type { Asset, AssetVersion } from '@commerceworker/domain';
import { Alert, AlertDescription, AlertTitle } from '@commerceworker/ui/alert';
import { Badge } from '@commerceworker/ui/badge';
import { Button } from '@commerceworker/ui/button';
import { Progress } from '@commerceworker/ui/progress';
import { SkeletonText } from '@commerceworker/ui/skeleton';
import { FileUp, History, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

type Replacing =
  | { readonly state: 'uploading'; readonly name: string; readonly progress?: PartsProgress }
  | { readonly state: 'failed'; readonly name: string; readonly error: string };

/**
 * Every file an asset has had, newest first: which is current, which Delivery serves, and which
 * came back by a restore. Replace file uploads the next version the way Upload creates an asset
 * (a signed PUT, then a commit; past 100 MiB in parts, with the bytes stored shown as they go and
 * a Cancel that keeps the current file); Restore makes an earlier file current again, as a new
 * version.
 * Neither changes what Delivery serves on a published asset until it is published again, so
 * when the two differ the panel says so and offers the publish.
 */
export function AssetVersions(props: { asset: Asset; onAssetChange?: (asset: Asset) => void }) {
  const { asset } = props;
  const { client } = useClient();
  const toast = useToast();
  const [versions, setVersions] = useState<AssetVersion[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [replacing, setReplacing] = useState<Replacing | null>(null);
  const [confirm, setConfirm] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  // The team names who uploaded each file; only an administrator may read it, so a refusal just
  // leaves the authors described by kind.
  const [people, setPeople] = useState<readonly TeamPerson[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<AbortController | null>(null);
  // Leaving the sheet mid-upload gives the upload up (the server discards its parts).
  useEffect(() => () => cancelRef.current?.abort(), []);
  useEffect(() => {
    let live = true;
    client
      .getTeam()
      .then((team) => live && setPeople(team.people))
      .catch(() => {
        /* not an administrator: authors read by kind */
      });
    return () => {
      live = false;
    };
  }, [client]);

  const load = useCallback(
    () =>
      client
        .listAssetVersions(asset.id)
        .then((items) => {
          setVersions(items);
          setLoadError(null);
        })
        .catch((e) => setLoadError(apiErrorMessage(e))),
    [client, asset.id],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const changed = async (next: Asset) => {
    props.onAssetChange?.(next);
    await load();
  };
  // After a lost race the asset moved on: show the sheet (its "· v{n}") and the list what it is now.
  const caughtUp = async () => {
    try {
      props.onAssetChange?.(await client.getAsset(asset.id));
    } catch {
      /* the list below still says what is current */
    }
    await load();
  };

  const replaceWith = async (file: File) => {
    setReplacing({ state: 'uploading', name: file.name });
    const controller = new AbortController();
    cancelRef.current = controller;
    try {
      const next = uploadsInParts(file.size)
        ? await replaceInParts(client, asset.id, file, {
            signal: controller.signal,
            onProgress: (progress) =>
              setReplacing({ state: 'uploading', name: file.name, progress }),
          })
        : await client.replaceAssetFile(asset.id, file);
      setReplacing(null);
      toast.success(`Replaced the file with “${file.name}” (version ${next.version ?? 1})`);
      await changed(next);
    } catch (e) {
      if (controller.signal.aborted) {
        // Cancelled: the upload was given up and the asset keeps its file; nothing to report.
        setReplacing(null);
        return;
      }
      // 409: another replace or restore committed first. Show what is current now.
      const lost = e instanceof ApiError && e.status === 409;
      setReplacing({
        state: 'failed',
        name: file.name,
        error: lost
          ? 'Another replace or restore finished first. The list shows it now; replace again to put this file on top.'
          : apiErrorMessage(e),
      });
      if (lost) await caughtUp();
    } finally {
      if (cancelRef.current === controller) cancelRef.current = null;
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const restore = async (version: number) => {
    setBusy(true);
    try {
      const next = await client.restoreAssetVersion(asset.id, version);
      setConfirm(null);
      toast.success(`Restored version ${version} as version ${next.version ?? 1}`);
      await changed(next);
    } catch (e) {
      toast.error(apiErrorMessage(e));
      if (e instanceof ApiError && e.status === 409) {
        setConfirm(null);
        await caughtUp();
      }
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    setBusy(true);
    try {
      const next = await client.publishAsset(asset.id);
      toast.success('Published: Delivery serves the current file');
      await changed(next);
    } catch (e) {
      // 409 asset_embargoed / asset_expired come with the server's own reason.
      toast.error(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const current = versions?.find((v) => v.current);
  const delivered = versions?.find((v) => v.published);
  const behind =
    asset.status === 'published' && current && delivered && current.version !== delivered.version;
  const video = Boolean(asset.file.video);

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            aria-label="Replacement file"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void replaceWith(file);
            }}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={video || replacing?.state === 'uploading'}
            aria-describedby={video ? 'asset-replace-video' : undefined}
            onClick={() => fileRef.current?.click()}
          >
            <FileUp aria-hidden="true" />
            Replace file
          </Button>
          {replacing?.state === 'uploading' && (
            <p role="status" className="flex items-center gap-1.5 text-muted-foreground text-ui">
              {/* The line is the status; ui's Spinner would be a second one inside it. */}
              <Loader2 aria-hidden="true" className="size-3.5 motion-safe:animate-spin" />
              Uploading “{replacing.name}”…
            </p>
          )}
          {replacing?.state === 'uploading' && replacing.progress && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => cancelRef.current?.abort()}
            >
              Cancel upload
            </Button>
          )}
        </div>
        {replacing?.state === 'uploading' && replacing.progress && (
          <div className="space-y-1">
            <Progress
              value={Math.round(
                (replacing.progress.loaded / Math.max(1, replacing.progress.total)) * 100,
              )}
              aria-label={`Uploading “${replacing.name}”`}
              getValueLabel={() => partsLine(replacing.progress as PartsProgress)}
              className="h-1"
            />
            <p className="text-muted-foreground text-xs tabular-nums">
              {partsLine(replacing.progress)}
            </p>
          </div>
        )}
        {video ? (
          <p id="asset-replace-video" className="max-w-measure text-muted-foreground text-xs">
            A hosted video can’t be replaced: its host holds one file per video. Upload the new cut
            as its own asset.
          </p>
        ) : (
          <p className="max-w-measure text-muted-foreground text-xs">
            The new file becomes the next version; every earlier one stays here to restore.
          </p>
        )}
        {replacing?.state === 'failed' && (
          <Alert variant="destructive">
            <AlertTitle>“{replacing.name}” didn’t replace the file</AlertTitle>
            <AlertDescription>
              <p>{replacing.error}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => setReplacing(null)}
              >
                Dismiss
              </Button>
            </AlertDescription>
          </Alert>
        )}
      </div>

      {behind && (
        <Alert variant="warning">
          <AlertTitle>Delivery serves version {delivered.version}</AlertTitle>
          <AlertDescription>
            <p>
              The published version is v{delivered.version}. Publish again to deliver v
              {current.version}.
            </p>
            <Button type="button" size="sm" className="mt-2" disabled={busy} onClick={publish}>
              Publish v{current.version}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {versions === null && loadError === null ? (
        <div className="space-y-2 text-xs">
          <LoadingStatus>Loading versions…</LoadingStatus>
          <SkeletonText width="82%" />
          <SkeletonText width="66%" />
        </div>
      ) : loadError !== null ? (
        <Alert variant="destructive">
          <AlertTitle>The versions didn’t load</AlertTitle>
          <AlertDescription>
            <p>{loadError}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => void load()}
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <ol aria-label="File versions" className="divide-y">
          {(versions ?? []).map((v) => (
            <li key={v.version} className="space-y-1.5 py-2.5">
              <div className="flex items-start gap-3">
                <span className="w-8 shrink-0 font-mono text-muted-foreground text-xs leading-5">
                  v{v.version}
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="min-w-0 truncate font-medium">{v.file.fileName}</span>
                    {v.current && <Badge variant="outline">Current</Badge>}
                    {v.published && <StatusBadge status="published" />}
                    {v.restoredFrom !== undefined && (
                      <Badge variant="outline">
                        <History aria-hidden="true" />
                        Restored from v{v.restoredFrom}
                      </Badge>
                    )}
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {fileSize(v.file.size)}
                    {v.createdAt && (
                      <>
                        {' · '}
                        <Ago at={v.createdAt} />
                      </>
                    )}
                    {v.createdBy && ` · by ${actorLabel(v.createdBy, { people }, 'inSentence')}`}
                  </p>
                </div>
                {!v.current && confirm !== v.version && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={busy}
                    aria-label={`Restore version ${v.version}`}
                    onClick={() => setConfirm(v.version)}
                  >
                    Restore
                  </Button>
                )}
              </div>
              {confirm === v.version && (
                <InlineConfirm
                  message={`Restore version ${v.version}?`}
                  note={
                    asset.status === 'published'
                      ? `Its file becomes current as a new version. Delivery keeps ${delivered ? `v${delivered.version}` : 'the published file'} until you publish again.`
                      : 'Its file becomes current as a new version; nothing is deleted.'
                  }
                  onCancel={() => setConfirm(null)}
                >
                  {/* The ink pill: nothing is lost, the current file stays in the list. */}
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy}
                    onClick={() => void restore(v.version)}
                  >
                    Restore v{v.version}
                  </Button>
                </InlineConfirm>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
