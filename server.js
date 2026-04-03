/**
 * H SEARCH AI写真査定 - APIサーバー (Express + Node.js)
 *
 * 起動方法:
 *   npm install
 *   cp .env.example .env  # .env に各値を設定
 *   npm start
 *
 * 環境変数 (.env):
 *   ANTHROPIC_API_KEY=sk-ant-xxxx      ← 必須
 *   ANTHROPIC_MODEL=claude-sonnet-4-20250514  ← 任意（デフォルト: claude-sonnet-4-20250514）
 *   PORT=3000                          ← 任意（デフォルト: 3000）
 *   ALLOWED_ORIGIN=https://your-domain.com ← 任意（デフォルト: * ）
 *
 * ディレクトリ構成:
 *   server.js
 *   public/
 *     index.html
 *     privacy-policy.html
 *     terms.html
 */

'use strict';

require('dotenv').config();

const express   = require('express');
const multer    = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const path      = require('path');

// ============================================================
// 設定
// ============================================================
const PORT           = process.env.PORT           || 3000;
const API_KEY        = process.env.ANTHROPIC_API_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN  || '*';
const MODEL          = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
const MAX_TOKENS     = 1200;
const MAX_FILE_SIZE  = 10 * 1024 * 1024; // 10MB
const MAX_FILES      = 5;

// HEIC / HEIF は現時点で非対応
const ALLOWED_MIMES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);

if (!API_KEY) {
  console.error('[FATAL] 環境変数 ANTHROPIC_API_KEY が設定されていません。');
  process.exit(1);
}

// ============================================================
// 簡易インメモリレート制限（外部ライブラリなし）
// 1IPあたり RATE_WINDOW_MS ミリ秒以内に RATE_MAX_REQ 回を超えたらブロック
// ============================================================
const RATE_WINDOW_MS = 60 * 1000; // 1分
const RATE_MAX_REQ   = 5;         // 1分あたり最大5回
const rateMap        = new Map();  // { ip: [timestamp, ...] }

function rateLimiter(req, res, next) {
  const ip  = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();

  if (!rateMap.has(ip)) {
    rateMap.set(ip, []);
  }

  // ウィンドウ外のタイムスタンプを削除
  const timestamps = rateMap.get(ip).filter(t => now - t < RATE_WINDOW_MS);
  timestamps.push(now);
  rateMap.set(ip, timestamps);

  if (timestamps.length > RATE_MAX_REQ) {
    return res.status(429).json({
      error:   true,
      message: 'リクエストが多すぎます。しばらく時間をおいてから再度お試しください。',
      retry:   true,
    });
  }

  next();
}

// メモリ肥大化防止：定期的に古いエントリを削除（5分ごと）
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of rateMap.entries()) {
    const valid = timestamps.filter(t => now - t < RATE_WINDOW_MS);
    if (valid.length === 0) {
      rateMap.delete(ip);
    } else {
      rateMap.set(ip, valid);
    }
  }
}, 5 * 60 * 1000);

// ============================================================
// Anthropicクライアント
// ============================================================
const anthropic = new Anthropic({ apiKey: API_KEY });

// ============================================================
// Expressセットアップ
// ============================================================
const app = express();

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '1mb' }));

// 静的ファイル配信（public ディレクトリのみ）
app.use(express.static(path.join(__dirname, 'public')));

// 拡張子なしURLの明示ルート（/privacy-policy → public/privacy-policy.html）
app.get('/privacy-policy', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy-policy.html'));
});
app.get('/terms', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terms.html'));
});

// ============================================================
// multer（メモリ保存・ファイル形式チェック）
// ============================================================
const storage = multer.memoryStorage();
const upload  = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES },
  fileFilter: (_req, file, cb) => {
    const mime = file.mimetype.toLowerCase();
    if (ALLOWED_MIMES.has(mime)) {
      return cb(null, true);
    }
    cb(new Error('対応していないファイル形式です。JPEG・PNG・WEBPのいずれかでアップロードしてください。'));
  },
});

