import type { Asset, ReferenceEdge, Tag } from '@commerceworker/domain';
import { Badge } from '@commerceworker/ui/badge';
import { Button } from '@commerceworker/ui/button';
import { ComposeLoader, composeIcons } from '@commerceworker/ui/compose-loader';
import { DialogError } from '@commerceworker/ui/dialog';
import { Input } from '@commerceworker/ui/input';
import { Label } from '@commerceworker/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@commerceworker/ui/select';
import {
  Sheet,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@commerceworker/ui/sheet';
import { SkeletonText } from '@commerceworker/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@commerceworker/ui/tabs';
import { Textarea } from '@commerceworker/ui/textarea';
import { Share2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { AssetPreview, FallbackTile } from '~/cms/components/AssetPreview';
import { AssetIngestBadges, BADGE_BUTTON_FOCUS } from '~/cms/components/assets/AssetIngestBadges';
import { AssetRightsForm } from '~/cms/components/assets/AssetRightsForm';
import { AssetShareDialog } from '~/cms/components/assets/AssetShareDialog';
import { AssetVersions } from '~/cms/components/assets/AssetVersions';
import { DiscardAsk, UNCONFIRMED_NOTE, useDiscardGuard } from '~/cms/components/discard-guard';
import { InlineConfirm } from '~/cms/components/InlineConfirm';
import { LoadingStatus } from '~/cms/components/loading';
import { ResponsiveSheetContent } from '~/cms/components/responsive-sheet';
import { StatusBadge, StatusDot, ToneBadge } from '~/cms/components/status';
import { coarse, useMedia } from '~/cms/lib/device';
import { useClient } from '../lib/client-context';
import type { ImageTransform } from '../lib/management';
import { useToast } from '../lib/toast';

/** The sheet's tabs, Details first: where an asset opens. */
type SheetTab = 'details' | 'versions' | 'usage' | 'renditions' | 'rights';

/**
 * One asset, in tabs. Details edits its media "Aspects" (localized alt text, a click-to-set focal
 * point for smart cropping, taxonomy tags), saved by Save metadata; Versions replaces or restores
 * its file; Usage lists the entries using it; Renditions previews transforms; Rights sets its
 * license, credit, expiry and embargo. What ingest found stays above the tabs, in sight from any.
 */
export function AssetDetailSheet(props: {
  asset: Asset | null;
  locale: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  /** Called with a refreshed asset (e.g. a video's new processing status). */
  onAssetChange?: (asset: Asset) => void;
  /** Opens another asset by id (the original a possible duplicate points at). */
  onOpenAsset?: (id: string) => void;
}) {
  const { asset, locale } = props;
  const { client } = useClient();
  const toast = useToast();
  const [altText, setAltText] = useState('');
  const [focal, setFocal] = useState<{ x: number; y: number } | undefined>();
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [usage, setUsage] = useState<ReferenceEdge[] | null>(null);
  const [busy, setBusy] = useState(false);
  // The model call under way, if any: its button shows the mark composing.
  const [suggesting, setSuggesting] = useState<'alt' | 'tags' | null>(null);
  const [width, setWidth] = useState('400');
  const [fit, setFit] = useState<NonNullable<ImageTransform['fit']>>('crop');
  const [format, setFormat] = useState<ImageTransform['format'] | 'original'>('original');
  const [preview, setPreview] = useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<SheetTab>('details');
  const [sharing, setSharing] = useState(false);
  const [rightsDirty, setRightsDirty] = useState(false);
  const [rightsSaving, setRightsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  // The original a possible duplicate points at, waiting on "discard your edits?".
  const [confirmOpen, setConfirmOpen] = useState<string | null>(null);
  const imgRef = useRef<HTMLButtonElement>(null);
  const altRef = useRef<HTMLTextAreaElement>(null);
  const finger = useMedia('(pointer: coarse)');
  // The values the form was filled from: what "changed" and "unsaved" are measured against.
  const [base, setBase] = useState<FormValues>({ altText: '', tagIds: [] });

  // Hydrate the form when the sheet opens on an asset, and only then: the same asset coming back
  // refreshed (a Retry, a video's new status, a poll) keeps what the editor has typed.
  const assetRef = useRef(asset);
  assetRef.current = asset;
  const assetId = asset?.id;
  useEffect(() => {
    const asset = assetRef.current;
    if (!asset || !props.open) return;
    const values = formValues(asset, locale);
    setBase(values);
    setAltText(values.altText);
    setFocal(values.focal);
    setTagIds([...values.tagIds]);
    setConfirmOpen(null);
    setSharing(false);
    setTab('details');
    setUsage(null);
    setPreview(null);
    setPreviewFailed(false);
    setImageFailed(false);
    client
      .listTags()
      .then(setAllTags)
      .catch(() => setAllTags([]));
    client
      .assetUsage(asset.id)
      .then(setUsage)
      .catch(() => setUsage([]));
  }, [assetId, props.open, locale, client]);

  const altChanged = altText !== base.altText;
  const tagsChanged = !sameSet(tagIds, base.tagIds);
  const dirty = altChanged || tagsChanged || !sameFocal(focal, base.focal);
  const guard = useDiscardGuard({
    open: props.open,
    dirty: dirty || rightsDirty,
    saving: busy || rightsSaving,
    subject: assetId,
    onOpenChange: props.onOpenChange,
  });
  // What leaving would lose. Each half saves on its own, so neither speaks for the other.
  const unsaved = !dirty
    ? 'The rights here are not saved.'
    : rightsDirty
      ? 'Alt text, tags, the focal point and rights here are not saved.'
      : 'Alt text, tags and the focal point here are not saved.';

  if (!asset) return null;
  const isImage = asset.file.contentType.startsWith('image/');
  const video = asset.file.video;

  const refreshVideo = async () => {
    setRefreshing(true);
    try {
      props.onAssetChange?.(await client.refreshVideoAsset(asset.id));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  };

  const retryIngest = async () => {
    try {
      props.onAssetChange?.(await client.reingestAsset(asset.id));
      toast.success('Processing again');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  // Opening the original replaces this form: with edits in it, that is asked in place first.
  const openOriginal = (id: string) => {
    if (dirty || rightsDirty) setConfirmOpen(id);
    else props.onOpenAsset?.(id);
  };

  // What ingest filled from a model and no one has saved yet. A save sends alt text and tags only
  // when they changed here, and the API clears the mark only on what changed (this locale's alt
  // text, the tags added or removed), so saving the focal point leaves suggestions marked. The
  // alt text badge goes as soon as the value here differs from the suggestion.
  const altSuggested =
    asset.aiSuggestions?.altText?.includes(locale) === true &&
    altText === String(asset.metadata.altText?.[locale] ?? '');
  const suggestedTags = new Set(asset.aiSuggestions?.tags ?? []);
  const showIngest = Boolean(
    asset.duplicateOf ||
      asset.ingestStatus === 'error' ||
      asset.ingestStatus === 'pending' ||
      asset.ingestStatus === 'processing',
  );

  const pickFocal = (e: React.MouseEvent<HTMLButtonElement>) => {
    // Enter or Space clicks with no pointer (detail 0): place the point in the middle to start,
    // rather than at the corner a pointerless click's coordinates would name.
    if (e.detail === 0) {
      setFocal((f) => f ?? { x: 0.5, y: 0.5 });
      return;
    }
    const rect = imgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    setFocal({ x: Number(x.toFixed(3)), y: Number(y.toFixed(3)) });
  };

  // The arrow keys move the point 1% (10% with Shift), from the middle when none is set yet.
  const nudgeFocal = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const step = e.shiftKey ? 0.1 : 0.01;
    const move = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }[e.key];
    if (!move) return;
    e.preventDefault();
    const clamp = (n: number) => Number(Math.min(1, Math.max(0, n)).toFixed(3));
    setFocal((f) => {
      const from = f ?? { x: 0.5, y: 0.5 };
      return { x: clamp(from.x + (move[0] ?? 0)), y: clamp(from.y + (move[1] ?? 0)) };
    });
  };

  const toggleTag = (id: string) => {
    setTagIds((ids) => (ids.includes(id) ? ids.filter((t) => t !== id) : [...ids, id]));
  };

  const applyTransform = async () => {
    try {
      const { url } = await client.transformAsset(asset.id, {
        width: width ? Number(width) : undefined,
        fit,
        format: format === 'original' ? undefined : format,
      });
      setPreviewFailed(false);
      setPreview(url);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const suggestAlt = async () => {
    setSuggesting('alt');
    try {
      const { altText: suggestion } = await client.generateAltText(asset.id, { locale });
      setAltText(suggestion);
      toast.success('Alt text suggested — review and save');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSuggesting(null);
    }
  };

  const suggestTags = async () => {
    setSuggesting('tags');
    try {
      const { tagIds: matched, newTags } = await client.autoTagAsset(asset.id);
      setTagIds((ids) => Array.from(new Set([...ids, ...matched])));
      toast.success(
        newTags.length
          ? `Tagged. New tag ideas: ${newTags.join(', ')} (add in Taxonomy)`
          : 'Tags suggested — review and save',
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSuggesting(null);
    }
  };

  const save = async () => {
    setBusy(true);
    setSaveError(undefined);
    try {
      await client.setAssetMetadata(asset.id, {
        ...(altChanged ? { altText: { ...asset.metadata.altText, [locale]: altText } } : {}),
        ...(tagsChanged ? { tags: tagIds } : {}),
        focalPoint: focal,
      });
      toast.success('Metadata saved');
      props.onSaved();
      setBase({ altText, tagIds: [...tagIds], focal });
      // Rights have their own Save: this one's success doesn't speak for them.
      if (rightsDirty) guard.onOpenChange(false);
      else props.onOpenChange(false);
    } catch (e) {
      setSaveError(guard.saveFailed(e));
    } finally {
      setBusy(false);
    }
  };

  // The sheet is for its form, so that is where it opens, not on Share. Never a text field under a
  // finger, where the keyboard would rise over what was just opened: the sheet itself takes focus.
  const toTheForm = (event: Event) => {
    const target = imgRef.current ?? (coarse() ? null : altRef.current);
    event.preventDefault();
    (target ?? (event.currentTarget as HTMLElement)).focus({ preventScroll: true });
  };

  return (
    <Sheet open={props.open} onOpenChange={guard.onOpenChange}>
      <ResponsiveSheetContent className="w-full sm:max-w-lg" onOpenAutoFocus={toTheForm}>
        <SheetHeader>
          <SheetTitle className="truncate">{asset.file.fileName}</SheetTitle>
          <SheetDescription className="font-mono text-xs">
            {asset.file.contentType} · v{asset.version ?? 1}
          </SheetDescription>
        </SheetHeader>
        {/* Sharing opens the share dialog over the sheet; it explains when the asset can't be
            shared (not published) or the role can't share, rather than hiding the way in. It
            scrolls with the body: on a phone the pinned header has to stay short. */}
        <div className="-mt-2 px-4">
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-haspopup="dialog"
            onClick={() => setSharing(true)}
          >
            <Share2 aria-hidden="true" />
            Share
          </Button>
        </div>
        <AssetShareDialog
          open={sharing}
          onOpenChange={setSharing}
          target={{ type: 'asset', id: asset.id, name: asset.file.fileName }}
          published={asset.status === 'published'}
          archived={asset.status === 'archived'}
          onPublished={(next) => {
            props.onAssetChange?.(next);
            props.onSaved();
          }}
          onPublishUnconfirmed={props.onSaved}
        />

        <div className="space-y-5 px-4 pb-4">
          {showIngest && (
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-1">
                <AssetIngestBadges
                  asset={asset}
                  name={asset.file.fileName}
                  {...(props.onOpenAsset ? { onOpenOriginal: openOriginal } : {})}
                  onRetry={() => void retryIngest()}
                />
              </div>
              {confirmOpen && (
                <InlineConfirm
                  message="Open the original and discard your changes?"
                  note={guard.unconfirmed ? UNCONFIRMED_NOTE : unsaved}
                  cancelLabel="Keep editing"
                  onCancel={() => setConfirmOpen(null)}
                >
                  {/* The ink pill: nothing stored is deleted, only this form's unsaved values. */}
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => {
                      const id = confirmOpen;
                      setConfirmOpen(null);
                      props.onOpenAsset?.(id);
                    }}
                  >
                    Discard and open
                  </Button>
                </InlineConfirm>
              )}
              {asset.duplicateOf && (
                <p className="text-muted-foreground text-xs">
                  The same file is already in the library.
                </p>
              )}
            </div>
          )}

          <Tabs value={tab} onValueChange={(v) => setTab(v as SheetTab)}>
            {/* Five tabs in a phone-wide sheet: the row scrolls rather than squeezing a word. */}
            <TabsList className="w-full overflow-x-auto">
              <TabsTrigger value="details">Details</TabsTrigger>
              <TabsTrigger value="versions">Versions</TabsTrigger>
              <TabsTrigger value="usage">Usage</TabsTrigger>
              <TabsTrigger value="renditions">Renditions</TabsTrigger>
              <TabsTrigger value="rights">Rights</TabsTrigger>
            </TabsList>

            <TabsContent value="details" className="space-y-5 pt-3">
              {video && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Video</Label>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={refreshVideo}
                      disabled={refreshing}
                    >
                      {refreshing ? 'Checking…' : 'Refresh status'}
                    </Button>
                  </div>
                  <AssetPreview
                    asset={asset}
                    alt={altText || asset.file.fileName}
                    className="w-full"
                  />
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <StatusBadge
                      status={video.status === 'ready' ? 'completed' : video.status}
                      label={video.status}
                    />
                    {video.durationSeconds !== undefined && (
                      <span className="text-muted-foreground">
                        {Math.round(video.durationSeconds)}s
                      </span>
                    )}
                    {video.errorReason && (
                      <span className="text-destructive">{video.errorReason}</span>
                    )}
                  </div>
                  {video.hlsUrl && (
                    <p className="break-all font-mono text-xs text-muted-foreground">
                      HLS {video.hlsUrl}
                    </p>
                  )}
                </div>
              )}

              {isImage && (
                <div className="space-y-1.5">
                  <Label>Focal point</Label>
                  {/* One control for pointer and keyboard: click where the point goes, or
                      focus it and use the arrow keys. Its name says where the point is. */}
                  <button
                    type="button"
                    ref={imgRef}
                    onClick={pickFocal}
                    onKeyDown={nudgeFocal}
                    aria-label={
                      focal
                        ? `Focal point: ${Math.round(focal.x * 100)}% across, ${Math.round(focal.y * 100)}% down`
                        : 'Focal point: not set'
                    }
                    aria-describedby="asset-focal-hint"
                    className="relative block w-full cursor-crosshair overflow-hidden rounded-md border outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
                  >
                    {imageFailed ? (
                      <FallbackTile asset={asset} className="h-40 w-full" />
                    ) : (
                      // Named by the control around it; the alt text is edited below.
                      <img
                        src={asset.file.url}
                        alt=""
                        onError={() => setImageFailed(true)}
                        className="w-full"
                      />
                    )}
                    {focal && (
                      // A ring in the ink with a halo in the paper, and a dot at the point: one of
                      // the two always stands off the picture, light or dark, in either theme.
                      <span
                        data-testid="focal-marker"
                        className="-translate-x-1/2 -translate-y-1/2 pointer-events-none absolute grid size-6 place-items-center rounded-full border-2 border-foreground ring-2 ring-background"
                        style={{ left: `${focal.x * 100}%`, top: `${focal.y * 100}%` }}
                      >
                        <span className="size-1.5 rounded-full bg-foreground ring-1 ring-background" />
                      </span>
                    )}
                  </button>
                  {/* Polite and live: where the point moved to is heard, in browse mode too. */}
                  <p
                    id="asset-focal-hint"
                    aria-live="polite"
                    className="text-muted-foreground text-xs"
                  >
                    {finger
                      ? focal
                        ? `x ${focal.x}, y ${focal.y}. Tap to move it.`
                        : 'Tap the image to set a focal point for smart cropping.'
                      : focal
                        ? `x ${focal.x}, y ${focal.y}. Click to move it, or use the arrow keys (Shift for bigger steps).`
                        : 'Click the image, or focus it and press Enter, to set a focal point for smart cropping.'}
                  </p>
                </div>
              )}

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="asset-alt">Alt text ({locale})</Label>
                    {altSuggested && <ToneBadge tone="ai" label="AI suggestion" />}
                  </div>
                  {isImage && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={suggesting !== null}
                      onClick={suggestAlt}
                    >
                      {/* The mark at rest; the task's icon composes while the model works. */}
                      <ComposeLoader
                        icon={suggesting === 'alt' ? composeIcons.write : composeIcons.aiMark}
                        playing={suggesting === 'alt'}
                        className="text-ai"
                      />
                      {suggesting === 'alt' ? 'Generating…' : 'Generate alt text'}
                    </Button>
                  )}
                </div>
                <Textarea
                  ref={altRef}
                  id="asset-alt"
                  value={altText}
                  onChange={(e) => setAltText(e.target.value)}
                  placeholder="Describe the image for accessibility and SEO."
                  rows={3}
                />
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Label>Tags</Label>
                    {[...suggestedTags].some((id) => tagIds.includes(id)) && (
                      <ToneBadge tone="ai" label="AI suggestion" />
                    )}
                  </div>
                  {isImage && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={suggesting !== null}
                      onClick={suggestTags}
                    >
                      <ComposeLoader
                        icon={suggesting === 'tags' ? composeIcons.asset : composeIcons.aiMark}
                        playing={suggesting === 'tags'}
                        className="text-ai"
                      />
                      {suggesting === 'tags' ? 'Suggesting…' : 'Suggest tags'}
                    </Button>
                  )}
                </div>
                {allTags.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    No tags defined in this space yet.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {allTags.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        aria-pressed={tagIds.includes(t.id)}
                        onClick={() => toggleTag(t.id)}
                        className={BADGE_BUTTON_FOCUS}
                      >
                        <Badge variant={tagIds.includes(t.id) ? 'default' : 'outline'}>
                          {suggestedTags.has(t.id) && tagIds.includes(t.id) && (
                            <StatusDot status="suggested" className="ring-1 ring-background" />
                          )}
                          {t.name}
                          {suggestedTags.has(t.id) && tagIds.includes(t.id) && (
                            <>
                              <span aria-hidden="true" className="font-normal">
                                AI
                              </span>
                              <span className="sr-only"> (AI suggestion)</span>
                            </>
                          )}
                        </Badge>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </TabsContent>

            {/* Versions and Rights stay mounted while hidden: an upload under way, or rights typed
                but not saved, would otherwise be dropped by a look at another tab. */}
            <TabsContent value="versions" forceMount className="pt-3 data-[state=inactive]:hidden">
              <AssetVersions asset={asset} onAssetChange={props.onAssetChange} />
            </TabsContent>

            <TabsContent value="usage" className="pt-3">
              <div className="space-y-1.5">
                <Label>Used by {usage ? `(${usage.length})` : ''}</Label>
                {usage === null ? (
                  <div className="space-y-1 text-xs">
                    <LoadingStatus>Loading where this asset is used…</LoadingStatus>
                    <SkeletonText width="78%" />
                    <SkeletonText width="64%" />
                  </div>
                ) : usage.length === 0 ? (
                  <p className="text-muted-foreground text-sm">Not referenced by any entry.</p>
                ) : (
                  <ul className="space-y-1">
                    {usage.map((u) => (
                      <li key={`${u.fromEntryId}:${u.fromField}`} className="font-mono text-xs">
                        {u.fromEntryId}
                        <span className="text-muted-foreground"> · {u.fromField}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </TabsContent>

            <TabsContent value="renditions" className="space-y-5 pt-3">
              {isImage && (
                <div className="space-y-2">
                  <Label>Transform preview</Label>
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="space-y-1">
                      <Label htmlFor="t-width" className="text-muted-foreground text-xs">
                        Width
                      </Label>
                      <Input
                        id="t-width"
                        type="number"
                        value={width}
                        onChange={(e) => setWidth(e.target.value)}
                        className="h-8 w-24"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-muted-foreground text-xs">Fit</Label>
                      <Select
                        value={fit}
                        onValueChange={(v) => setFit(v as NonNullable<ImageTransform['fit']>)}
                      >
                        <SelectTrigger aria-label="Image fit" className="h-8 w-28">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(['clip', 'crop', 'fill', 'max', 'scale'] as const).map((f) => (
                            <SelectItem key={f} value={f}>
                              {f}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-muted-foreground text-xs">Format</Label>
                      <Select
                        value={format}
                        onValueChange={(v) => setFormat(v as ImageTransform['format'] | 'original')}
                      >
                        <SelectTrigger aria-label="Image format" className="h-8 w-28">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(['original', 'auto', 'jpg', 'png', 'webp', 'avif'] as const).map(
                            (f) => (
                              <SelectItem key={f} value={f}>
                                {f}
                              </SelectItem>
                            ),
                          )}
                        </SelectContent>
                      </Select>
                    </div>
                    <Button type="button" variant="outline" size="sm" onClick={applyTransform}>
                      Apply
                    </Button>
                  </div>
                  {preview && (
                    <div className="space-y-1">
                      {previewFailed ? (
                        <FallbackTile asset={asset} className="h-32 w-full" />
                      ) : (
                        <img
                          src={preview}
                          alt="Transformed preview"
                          onError={() => setPreviewFailed(true)}
                          className="max-h-48 rounded-md border"
                        />
                      )}
                      <p className="break-all font-mono text-xs text-muted-foreground">{preview}</p>
                    </div>
                  )}
                  <p className="text-muted-foreground text-xs">
                    Crop honors the saved focal point — save metadata first to see its effect.
                  </p>
                </div>
              )}

              {!isImage && (
                <p className="max-w-measure text-muted-foreground text-sm">
                  Renditions are made from images. This file is delivered as it was uploaded.
                </p>
              )}
            </TabsContent>

            <TabsContent value="rights" forceMount className="pt-3 data-[state=inactive]:hidden">
              <AssetRightsForm
                key={asset.id}
                asset={asset}
                onAssetChange={props.onAssetChange}
                onDirty={setRightsDirty}
                onSaving={setRightsSaving}
                onSaveFailed={guard.saveFailed}
              />
            </TabsContent>
          </Tabs>
        </div>

        {/* Save metadata saves the Details tab; the other tabs act at once or have their own. */}
        {(tab === 'details' || guard.asking) && saveError && (
          <DialogError className="px-4">{saveError}</DialogError>
        )}
        {(tab === 'details' || guard.asking) && (
          <SheetFooter>
            <DiscardAsk
              guard={guard}
              message={`Discard your changes to ${asset.file.fileName}?`}
              note={unsaved}
            >
              <Button type="button" onClick={save} disabled={busy}>
                {busy ? 'Saving…' : 'Save metadata'}
              </Button>
            </DiscardAsk>
          </SheetFooter>
        )}
      </ResponsiveSheetContent>
    </Sheet>
  );
}

interface FormValues {
  readonly altText: string;
  readonly tagIds: readonly string[];
  readonly focal?: { x: number; y: number };
}

/** The editable values of an asset, in `locale`, as the form starts them. */
function formValues(asset: Asset, locale: string): FormValues {
  return {
    altText: String(asset.metadata.altText?.[locale] ?? ''),
    tagIds: [...asset.metadata.tags],
    ...(asset.metadata.focalPoint ? { focal: asset.metadata.focalPoint } : {}),
  };
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

const sameFocal = (a?: { x: number; y: number }, b?: { x: number; y: number }) =>
  a?.x === b?.x && a?.y === b?.y;
