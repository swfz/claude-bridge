import { useState, useCallback, useRef } from "react";

function cleanPtyOutput(str) {
  return str
    // カーソル前進 (ESC[NC) をスペースに変換
    .replace(/\x1b\[\d*C/g, " ")
    // OSC シーケンス (ESC]...BEL or ESC]...ST)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // CSI シーケンス — <, >, ?, =, ! 等の中間バイトも含めて除去
    .replace(/\x1b\[[0-9;:<=>?]*[- /]*[A-Za-z@`{}~]/g, "")
    // DCS/PM/APC シーケンス
    .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, "")
    // 2文字エスケープ (ESC + 1文字)
    .replace(/\x1b[^[\]PX^_]/g, "")
    // 残ったベアESC
    .replace(/\x1b/g, "")
    // 改行正規化
    .replace(/\r\r\n/g, "\n")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

// 出力がプロンプトで終わっているか判定
function endsWithPrompt(buf) {
  // Claude Code のプロンプト: ❯ が行末付近にある
  return /\n\s*❯\s*$/.test(buf) || /^\s*❯\s*$/.test(buf);
}

const FLUSH_DELAY = 2000; // 2秒出力が止まったらフラッシュ

export function useChatParser() {
  const [messages, setMessages] = useState([]);
  const bufferRef = useRef("");
  const messageIdCounter = useRef(0);
  const waitingForResponseRef = useRef(false);
  const flushTimerRef = useRef(null);

  const flushBuffer = useCallback(() => {
    const buf = bufferRef.current.trim();
    if (!buf) return;

    // プロンプト部分を除去
    const content = buf.replace(/\n\s*❯\s*$/, "").trim();
    if (content) {
      const id = `msg-${++messageIdCounter.current}`;
      setMessages((prev) => [
        ...prev,
        {
          id,
          role: "assistant",
          content,
          timestamp: new Date().toISOString(),
        },
      ]);
    }
    bufferRef.current = "";
    waitingForResponseRef.current = false;
  }, []);

  const processOutput = useCallback((rawData) => {
    const clean = cleanPtyOutput(rawData);
    bufferRef.current += clean;

    // タイマーをリセット
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
    }

    // プロンプトを検出したら即座にフラッシュ
    if (endsWithPrompt(bufferRef.current) && waitingForResponseRef.current) {
      flushBuffer();
      return;
    }

    // 出力が止まって FLUSH_DELAY ms 経ったらフラッシュ
    if (waitingForResponseRef.current) {
      flushTimerRef.current = setTimeout(() => {
        if (bufferRef.current.trim()) {
          flushBuffer();
        }
      }, FLUSH_DELAY);
    }
  }, [flushBuffer]);

  const addUserMessage = useCallback((text) => {
    // タイマークリア
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
    }
    // バッファに溜まっている出力をフラッシュ
    const buf = bufferRef.current.trim();
    if (buf) {
      const content = buf.replace(/\n\s*❯\s*$/, "").trim();
      if (content) {
        const id = `msg-${++messageIdCounter.current}`;
        setMessages((prev) => [
          ...prev,
          {
            id,
            role: "assistant",
            content,
            timestamp: new Date().toISOString(),
          },
        ]);
      }
    }
    bufferRef.current = "";

    const id = `msg-${++messageIdCounter.current}`;
    setMessages((prev) => [
      ...prev,
      {
        id,
        role: "human",
        content: text,
        timestamp: new Date().toISOString(),
      },
    ]);
    waitingForResponseRef.current = true;
  }, []);

  const clearMessages = useCallback(() => {
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    setMessages([]);
    bufferRef.current = "";
    waitingForResponseRef.current = false;
  }, []);

  const loadHistory = useCallback((historyMessages) => {
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    const loaded = historyMessages.map((m) => ({
      id: `history-${++messageIdCounter.current}`,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp || new Date().toISOString(),
      isHistory: true,
    }));
    setMessages(loaded);
    bufferRef.current = "";
    waitingForResponseRef.current = false;
  }, []);

  return { messages, processOutput, addUserMessage, clearMessages, loadHistory };
}