// ============================================================
// Claude APIに送るシステムプロンプト
// ============================================================
const SYSTEM_PROMPT = `あなたはリユース・買取業者のAI査定アシスタントです。
ユーザーが送った商品画像と情報をもとに、参考価格（概算）を推定します。

【絶対に守るルール】
1. 表示する価格は「参考価格（概算）」であり、正式な買取価格ではありません。
2. 真贋（本物かどうか）を画像だけで断定しないでください。
   必ず「画像上の推定」「現物確認が必要」という表現を使ってください。
3. 断定的な表現を使わないでください。
   使ってはいけない表現の例: 「本物です」「必ずこの価格」「確実に」「100%」
4. すべてのフィールドを必ず返してください。省略不可。
5. price_min は必ず price_max より小さい値にしてください。
6. confidence は HIGH / MEDIUM / LOW の3段階のみです。
   - HIGH  : 商品の特定がほぼできており、相場も明確な場合
   - MEDIUM: ある程度特定できているが、詳細確認が必要な場合
   - LOW   : 画像からの特定が困難、または情報が不足している場合
7. factors（価格変動要因）は必ず3〜6項目を返してください。
8. 回答は必ずJSON形式のみ。前置き・後置き・説明文は一切不要。
9. 日本語で回答してください。

【回答フォーマット（このJSONのみ返してください）】
{
  "category":   "商品カテゴリ（例: ブランド時計、ジュエリー、金・プラチナ等）",
  "brand":      "ブランド候補（画像上の推定。不明の場合は「不明（確認が必要）」）",
  "model":      "モデル・型番候補（推定。不明の場合は「確認が必要」）",
  "material":   "素材推定（画像上の判断。不明の場合は「確認が必要」）",
  "condition":  "状態評価（例: 良好、普通、やや使用感あり、確認が必要）+ （画像上の判断）を末尾に付ける",
  "price_min":  数値（円・整数）,
  "price_max":  数値（円・整数）,
  "confidence": "HIGH または MEDIUM または LOW",
  "reasoning":  "参考価格の根拠を2〜3文で説明。「画像上の特徴から〜と推定されます」という表現を使う。",
  "factors": [
    "価格変動要因1（文字列）",
    "価格変動要因2（文字列）",
    "価格変動要因3（文字列）"
  ],
  "disclaimer": [
    "本結果はAIによる参考価格（概算）です。正式な買取価格ではありません。",
    "実際の買取価格は現物確認・状態チェック・真贋確認後に決定いたします。",
    "画像のみでの真贋断定はできません。真贋の最終判断は現物確認が必要です。",
    "市場相場・商品の状態・付属品の有無等により、参考価格は大きく変動します。",
    "本結果を根拠とした取引・判断について、当社は責任を負いかねます。"
  ]
}`;

// ============================================================
// ユーザーメッセージを構築する関数
// ============================================================
function buildUserMessage(files, itemName, detail) {
  const imageBlocks = files.map(file => {
    // image/jpg は image/jpeg に正規化
    let mediaType = file.mimetype.toLowerCase();
    if (mediaType === 'image/jpg') mediaType = 'image/jpeg';

    return {
      type:   'image',
      source: {
        type:       'base64',
        media_type: mediaType,
        data:       file.buffer.toString('base64'),
      },
    };
  });

  const textBlock = {
    type: 'text',
    text: `以下の商品を査定してください。

商品名・わかること: ${itemName || '（未記入）'}
状態・付属品など: ${detail || '（未記入）'}

上記の情報と添付画像をもとに、参考価格（概算）を推定し、指定のJSON形式のみで回答してください。`,
  };

  return [...imageBlocks, textBlock];
}

// ============================================================
// JSONパース（フォールバック付き）
// ============================================================
function parseClaudeResponse(rawText) {
  try {
    return { ok: true, data: JSON.parse(rawText.trim()) };
  } catch (_) {
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return { ok: true, data: JSON.parse(jsonMatch[0]) };
      } catch (_2) { /* fall through */ }
    }
    return { ok: false, raw: rawText };
  }
}

// ============================================================
// レスポンスバリデーション（必須フィールドチェック）
// ============================================================
const REQUIRED_FIELDS = [
  'category', 'brand', 'model', 'material', 'condition',
  'price_min', 'price_max', 'confidence', 'reasoning', 'factors', 'disclaimer',
];

function validateResponseShape(data) {
  for (const field of REQUIRED_FIELDS) {
    if (data[field] === undefined || data[field] === null) return false;
  }
  if (typeof data.price_min !== 'number' || typeof data.price_max !== 'number') return false;
  if (data.price_min >= data.price_max) return false;
  if (!['HIGH', 'MEDIUM', 'LOW'].includes(data.confidence)) return false;
  if (!Array.isArray(data.factors)    || data.factors.length    < 1) return false;
  if (!Array.isArray(data.disclaimer) || data.disclaimer.length < 1) return false;
  return true;
}

