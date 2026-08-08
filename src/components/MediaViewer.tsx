// #479: one full-screen media viewer for photos, GIFs and videos.
//
// - Edge-to-edge Modal (statusBarTranslucent) — fixes the old ImageFullscreen
//   "under the title bar" bug (it was an in-tree overlay below a shown header).
// - Tap 1 opens on black with NO controls; tap toggles a semi-transparent bottom
//   bar (author + caption + download/share/forward/close) + a top-right close circle.
// - Pinch-zoom (bar hides during zoom, tap brings it back); swipe-down dismisses
//   in both modes; swipe left/right pages across ALL conversation media.
// - Uses react-native-gesture-handler + reanimated (added for this; see App.tsx).
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  BackHandler,
  Dimensions,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {Gesture, GestureDetector} from 'react-native-gesture-handler';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import {HexAvatar, type AvatarKind} from './HexAvatar';
import {MediaVideo} from './MediaVideo';
import {XIcon} from './XIcon';
import {DownloadIcon, ShareIcon, ForwardIcon} from './MediaViewerIcons';
import {isImageContent, parseImageLocal} from '../native/imageMsg';
import {useMediaBlob} from '../native/mediaCache';
import {viewerMediaRef, type MediaItem} from '../media/mediaList';
import {
  clampScale,
  doubleTapScale,
  isAtFit,
  shouldDismiss,
} from '../media/mediaGestures';

/** Author identity for the bar — resolved by the caller (ChatScreen). */
export interface MediaAuthor {
  address: string;
  label?: string | null;
  hex: string;
  kind: AvatarKind;
}

export interface MediaViewerProps {
  items: MediaItem[];
  index: number;
  onClose: () => void;
  authorFor: (item: MediaItem) => MediaAuthor | null;
  /** Caption text for an item, if any (empty today — future combined messages). */
  captionFor?: (item: MediaItem) => string | null;
  onForward: (content: string) => void;
  onSave: (item: MediaItem, path: string) => void;
  onShare: (item: MediaItem, path: string) => void;
  /**
   * #344: storage-off group — the blob hooks must receive `null` so no Storage
   * request ever fires. ChatScreen already keeps stored items out of `items`;
   * this is the second line of defence at the only place that can fetch.
   */
  storageOff?: boolean;
}

// The Modal is full-bleed (statusBarTranslucent), so pages must fill the *screen*
// (incl. the status/nav-bar area) — 'window' height is short and leaves the chat
// composer peeking through at the bottom.
const {width: SCREEN_W} = Dimensions.get('window');
const SCREEN_H = Dimensions.get('screen').height;

/** Resolve a viewable local path for one item (inline photo vs store blob). */
function usePagePath(
  item: MediaItem,
  storageOff: boolean,
): {path: string | null; loading: boolean} {
  const inline = isImageContent(item.content);
  // #344: in a storage-off group this resolves to null, so useMediaBlob stays
  // idle and no download/decrypt is ever requested.
  const ref = useMemo(
    () => viewerMediaRef(item.content, storageOff),
    [item.content, storageOff],
  );
  const blob = useMediaBlob(ref);
  if (inline) {
    return {path: parseImageLocal(item.content)?.path ?? null, loading: false};
  }
  if (ref == null) return {path: null, loading: false}; // renders "unavailable"
  return {
    path: blob.status === 'ready' ? blob.path : null,
    loading: blob.status === 'loading' || blob.status === 'idle',
  };
}

