import { createContext } from 'react';

// 返答の `path:行` のピルから差分ドロワーのその行へ飛ぶ口（App の jumpToDiffLine）。
// ChatMessage は memo してあり props を増やすと崩れやすいので、ハンドラは context で渡す。値は App で安定させる
export const DiffJumpContext = createContext(null);
