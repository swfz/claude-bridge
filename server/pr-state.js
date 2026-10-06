import * as childProcess from 'child_process';
import { promisify } from 'util';

// ホームの「やり残し判定」で、セッションが作った PR がマージされたかを gh で確かめる。
// gh pr view は 1 回 0.4 秒ほどかかり、ホームの初回表示では数十件が一斉に来るので、
// 結果をプロセス内にキャッシュし、同時実行の本数を絞る。
// gh のアカウントが合わず読めない PR などは 'unknown' になる（判定側は完了に倒す）。

const PR_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;
const STATE_MAP = { MERGED: 'merged', OPEN: 'open', CLOSED: 'closed' };
// merged / closed はもう変わらないので取り直さない
const TERMINAL = new Set(['merged', 'closed']);
const CACHE_MAX = 1000;

// 既定の取得。execFile（シェル非経由）+ timeout で実行し、stdout の JSON を状態名に直す。
// E2E など gh を走らせたくない環境では CLAUDE_BRIDGE_DISABLE_GH=1 で常に 'unknown' にする
async function defaultRun(url) {
  if (process.env.CLAUDE_BRIDGE_DISABLE_GH === '1') return 'unknown';
  // execFile は呼び出し時に引く。名前付き import にすると、child_process を exec だけで
  // mock.module している他のテスト（tmux 系）が、このモジュールを間接 import した時点で落ちる
  const execFileAsync = promisify(childProcess.execFile);
  const { stdout } = await execFileAsync('gh', ['pr', 'view', url, '--json', 'state,mergedAt'], { timeout: 10000 });
  return parsePrState(stdout);
}

// gh pr view --json state,mergedAt の出力 → 'merged' | 'open' | 'closed' | 'unknown'
export function parsePrState(stdout) {
  try {
    return STATE_MAP[JSON.parse(stdout)?.state] || 'unknown';
  } catch {
    return 'unknown';
  }
}

export function isPrUrl(url) {
  return typeof url === 'string' && PR_URL_RE.test(url);
}

// run(url) は 'merged' / 'open' / 'closed' を返す（それ以外の値・例外は 'unknown' 扱い）
export function createPrStateReader({ run = defaultRun, ttlMs = 5 * 60 * 1000, concurrency = 4, now = Date.now } = {}) {
  // url -> { state, at, promise }。state は取得中は undefined
  const cache = new Map();
  let active = 0;
  const waiting = [];

  // 同時実行を concurrency 本までに絞る
  const acquire = () =>
    new Promise((resolve) => {
      if (active < concurrency) {
        active++;
        resolve();
      } else {
        waiting.push(resolve);
      }
    });
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };

  const fetchState = async (url) => {
    await acquire();
    try {
      const state = await run(url);
      return ['merged', 'open', 'closed'].includes(state) ? state : 'unknown';
    } catch {
      // gh 未インストール・未ログイン・権限なし・タイムアウト
      return 'unknown';
    } finally {
      release();
    }
  };

  const get = (url) => {
    if (!isPrUrl(url)) return Promise.resolve('unknown');
    const hit = cache.get(url);
    if (hit) {
      if (hit.state === undefined) return hit.promise;
      if (TERMINAL.has(hit.state) || now() - hit.at < ttlMs) return hit.promise;
    }
    if (cache.size >= CACHE_MAX) cache.clear();
    const entry = { state: undefined, at: 0, promise: null };
    entry.promise = fetchState(url).then((state) => {
      entry.state = state;
      entry.at = now();
      return state;
    });
    cache.set(url, entry);
    return entry.promise;
  };

  return { get, clear: () => cache.clear() };
}

const defaultReader = createPrStateReader();

export function getPrState(url) {
  return defaultReader.get(url);
}

// テスト用
export function clearPrStateCache() {
  defaultReader.clear();
}