/** One full-screen page: zoomable photo/gif, or a playing video. */
function MediaPage({
  item,
  active,
  storageOff,
  onToggleControls,
  onHideControls,
  onZoomChange,
  onClose,
}: {
  item: MediaItem;
  active: boolean;
  storageOff: boolean;
  onToggleControls: () => void;
  onHideControls: () => void;
  onZoomChange: (zoomed: boolean) => void;
  onClose: () => void;
}) {
  const {path, loading} = usePagePath(item, storageOff);

  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);

  const setZoom = useCallback(
    (z: boolean) => onZoomChange(z),
    [onZoomChange],
  );
  const isVideo = item.kind === 'video';

  // #483: NO springs/timings anywhere — instant value sets only, so closing and
  // zooming can't glitch. Pinch-zoom is a direct 1:1 transform (not an animation).
  const pinch = Gesture.Pinch()
    .enabled(!isVideo)
    .onStart(() => {
      runOnJS(onHideControls)();
    })
    .onUpdate(e => {
      scale.value = clampScale(savedScale.value * e.scale);
    })
    .onEnd(() => {
      savedScale.value = scale.value;
      runOnJS(setZoom)(!isAtFit(scale.value));
    });

  // Swipe-DOWN to dismiss (only at fit). No visual drag or backdrop fade — the
  // close is instant on release (#483: remove all transitions).
  const pan = Gesture.Pan().onEnd(e => {
    if (
      isAtFit(scale.value) &&
      shouldDismiss(e.translationY, e.velocityY, scale.value)
    ) {
      runOnJS(onClose)();
    }
  });
  // Claim ONLY downward drags (dismiss); yield horizontal drags to the FlatList
  // pager. failOffsetX bails the pan the instant the finger moves sideways.
  pan.activeOffsetY(12).failOffsetX([-18, 18]);

  const singleTap = Gesture.Tap()
    .maxDuration(250)
    .maxDistance(10) // a moving finger is a swipe, not a tap → let the pan dismiss
    .onEnd(() => {
      runOnJS(onToggleControls)();
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .maxDistance(10)
    .enabled(!isVideo)
    .onEnd(() => {
      const target = doubleTapScale(scale.value);
      scale.value = target;
      savedScale.value = target;
      runOnJS(setZoom)(!isAtFit(target));
    });

  const composed = Gesture.Simultaneous(
    pinch,
    pan,
    Gesture.Exclusive(doubleTap, singleTap),
  );

  const mediaStyle = useAnimatedStyle(() => ({
    transform: [{scale: scale.value}],
  }));

  return (
    <View style={styles.page}>
      <View style={[StyleSheet.absoluteFill, styles.black]} />
      <GestureDetector gesture={composed}>
        <Animated.View style={[styles.pageInner, mediaStyle]}>
          {path == null ? (
            <Text style={styles.loading}>{loading ? 'loading…' : 'unavailable'}</Text>
          ) : isVideo ? (
            // #483: the native video view eats touches, so tap can't reveal the
            // controls and the actions are unreachable. pointerEvents="none" lets
            // gestures pass through to the detector; the video still plays.
            <View style={styles.media} pointerEvents="none">
              <MediaVideo
                path={path}
                muted={false}
                paused={!active}
                style={styles.media}
              />
            </View>
          ) : (
            <Image
              source={{uri: `file://${path}`}}
              resizeMode="contain"
              style={styles.media}
            />
          )}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

export function MediaViewer({
  items,
  index,
  onClose,
  authorFor,
  captionFor,
  onForward,
  onSave,
  onShare,
  storageOff = false,
}: MediaViewerProps) {
  const [active, setActive] = useState(index);
  const [controls, setControls] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const listRef = useRef<FlatList<MediaItem>>(null);
  // Keep the bar's actions and the close circle clear of the system status/nav
  // bars (we hide the status bar but the nav bar/gesture area still occupies space).
  const insets = useSafeAreaInsets();

  // Hardware back closes the viewer (an overlay, not a Modal — so we intercept it).
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [onClose]);

  const activeItem = items[active];
  const author = activeItem ? authorFor(activeItem) : null;
  const caption = activeItem && captionFor ? captionFor(activeItem) : null;
  const path = useActivePath(activeItem, storageOff);

  const onMomentumEnd = useCallback(
    (e: {nativeEvent: {contentOffset: {x: number}}}) => {
      const i = Math.round(e.nativeEvent.contentOffset.x / SCREEN_W);
      if (i !== active) {
        setActive(i);
        setZoomed(false);
      }
    },
    [active],
  );

  return (
    // #479: an in-tree absolute overlay, NOT a Modal. A Modal renders in its own
    // native root; tearing it down (with reanimated + a native video inside)
    // hung the UI thread on dismiss (ANR). An in-tree overlay unmounts cleanly,
    // and gestures already work here via the app-root GestureHandlerRootView.
    // ChatScreen hides its header while this is open so it's truly full-screen.
    <View style={styles.root} collapsable={false}>
      {/* #483: do NOT hide the status bar — restoring it on dismiss left a blank
          bar above the header on GrapheneOS. Keep it visible over the black viewer. */}
      <FlatList
          ref={listRef}
          data={items}
          style={styles.list}
          keyExtractor={it => String(it.msgPk)}
          horizontal
          pagingEnabled
          scrollEnabled={!zoomed}
          showsHorizontalScrollIndicator={false}
          initialScrollIndex={index}
          getItemLayout={(_d, i) => ({
            length: SCREEN_W,
            offset: SCREEN_W * i,
            index: i,
          })}
          onMomentumScrollEnd={onMomentumEnd}
          renderItem={({item, index: i}) => (
            <MediaPage
              item={item}
              active={i === active}
              storageOff={storageOff}
              onToggleControls={() => setControls(c => !c)}
              onHideControls={() => setControls(false)}
              onZoomChange={setZoomed}
              onClose={onClose}
            />
          )}
        />

        {/* #483: the close circle appears only in mode 2 (after the second tap),
            so the first tap gives a clean full-screen with no controls. */}
        {controls && (
          <Pressable
            style={[styles.closeCircle, {top: Math.max(16, insets.top) + 12}]}
            onPress={onClose}
            hitSlop={16}
            testID="media-viewer-close">
            <XIcon size={22} color="#fff" />
          </Pressable>
        )}

        {/* mode-2 bottom bar */}
        {controls && (
          <View
            style={[styles.bar, {paddingBottom: Math.max(20, insets.bottom + 14)}]}
            pointerEvents="box-none">
            {author != null && (
              <View style={styles.authorRow}>
                <HexAvatar seed={author.address} kind={author.kind} size={18} />
                <Text style={styles.authorText} numberOfLines={1}>
                  {author.label != null ? (
                    <>
                      <Text style={styles.authorLabel}>{author.label}</Text>
                      <Text style={styles.authorHex}> {author.hex}</Text>
                    </>
                  ) : (
                    <Text style={styles.authorLabel}>{author.hex}</Text>
                  )}
                </Text>
              </View>
            )}
            {caption != null && caption !== '' && (
              <Text style={styles.caption} numberOfLines={1}>
                {caption}
              </Text>
            )}
            {/* #483: download / share / forward only — close is the top-right
                circle (+ swipe-down / back). Bigger tap targets (#483). */}
            <View style={styles.actions}>
              <Pressable
                style={styles.action}
                onPress={() => path && activeItem && onSave(activeItem, path)}
                hitSlop={18}
                testID="media-action-download">
                <DownloadIcon size={26} color="#fff" />
              </Pressable>
              <Pressable
                style={styles.action}
                onPress={() => path && activeItem && onShare(activeItem, path)}
                hitSlop={18}
                testID="media-action-share">
                <ShareIcon size={26} color="#fff" />
              </Pressable>
              <Pressable
                style={styles.action}
                onPress={() => activeItem && onForward(activeItem.content)}
                hitSlop={18}
                testID="media-action-forward">
                <ForwardIcon size={26} color="#fff" />
              </Pressable>
            </View>
          </View>
        )}
    </View>
  );
}

/** Resolve the active item's path for the action bar (save/share need it). */
function useActivePath(
  item: MediaItem | undefined,
  storageOff: boolean,
): string | null {
  const inline = item != null && isImageContent(item.content);
  // #344: null under storage-off — save/share stay inert, and nothing is fetched.
  const ref = useMemo(
    () => (item == null ? null : viewerMediaRef(item.content, storageOff)),
    [item, storageOff],
  );
  const blob = useMediaBlob(ref);
  if (item == null) return null;
  if (inline) return parseImageLocal(item.content)?.path ?? null;
  if (ref == null) return null;
  return blob.status === 'ready' ? blob.path : null;
}

const styles = StyleSheet.create({
  // Full-screen in-tree overlay (sits above the chat via zIndex/elevation).
  root: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 1000,
    elevation: 1000,
    backgroundColor: 'transparent',
  },
  list: {flex: 1},
  page: {width: SCREEN_W, height: SCREEN_H},
  pageInner: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  black: {backgroundColor: '#000'},
  media: {width: SCREEN_W, height: SCREEN_H},
  loading: {color: 'rgba(255,255,255,0.6)', fontSize: 15},
  closeCircle: {
    position: 'absolute',
    top: 44,
    right: 16,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: 12,
    paddingBottom: 28,
    paddingHorizontal: 16,
    backgroundColor: 'rgba(0,0,0,0.6)',
    gap: 10,
  },
  authorRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  authorText: {flex: 1, fontSize: 13},
  authorLabel: {color: '#fff'},
  authorHex: {color: 'rgba(255,255,255,0.6)'},
  caption: {color: '#fff', fontSize: 14, textAlign: 'center'},
  actions: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingTop: 4,
  },
  action: {padding: 14},
});
