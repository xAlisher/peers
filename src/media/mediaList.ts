// #479: enumerate + classify the media in a conversation, oldest-first, so the
// full-screen viewer can page across ALL of it (photos, GIFs, videos). Pure and
// RN-free so it is unit-tested; the component resolves actual file paths
// (useMediaBlob / file://) at view time from `content`.
import {isImageContent} from '../native/imageMsg';
import {isMediaContent, parseMedia, type MediaRef} from '../messages/media';

export type MediaKind = 'photo' | 'gif' | 'video';

export interface MediaItem {
  msgPk: number;
  at: number;
  /** The raw marker (img1v: inline photo, or store*: blob) — parsed by the viewer. */
  content: string;
  kind: MediaKind;
  /** Group sender (directory-verified) or null for 1:1 / unknown. */
  sender: string | null;
}

/**
 * Is this media hosted on Logos Storage (store*:) rather than inline (img1v:)?
 * Viewing it costs a network fetch + decrypt — which #344 forbids in a
 * storage-off group. Malformed markers are not media at all (see classifyMedia).
 */
export function isStoredMedia(content: string): boolean {
  if (isImageContent(content)) return false; // inline photo — never touches Storage
  return isMediaContent(content) && parseMedia(content) != null;
}

/** Classify one message's media, or null if it carries none. */
export function classifyMedia(content: string): MediaKind | null {
  if (isImageContent(content)) return 'photo'; // img1v: inline photo
  if (isMediaContent(content)) {
    const ref = parseMedia(content);
    if (ref == null) return null; // malformed / rejected by #388 validation
    if (ref.mime.startsWith('video/')) return 'video';
    if (ref.mime === 'image/gif' || ref.mime.endsWith('/gif')) return 'gif';
    return 'photo'; // a store*: image — e.g. an HQ photo (#423)
  }
  return null;
}

export interface MediaRowLike {
  msgPk: number;
  at: number;
  text: string;
  senderAccount?: string | null;
}

export interface EnumerateMediaOpts {
  /**
   * #344: a storage-off group must make ZERO Storage requests. Stored (store*:)
   * media is therefore left out of the pager entirely — otherwise tapping an
   * allowed inline photo (#422) would page in historical blobs and fetch them.
   * Inline img1v: photos are unaffected: they never touch Storage.
   */
  storageOff?: boolean;
}

/**
 * Ordered (oldest-first) media items in a conversation, for the pager. Ties on
 * `at` break by `msgPk` so ordering is stable and deterministic.
 */
export function enumerateMedia(
  rows: ReadonlyArray<MediaRowLike>,
  opts?: EnumerateMediaOpts,
): MediaItem[] {
  const storageOff = opts?.storageOff === true;
  const items: MediaItem[] = [];
  for (const r of rows) {
    const kind = classifyMedia(r.text);
    if (kind == null) continue;
    if (storageOff && isStoredMedia(r.text)) continue; // #344: never fetch

    items.push({
      msgPk: r.msgPk,
      at: r.at,
      content: r.text,
      kind,
      sender: r.senderAccount ?? null,
    });
  }
  items.sort((a, b) => a.at - b.at || a.msgPk - b.msgPk);
  return items;
}

/**
 * The `MediaRef` the viewer is allowed to hand to `useMediaBlob` for an item —
 * `null` means "resolve no blob, fetch nothing".
 *
 * Null for an inline photo (it has no blob; the path comes from the marker) and
 * null whenever Storage is off (#344: a storage-off group makes ZERO Storage
 * requests). Both viewer hooks route through this one function so the policy is
 * a single testable decision rather than a condition duplicated per hook body.
 */
export function viewerMediaRef(
  content: string,
  storageOff: boolean,
): MediaRef | null {
  if (isImageContent(content)) return null;
  if (storageOff) return null;
  return parseMedia(content);
}

/** Index of a message in the ordered media list (to open the pager at the tap), or -1. */
export function mediaIndexOf(
  items: ReadonlyArray<MediaItem>,
  msgPk: number,
): number {
  return items.findIndex(i => i.msgPk === msgPk);
}
