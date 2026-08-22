import {
  SiJavascript,
  SiTypescript,
  SiReact,
  SiHtml5,
  SiCss,
  SiPython,
  SiRuby,
  SiGo,
  SiGnubash,
  SiJson,
  SiMarkdown,
  SiSvg,
  SiYaml,
} from 'react-icons/si';
import { VscFile, VscFileMedia, VscFolder, VscFolderOpened, VscRootFolderOpened } from 'react-icons/vsc';
import { FaRegFilePdf } from 'react-icons/fa6';

// フォルダはニュートラルな寒色グレーで統一し、ファイルの色付きロゴを引き立てる
const FOLDER_COLOR = '#8aa0c0';

// 拡張子 -> アイコンとブランドカラー。エディタ風に言語ロゴを色付きで表示する。
// 言語/技術ロゴが無い種別 (画像・PDF・その他) は Codicon でモノトーンにする。
const ICON_BY_EXT = {
  '.js': { Icon: SiJavascript, color: '#f7df1e' },
  '.jsx': { Icon: SiReact, color: '#61dafb' },
  '.ts': { Icon: SiTypescript, color: '#3178c6' },
  '.tsx': { Icon: SiReact, color: '#61dafb' },
  '.html': { Icon: SiHtml5, color: '#e34f26' },
  '.htm': { Icon: SiHtml5, color: '#e34f26' },
  '.css': { Icon: SiCss, color: '#663399' },
  '.py': { Icon: SiPython, color: '#3776ab' },
  '.rb': { Icon: SiRuby, color: '#cc342d' },
  '.go': { Icon: SiGo, color: '#00add8' },
  '.sh': { Icon: SiGnubash, color: '#4eaa25' },
  '.json': { Icon: SiJson, color: '#cbcb41' },
  '.md': { Icon: SiMarkdown, color: '#dddddd' },
  '.yaml': { Icon: SiYaml, color: '#cb171e' },
  '.yml': { Icon: SiYaml, color: '#cb171e' },
  '.svg': { Icon: SiSvg, color: '#ffb13b' },
  '.png': { Icon: VscFileMedia, color: '#9aa0c0' },
  '.jpg': { Icon: VscFileMedia, color: '#9aa0c0' },
  '.jpeg': { Icon: VscFileMedia, color: '#9aa0c0' },
  '.gif': { Icon: VscFileMedia, color: '#9aa0c0' },
  '.webp': { Icon: VscFileMedia, color: '#9aa0c0' },
  '.pdf': { Icon: FaRegFilePdf, color: '#e0524b' },
};

const DEFAULT_ICON = { Icon: VscFile, color: '#8a8a9a' };

export function FileIcon({ ext, size = 14 }) {
  const { Icon, color } = ICON_BY_EXT[ext] || DEFAULT_ICON;
  return <Icon color={color} size={size} aria-hidden="true" />;
}

export function FolderIcon({ open = false, root = false, size = 14 }) {
  const Icon = root ? VscRootFolderOpened : open ? VscFolderOpened : VscFolder;
  return <Icon color={FOLDER_COLOR} size={size} aria-hidden="true" />;
}
