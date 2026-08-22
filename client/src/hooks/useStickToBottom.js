import { useCallback, useEffect, useRef, useState } from 'react';
import { isScrolledToBottom } from '../utils/scroll.js';

// 最下部付近にいる間だけ新着に追従するスクロール管理。
// 上にスクロールして過去を読んでいる間は勝手に動かさず、新着が来たことだけ hasNew で知らせる。
// content が変わるたびに判定し、resetKey（タブ・エージェントの切替）が変わったら追従状態に戻す。
export function useStickToBottom(content, resetKey) {
  const scrollRef = useRef(null);
  const atBottomRef = useRef(true);
  const [hasNew, setHasNew] = useState(false);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setHasNew(false);
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = isScrolledToBottom(el);
    if (atBottomRef.current) setHasNew(false);
  }, []);

  // 表示対象が入れ替わったら追従状態に戻す（このリセットを下の追従 effect より先に行う）
  useEffect(() => {
    atBottomRef.current = true;
    setHasNew(false);
  }, [resetKey]);

  useEffect(() => {
    if (!scrollRef.current) return;
    if (atBottomRef.current) {
      scrollToBottom();
    } else {
      setHasNew(true);
    }
  }, [content, resetKey, scrollToBottom]);

  return { scrollRef, onScroll, hasNew, scrollToBottom };
}