// ============================================================
// フォールバックレスポンス（パース失敗・バリデーション失敗時）
// ============================================================
function makeFallbackResponse() {
  return {
    category:   '詳細確認が必要',
    brand:      '確認が必要（画像から特定できませんでした）',
    model:      '確認が必要',
    material:   '確認が必要',
    condition:  '確認が必要（画像上の判断）',
    price_min:  5000,
    price_max:  100000,
    confidence: 'LOW',
    reasoning:  '画像からの詳細特定が困難でした。より鮮明な写真や、ブランド名・型番などの追加情報をご提供いただくと精度が上がります。正確な参考価格は正式査定にてご案内いたします。',
    factors: [
      '商品の詳細情報（ブランド・型番等）',
      '状態（傷・汚れ・動作状況）',
      '真贋確認（現物確認が必要）',
      '付属品の有無',
      '査定時点の市場相場',
    ],
    disclaimer: [
      '本結果はAIによる参考価格（概算）です。正式な買取価格ではありません。',
      '実際の買取価格は現物確認・状態チェック・真贋確認後に決定いたします。',
      '画像のみでの真贋断定はできません。真贋の最終判断は現物確認が必要です。',
      '市場相場・商品の状態・付属品の有無等により、参考価格は大きく変動します。',
      '本結果を根拠とした取引・判断について、当社は責任を負いかねます。',
    ],
    _fallback: true,
  };
}

// ============================================================
// POST /api/assessment
// ============================================================
app.post(
  '/api/assessment',
  rateLimiter,
  upload.array('images', MAX_FILES),
  async (req, res) => {
    // --- 1. 画像チェック ---
    const files = req.files || [];
    if (files.length === 0) {
      return res.status(400).json({
        error:   true,
        message: '画像が添付されていません。商品の写真を1枚以上アップロードしてください。',
      });
    }

    // --- 2. 入力値取得 & バリデーション ---
    const itemName = (req.body.item_name || '').trim();
    const detail   = (req.body.detail   || '').trim();

    if (!itemName) {
      return res.status(400).json({
        error:   true,
        message: '商品名・わかることを入力してください。',
      });
    }
    if (itemName.length > 200) {
      return res.status(400).json({
        error:   true,
        message: '商品名は200文字以内で入力してください。',
      });
    }
    if (detail.length > 1000) {
      return res.status(400).json({
        error:   true,
        message: '状態・付属品の入力は1000文字以内にしてください。',
      });
    }

    // --- 3. Claude APIコール ---
    let rawText = '';
    try {
      const message = await anthropic.messages.create({
        model:      MODEL,
        max_tokens: MAX_TOKENS,
        system:     SYSTEM_PROMPT,
        messages: [
          {
            role:    'user',
            content: buildUserMessage(files, itemName, detail),
          },
        ],
      });

      const textContent = message.content.find(c => c.type === 'text');
      rawText = textContent ? textContent.text : '';

    } catch (apiErr) {
      console.error('[Claude API Error]', apiErr.status, apiErr.message);

      if (apiErr.status === 401) {
        return res.status(500).json({
          error:   true,
          message: 'AI査定サービスへの接続に失敗しました。しばらくお待ちのうえ再度お試しください。',
        });
      }
      if (apiErr.status === 429) {
        return res.status(429).json({
          error:   true,
          message: 'ただいまアクセスが集中しています。少し時間をおいて再度お試しください。',
          retry:   true,
        });
      }
      // その他のAPIエラー → フォールバック
      return res.status(200).json(makeFallbackResponse());
    }

    // --- 4. JSONパース ---
    const parsed = parseClaudeResponse(rawText);
    if (!parsed.ok) {
      console.warn('[Parse Warn] JSONパース失敗。フォールバックを返します。', rawText.slice(0, 200));
      return res.status(200).json(makeFallbackResponse());
    }

    // --- 5. バリデーション ---
    if (!validateResponseShape(parsed.data)) {
      console.warn('[Validate Warn] レスポンス形式が不正。フォールバックを返します。');
      return res.status(200).json(makeFallbackResponse());
    }

    // --- 6. 正常レスポンス ---
    return res.status(200).json(parsed.data);
  },
);

// ============================================================
// multer / 汎用エラーハンドラ
// ============================================================
app.use((err, req, res, _next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        error:   true,
        message: '1枚あたりのファイルサイズは10MB以内でアップロードしてください。',
      });
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({
        error:   true,
        message: '写真は最大5枚までアップロードできます。',
      });
    }
  }
  if (err && err.message) {
    return res.status(400).json({ error: true, message: err.message });
  }
  console.error('[Server Error]', err);
  return res.status(500).json({
    error:   true,
    message: 'サーバーエラーが発生しました。しばらくお待ちのうえ再度お試しください。',
  });
});

// ============================================================
// 起動
// ============================================================
app.listen(PORT, () => {
  console.log(`[H SEARCH AI査定サーバー] ポート ${PORT} で起動しました`);
  console.log(`  アクセス: http://localhost:${PORT}`);
  console.log(`  API:      http://localhost:${PORT}/api/assessment`);
  console.log(`  モデル:   ${MODEL}`);
});
