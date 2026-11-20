import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { TbChevronDown, TbChevronRight, TbPlus, TbRefresh, TbX } from 'react-icons/tb';
import {
  DIFF_SCOPES,
  absolutePath,
  diffStatusLabel,
  formatDiffComment,
  isCommentableRow,
  lineLabel,
  locateComment,
  parseDiffRows,
  quoteRows,
  rangeFromRows,
  rowAnchor,
  shouldCollapseFile,
  splitPath,
  summarizeDiff,
} from '../utils/diffView.js';
import { diffCommentKey, diffCommentStore, isUnsent } from '../utils/diffComments.js';
import { isConfirmShortcut, isDeleteItemShortcut, isSubmitAllShortcut } from '../utils/keys.js';
import './DiffDrawer.css';

const EMPTY = Object.freeze([]);

// 入力欄の /diff で開く差分ドロワー。Claude Code の /diff は TUI 内のモーダルで
// ブラウザからは見えないので、ブリッジがサーバーで git diff を取って出す。
// data: { loading, files, truncated, error, root, outside } | null
//
// 行番号（ガター）のクリックでその行へ指摘を書き、Shift+クリックで同じ hunk・同じ側の範囲にする。
// 書きかけは utils/diffComments.js の store（モジュールレベル）に置き、閉じても取り直しても残す。
// focusTarget（{path, side, line, nonce}）を渡すと、差分が届いた後にその行へスクロールする（Claude から開く口）。
export default function DiffDrawer({
  sessionKey,
  scope,
  data,
  focusTarget,
  onChangeScope,
  onRefresh,
  onOpenPreview,
  onSubmitComments,
  onClose,
}) {
  const entry = useSyncExternalStore(diffCommentStore.subscribe, () => diffCommentStore.snapshot(sessionKey));
  const [activeKey, setActiveKey] = useState(null);
  // スクロールして見せる行（{path, side, line, nonce}）。DiffFile が見せ終わったら null に戻す
  const [jump, setJump] = useState(null);
  const bodyRef = useRef(null);
  // handleGutter を安定させる（行は memo してあり、ハンドラが変わると全行を描き直すため）
  const activeKeyRef = useRef(activeKey);
  activeKeyRef.current = activeKey;

  const files = useMemo(() => data?.files || EMPTY, [data]);
  const ready = !!data && !data.loading;
  const rowsByPath = useMemo(() => new Map(files.map((f) => [f.path, parseDiffRows(f.patch)])), [files]);
  const summary = summarizeDiff(files);
  const unsent = entry.list.filter(isUnsent);
  const sending = entry.list.some((c) => c.sendingId);

  useEffect(() => {
    if (focusTarget) setJump(focusTarget);
  }, [focusTarget]);

  // 開いたら本文にフォーカスを置く（送信欄に残ったままだと Ctrl+D / U が効かず、打鍵が裏の送信欄に入る）
  useEffect(() => {
    bodyRef.current?.focus({ preventScroll: true });
  }, []);

  // 開いている指摘欄へフォーカスを移す（既にある指摘の行を押したときは欄がマウント済みで autoFocus が効かない）
  useEffect(() => {
    if (!activeKey) return;
    const el = bodyRef.current?.querySelector(`[data-comment-key="${CSS.escape(activeKey)}"] textarea`);
    if (el && document.activeElement !== el) el.focus();
  }, [activeKey]);

  const handleSubmitAll = useCallback(() => {
    // 読み込み中は今の差分が分からない（対象行の有無を確かめられない）ので送らない
    if (!ready) return;
    const list = diffCommentStore.snapshot(sessionKey).list.filter(isUnsent);
    if (list.length === 0 || !onSubmitComments) return;
    const items = list.map((c) => {
      const rows = rowsByPath.get(c.path);
      // 「取り直す前の行番号」と添えるのは、そのファイルの行が今の差分にあって、同じ本文の行が引けないときだけ。
      // ファイルごと今の差分に無い（範囲外・コミット済み）・中身を出していない（バイナリ・大きすぎる）ものは
      // 確かめようがないので、書いたときの行番号のまま注記を付けない
      const stale = !!rows && rows.length > 0 && !locateComment(rows, c);
      return { text: formatDiffComment({ ...c, stale }) };
    });
    onSubmitComments(
      items,
      list.map((c) => c.key),
    );
    setActiveKey(null);
    bodyRef.current?.focus({ preventScroll: true });
  }, [ready, sessionKey, rowsByPath, onSubmitComments]);
  const submitRef = useRef(handleSubmitAll);
  submitRef.current = handleSubmitAll;

  // Esc で閉じる。一括送信はフォーカス位置を問わず効かせる（指摘欄で処理済みのものは二重に送らない）
  useEffect(() => {
    const handleKey = (e) => {
      if (isSubmitAllShortcut(e)) {
        if (e.defaultPrevented) return;
        e.preventDefault();
        submitRef.current();
        return;
      }
      if (e.key === 'Escape' && !e.defaultPrevented) onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const handleGutter = useCallback(
    (path, idx, shift) => {
      const rows = rowsByPath.get(path);
      const file = files.find((f) => f.path === path);
      if (!rows || !file) return;
      const clicked = rowAnchor(rows[idx]);
      if (!clicked) return;
      const activeKey = activeKeyRef.current;
      const current = activeKey ? diffCommentStore.snapshot(sessionKey).list.find((c) => c.key === activeKey) : null;
      // Shift+クリックは「今書いている指摘」の先頭行から押した行までに範囲を変える。
      // 同じファイル・同じ hunk・同じ側のときだけで、それ以外（指摘欄が開いていない・側や hunk が違う・
      // 対象行が見つからない指摘）は普通のクリックと同じく押した 1 行の指摘にする
      let range = null;
      let extend = false;
      if (shift && current && current.path === path && !current.sendingId && current.side === clicked.side) {
        const loc = locateComment(rows, current);
        if (loc && rows[loc.startIdx].hunk === rows[idx].hunk) {
          range = rangeFromRows(rows, loc.startIdx, idx);
          extend = true;
        }
      }
      if (!range) range = rangeFromRows(rows, null, idx);
      const key = diffCommentKey({ sessionKey, path, ...range });
      const existing = diffCommentStore.snapshot(sessionKey).list.find((c) => c.key === key);
      if (existing) {
        // 同じ行（範囲）の指摘が既にあればそれを開く
        if (current && current.key !== key && !current.text.trim()) diffCommentStore.remove(sessionKey, current.key);
        setActiveKey(key);
        return;
      }
      const comment = {
        key,
        path,
        oldPath: file.oldPath || null,
        ...range,
        quote: quoteRows(rows, range),
        text: '',
        sendingId: null,
      };
      if (extend) {
        // 書いている指摘の範囲を広げる（本文は引き継ぐ）
        diffCommentStore.replace(sessionKey, current.key, { ...comment, text: current.text });
      } else {
        if (current && !current.text.trim()) diffCommentStore.remove(sessionKey, current.key);
        diffCommentStore.upsert(sessionKey, comment);
      }
      setActiveKey(key);
    },
    [rowsByPath, files, sessionKey],
  );

  const handleChangeText = useCallback((key, text) => diffCommentStore.update(sessionKey, key, { text }), [sessionKey]);
  const focusBody = useCallback(() => bodyRef.current?.focus({ preventScroll: true }), []);
  // 確定（Ctrl+Enter / Esc）: 欄を閉じて本文へ。空なら捨てる
  const handleConfirm = useCallback(
    (key) => {
      const c = diffCommentStore.snapshot(sessionKey).list.find((x) => x.key === key);
      if (c && !c.text.trim()) diffCommentStore.remove(sessionKey, key);
      setActiveKey(null);
      focusBody();
    },
    [sessionKey, focusBody],
  );
  const handleDelete = useCallback(
    (key) => {
      diffCommentStore.remove(sessionKey, key);
      setActiveKey((cur) => (cur === key ? null : cur));
      focusBody();
    },
    [sessionKey, focusBody],
  );
  const commentHandlers = useMemo(
    () => ({
      onChange: handleChangeText,
      onConfirm: handleConfirm,
      onDelete: handleDelete,
      onSubmitAll: handleSubmitAll,
      onFocus: setActiveKey,
    }),
    [handleChangeText, handleConfirm, handleDelete, handleSubmitAll],
  );

  // 未送信の指摘を順に見せる（ヘッダの件数のクリック）
  const jumpSeq = useRef(0);
  const handleJumpNext = useCallback(() => {
    if (unsent.length === 0) return;
    const c = unsent[jumpSeq.current++ % unsent.length];
    setJump({ path: c.path, side: c.side, line: c.end, nonce: Date.now() });
  }, [unsent]);
  const handleJumpDone = useCallback(() => setJump(null), []);

  const presentPaths = useMemo(() => new Set(files.map((f) => f.path)), [files]);
  // 今の差分に無いファイルへの指摘（範囲を「このセッション」に切り替えた・コミット済みになった等）
  const absent = ready ? entry.list.filter((c) => !presentPaths.has(c.path)) : EMPTY;

  return (
    <div className="diff-drawer-overlay" onClick={onClose}>
      <div className="diff-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="diff-drawer-header">
          <div className="diff-drawer-title-area">
            <span className="diff-drawer-title">未コミットの差分</span>
            <div className="diff-drawer-meta">
              {!data?.loading && !data?.error && (
                <span className="diff-drawer-summary">
                  {summary.changed} ファイル <span className="diff-add">+{summary.additions}</span>{' '}
                  <span className="diff-del">−{summary.deletions}</span>
                </span>
              )}
              {data?.root && (
                <span className="diff-drawer-root" title={data.root}>
                  {data.root.split('/').pop()}
                </span>
              )}
              {entry.status && (
                <span className={`diff-drawer-status${entry.status.ok ? '' : ' error'}`} role="status">
                  {entry.status.ok ? `${entry.status.count}件送信しました` : '送信に失敗しました（指摘は残しています）'}
                </span>
              )}
            </div>
          </div>
          {/* 未送信の指摘。0 件でも場所を取っておき、出し入れで範囲トグル・更新ボタンを動かさない */}
          <div className={`diff-drawer-review${unsent.length === 0 ? ' empty' : ''}`}>
            <button
              className="diff-comment-count"
              onClick={handleJumpNext}
              title="未送信の指摘を順に表示"
              aria-label={`未送信の指摘 ${unsent.length} 件を順に表示`}
              tabIndex={unsent.length === 0 ? -1 : 0}
            >
              <span className="diff-comment-count-dot" aria-hidden="true" />
              {unsent.length}
            </button>
            <button
              className="btn btn-primary diff-submit"
              onClick={handleSubmitAll}
              disabled={unsent.length === 0 || sending || !ready}
              title="差分への指摘を一括送信（Ctrl+Shift+Enter）"
              tabIndex={unsent.length === 0 ? -1 : 0}
            >
              {unsent.length}件送信
            </button>
          </div>
          <div className="diff-drawer-scope" role="group" aria-label="差分の範囲">
            {DIFF_SCOPES.map((s) => (
              <button
                key={s.value}
                className={`diff-scope-btn${scope === s.value ? ' active' : ''}`}
                onClick={() => onChangeScope(s.value)}
                aria-pressed={scope === s.value}
              >
                {s.label}
              </button>
            ))}
          </div>
          <button className="diff-drawer-icon" onClick={onRefresh} title="取り直す" aria-label="取り直す">
            <TbRefresh aria-hidden="true" />
          </button>
          <button className="diff-drawer-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </div>

        <div className="diff-drawer-body" ref={bodyRef} tabIndex={-1}>
          {data?.loading && <div className="diff-drawer-empty">読み込み中...</div>}
          {data?.error && <div className="diff-drawer-error">{data.error}</div>}
          {absent.length > 0 && (
            <div className="diff-orphans" data-diff-orphans="">
              <div className="diff-drawer-note">今の差分に無いファイルへの指摘</div>
              {absent.map((c) => (
                <CommentBox key={c.key} comment={c} stale showPath active={c.key === activeKey} {...commentHandlers} />
              ))}
            </div>
          )}
          {ready && !data.error && files.length === 0 && (
            <div className="diff-drawer-empty">
              {scope === 'session' ? 'このセッションで編集したファイルはありません' : '未コミットの変更はありません'}
            </div>
          )}
          {ready && data.outside > 0 && (
            <div className="diff-drawer-note">リポジトリ外のファイル {data.outside} 件は対象外です</div>
          )}
          {ready &&
            files.map((file) => (
              <DiffFile
                key={`${scope}:${file.path}`}
                file={file}
                rows={rowsByPath.get(file.path)}
                root={data.root}
                comments={entry.byPath[file.path] || EMPTY}
                activeKey={activeKey && entry.byPath[file.path]?.some((c) => c.key === activeKey) ? activeKey : null}
                jump={jump?.path === file.path ? jump : null}
                onJumpDone={handleJumpDone}
                onGutter={handleGutter}
                onOpenPreview={onOpenPreview}
                handlers={commentHandlers}
              />
            ))}
          {data?.truncated && (
            <div className="diff-drawer-note">差分が大きいため、一部のファイルは中身を省略しています</div>
          )}
        </div>
      </div>
    </div>
  );
}

const DiffFile = memo(function DiffFile({
  file,
  rows,
  root,
  comments,
  activeKey,
  jump,
  onJumpDone,
  onGutter,
  onOpenPreview,
  handlers,
}) {
  const [open, setOpen] = useState(() => !shouldCollapseFile(file) || comments.length > 0);
  const fileRef = useRef(null);
  const label = diffStatusLabel(file.status);
  const { dir, name } = splitPath(file.path);
  const noChange = file.status === 'committed' || file.status === 'missing';
  const previewPath = file.status === 'deleted' || file.status === 'missing' ? null : absolutePath(root, file.path);

  // 指摘ごとに今の行の位置を引く。引けないものは見出しの下に「対象行が見つからない」として残す
  const { boxesAfter, marked, target, stale } = useMemo(() => {
    const boxesAfter = new Map();
    const marked = new Set();
    const target = new Set();
    const stale = [];
    for (const c of comments) {
      const loc = rows ? locateComment(rows, c) : null;
      if (!loc) {
        stale.push(c);
        continue;
      }
      if (!boxesAfter.has(loc.endIdx)) boxesAfter.set(loc.endIdx, []);
      boxesAfter.get(loc.endIdx).push(c);
      for (let i = loc.startIdx; i <= loc.endIdx; i++) {
        // 強調するのは指摘と同じ側の行だけ（locateComment が連続を確かめているので念のため）
        if (rowAnchor(rows[i])?.side !== c.side) continue;
        if (c.key === activeKey) target.add(i);
        else if (isUnsent(c)) marked.add(i);
      }
    }
    return { boxesAfter, marked, target, stale };
  }, [comments, rows, activeKey]);

  // 外から指定された行（focusTarget / 未送信の指摘を順に見る）へスクロールする。畳んでいれば開く
  useEffect(() => {
    if (!jump) return;
    if (!open && !noChange) {
      setOpen(true);
      return;
    }
    const el =
      fileRef.current?.querySelector(`[data-anchor="${jump.side}:${jump.line}"]`) ||
      fileRef.current?.querySelector('.diff-comment.stale') ||
      null;
    if (el) {
      el.scrollIntoView({ block: 'center' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1500);
    }
    onJumpDone();
  }, [jump, open, noChange, onJumpDone]);

  const unsentCount = comments.filter(isUnsent).length;

  return (
    <div className={`diff-file${noChange ? ' no-change' : ''}`} ref={fileRef}>
      <div className="diff-file-header">
        <button
          className="diff-file-toggle"
          onClick={() => setOpen((v) => !v)}
          disabled={noChange}
          aria-expanded={open}
          aria-label={open ? '畳む' : '開く'}
        >
          {open ? <TbChevronDown aria-hidden="true" /> : <TbChevronRight aria-hidden="true" />}
        </button>
        <button
          className="diff-file-path"
          onClick={() => previewPath && onOpenPreview(previewPath)}
          disabled={!previewPath}
          title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        >
          <span className="diff-file-dir">{dir}</span>
          <span className="diff-file-name">{name}</span>
        </button>
        {unsentCount > 0 && (
          <span className="diff-file-comments" title={`未送信の指摘 ${unsentCount} 件`}>
            指摘 {unsentCount}
          </span>
        )}
        {label && <span className="diff-file-label">{label}</span>}
        {!noChange && (
          <span className="diff-file-stat">
            <span className="diff-add">+{file.additions}</span> <span className="diff-del">−{file.deletions}</span>
          </span>
        )}
      </div>
      {stale.length > 0 && (
        <div className="diff-file-stale">
          {stale.map((c) => (
            <CommentBox key={c.key} comment={c} stale active={c.key === activeKey} {...handlers} />
          ))}
        </div>
      )}
      {open && !noChange && (
        <div className="diff-file-body">
          {file.symlink ? (
            <div className="diff-file-note">シンボリックリンク（リンク先の中身は表示しません）</div>
          ) : file.sensitive ? (
            <div className="diff-file-note">資格情報の置き場のため中身は表示しません</div>
          ) : file.binary ? (
            <div className="diff-file-note">バイナリファイル</div>
          ) : file.tooLarge ? (
            <div className="diff-file-note">差分が大きいため省略しました</div>
          ) : !rows || rows.length === 0 ? (
            <div className="diff-file-note">中身の差分はありません（モードや名前の変更のみ）</div>
          ) : (
            <div className="diff-lines">
              <div className="diff-lines-inner">
                {rows.map((row, i) => (
                  <DiffRowWithComments
                    key={i}
                    row={row}
                    idx={i}
                    path={file.path}
                    marked={marked.has(i)}
                    target={target.has(i)}
                    boxes={boxesAfter.get(i)}
                    activeKey={activeKey}
                    onGutter={onGutter}
                    handlers={handlers}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

function DiffRowWithComments({ boxes, activeKey, handlers, ...rowProps }) {
  return (
    <>
      <DiffRow {...rowProps} />
      {boxes?.map((c) => (
        <CommentBox key={c.key} comment={c} active={c.key === activeKey} {...handlers} />
      ))}
    </>
  );
}

const DiffRow = memo(function DiffRow({ row, idx, path, marked, target, onGutter }) {
  const anchor = rowAnchor(row);
  const commentable = isCommentableRow(row);
  return (
    <div
      className={`diff-line ${row.kind}${marked ? ' has-comment' : ''}${target ? ' target' : ''}`}
      data-anchor={anchor ? `${anchor.side}:${anchor.line}` : undefined}
    >
      {commentable ? (
        <button
          type="button"
          className="diff-gutter"
          tabIndex={-1}
          onClick={(e) => onGutter(path, idx, e.shiftKey)}
          title="この行に指摘を書く（Shift+クリックで範囲）"
          aria-label={`${lineLabel({ ...anchor, start: anchor.line, end: anchor.line })} に指摘を書く`}
        >
          <span className="diff-ln">{row.oldLine ?? ''}</span>
          <span className="diff-ln">{row.newLine ?? ''}</span>
          <span className="diff-gutter-mark" aria-hidden="true" />
          <span className="diff-gutter-plus" aria-hidden="true">
            <TbPlus />
          </span>
        </button>
      ) : (
        <span className="diff-gutter" aria-hidden="true" />
      )}
      <span className="diff-line-text">{row.text || ' '}</span>
    </div>
  );
});

function CommentBox({ comment, active, stale, showPath, onChange, onConfirm, onDelete, onSubmitAll, onFocus }) {
  const sending = !!comment.sendingId;
  const where = `${showPath ? `${comment.side === 'old' && comment.oldPath ? comment.oldPath : comment.path} ` : ''}${
    comment.side === 'old' ? '削除行 ' : ''
  }${lineLabel(comment)}`;
  return (
    <div
      className={`diff-comment${active ? ' active' : ''}${stale ? ' stale' : ''}${sending ? ' sending' : ''}`}
      data-comment-key={comment.key}
    >
      <div className="diff-comment-head">
        <span className="diff-comment-where">{where}</span>
        {stale && <span className="diff-comment-stale">対象行が見つからない</span>}
        {stale && comment.quote && <span className="diff-comment-quote">{comment.quote}</span>}
        {sending && <span className="diff-comment-sending">送信中…</span>}
        <button
          className="diff-comment-remove"
          onClick={() => onDelete(comment.key)}
          title="この指摘を削除（Ctrl+Shift+⌫）"
          aria-label="この指摘を削除"
        >
          <TbX aria-hidden="true" />
        </button>
      </div>
      <textarea
        className="diff-comment-input"
        value={comment.text}
        readOnly={sending}
        rows={2}
        autoFocus={active}
        placeholder="指摘を入力...（Ctrl+Enterで確定 / Ctrl+Shift+Enterで一括送信）"
        onFocus={() => onFocus(comment.key)}
        onChange={(e) => onChange(comment.key, e.target.value)}
        onKeyDown={(e) => {
          // Esc は確定と同じ扱いにし、document の「ドロワーを閉じる」には届かせない
          if (isDeleteItemShortcut(e)) {
            e.preventDefault();
            onDelete(comment.key);
          } else if (isSubmitAllShortcut(e)) {
            e.preventDefault();
            onSubmitAll();
          } else if (isConfirmShortcut(e)) {
            e.preventDefault();
            onConfirm(comment.key);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onConfirm(comment.key);
          }
        }}
      />
    </div>
  );
}
