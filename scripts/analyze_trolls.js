const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const Groq = require('groq-sdk');
// Config
const ENABLE_BROWSER_FETCH = false; // Yeni düzende Chrome uzantısı gönderdiği için kapalı. Aktif etmek için true yapın.

let chromium, StealthPlugin;
if (ENABLE_BROWSER_FETCH) {
  chromium = require('playwright-extra').chromium;
  StealthPlugin = require('puppeteer-extra-plugin-stealth');
  // Activate stealth mode to bypass Cloudflare bot detection
  chromium.use(StealthPlugin());
}
const DB_FILE = path.join(__dirname, '../trolls.json');
const QUEUE_DIR = path.join(__dirname, '../queue');
const MAX_BATCH_SIZE = 30;
const REQUEST_DELAY_MS = 8000; // 8 seconds delay between browser fetches

const DOMAINS = [
  'https://eksisozluk.com',
  'https://eksisozluk199.com',
  'https://eksisozluk111.com'
];

// Fetch Ekşi Sözlük profile using a real stealth Chromium browser
async function fetchUserProfileWithBrowser(browser, nickname) {
  const profilePath = `/biri/${encodeURIComponent(nickname)}`;

  for (const domain of DOMAINS) {
    const url = `${domain}${profilePath}`;
    console.log(`[Browser] Fetching '${nickname}' from: ${url}`);
    let page;
    try {
      page = await browser.newPage();

      // Set a realistic viewport and extra headers
      await page.setViewportSize({ width: 1366, height: 768 });
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
      });

      // Navigate with a generous timeout and wait until network is idle
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });

      if (!response || response.status() === 403 || response.status() === 503) {
        console.warn(`[Browser] Got status ${response?.status()} from ${domain}. Trying next mirror...`);
        await page.close();
        continue;
      }

      // Wait a moment for JS-rendered content to settle
      await page.waitForTimeout(2000);

      const html = await page.content();
      await page.close();

      // Verify it's not a Cloudflare challenge page
      if (html.includes('cf-browser-verification') || html.includes('Just a moment') || html.includes('cf_chl')) {
        console.warn(`[Browser] Cloudflare JS challenge still detected on ${domain}. Trying next mirror...`);
        continue;
      }

      console.log(`[Browser] Successfully fetched profile for '${nickname}' from ${domain}.`);
      return html;

    } catch (e) {
      console.warn(`[Browser] Error fetching from ${domain}: ${e.message}`);
      if (page) await page.close().catch(() => {});
    }
  }

  throw new Error(`Could not fetch profile for '${nickname}' from any mirror using stealth browser.`);
}

let cachedModels = null;

// Models that are not suitable for chat completions (speech, classification, safety filters, etc.)
const EXCLUDED_MODEL_PATTERNS = ['whisper', 'vision', 'orpheus', 'prompt-guard', 'safeguard'];
// Prefer these model families for Turkish text analysis
const PREFERRED_MODEL_PATTERNS = ['llama', 'qwen', 'gemma', 'mixtral', 'deepseek', 'mistral'];
const FALLBACK_MODELS = ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile', 'gemma2-9b-it'];

function buildModelQueue(allModels) {
  const suitable = allModels.filter(m =>
    !EXCLUDED_MODEL_PATTERNS.some(p => m.toLowerCase().includes(p))
  );
  // Sort so preferred chat-capable models come first
  suitable.sort((a, b) => {
    const aOk = PREFERRED_MODEL_PATTERNS.some(p => a.toLowerCase().includes(p));
    const bOk = PREFERRED_MODEL_PATTERNS.some(p => b.toLowerCase().includes(p));
    return (aOk === bOk) ? 0 : aOk ? -1 : 1;
  });
  return suitable.length > 0 ? suitable : [...FALLBACK_MODELS];
}

// Retry with exponential backoff for Groq API
async function callGroqWithRetry(groq, prompt, retries = 3, delay = 10000) {
  if (!cachedModels) {
    try {
      const res = await groq.models.list();
      cachedModels = res.data.map(m => m.id);
      console.log('[Groq] Available models:', cachedModels.join(', '));
    } catch (e) {
      console.warn('[Groq] Failed to list models:', e.message);
      cachedModels = [...FALLBACK_MODELS];
    }
  }

  const modelQueue = buildModelQueue(cachedModels);
  let modelIdx = 0;
  let attempt = 0;
  let currentDelay = delay;

  while (attempt < retries) {
    if (modelIdx >= modelQueue.length) {
      // Ran out of models; append fallbacks not yet tried
      for (const fb of FALLBACK_MODELS) {
        if (!modelQueue.includes(fb)) modelQueue.push(fb);
      }
      if (modelIdx >= modelQueue.length) break;
    }

    const currentModel = modelQueue[modelIdx];
    try {
      if (attempt > 0 || modelIdx > 0) console.log(`[Groq] Trying model: ${currentModel}`);
      const result = await groq.chat.completions.create({
        model: currentModel,
        messages: [
          // /no_think disables the reasoning chain on Qwen3; other models treat it as a plain instruction
          { role: 'system', content: 'Yalnızca geçerli JSON çıktısı üret. Düşünme zinciri, açıklama veya markdown ekleme. /no_think' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1,
        max_tokens: 512,
      });
      const content = result.choices[0].message.content.trim();
      if (!content) throw new Error('Empty response from model');
      return content;
    } catch (e) {
      const errMsg = e.message || '';

      // Model requires terms acceptance or is rate-limited — skip, don't count as a retry
      if (errMsg.includes('model_terms_required') || errMsg.includes('terms acceptance')) {
        console.warn(`[Groq] Model '${currentModel}' requires terms acceptance. Skipping.`);
        cachedModels = cachedModels.filter(m => m !== currentModel);
        modelIdx++;
        continue;
      }
      if (errMsg.includes('rate_limit_exceeded') || errMsg.includes('Rate limit reached')) {
        console.warn(`[Groq] Model '${currentModel}' rate limited. Skipping for this run.`);
        cachedModels = cachedModels.filter(m => m !== currentModel);
        modelIdx++;
        continue;
      }

      attempt++;
      if (attempt >= retries) throw e;

      const retryMatch = errMsg.match(/(\d+(\.\d+)?)\s*second/);
      const waitMs = retryMatch ? (parseFloat(retryMatch[1]) + 2) * 1000 : currentDelay;
      console.warn(`[Groq] API error (retry ${attempt}/${retries}): ${errMsg.split('\n')[0]}. Retrying in ${waitMs / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
      currentDelay *= 2;
      modelIdx++;
    }
  }

  throw new Error('All Groq models failed after maximum retries.');
}

async function run() {
  if (!process.env.GROQ_API_KEY) {
    console.error('Error: GROQ_API_KEY environment variable is not set.');
    process.exit(1);
  }

  // Load existing database
  let trolls = {};
  if (fs.existsSync(DB_FILE)) {
    try {
      trolls = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      console.log(`Loaded ${Object.keys(trolls).length} trolls from database.`);
    } catch (e) {
      console.error('Failed to parse trolls.json, starting fresh:', e.message);
      trolls = {};
    }
  }

  // Read queue
  if (!fs.existsSync(QUEUE_DIR)) {
    console.log('Queue directory does not exist. Nothing to do.');
    return;
  }

  const queueFiles = fs.readdirSync(QUEUE_DIR)
    .filter(file => file.endsWith('.json'))
    .map(file => {
      const filePath = path.join(QUEUE_DIR, file);
      let reportedAt = 0;
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const match = content.match(/"reported_at"\s*:\s*"([^"]+)"/);
        if (match && match[1]) {
          reportedAt = new Date(match[1]).getTime();
        } else {
          reportedAt = fs.statSync(filePath).mtimeMs;
        }
      } catch (e) {
        try { reportedAt = fs.statSync(filePath).mtimeMs; } catch(err) { reportedAt = 0; }
      }
      return { file, filePath, reportedAt };
    })
    .sort((a, b) => a.reportedAt - b.reportedAt);

  const MIN_BATCH_SIZE = 10;
  const isForceRun = process.env.FORCE_RUN === 'true';

  if (queueFiles.length === 0) {
    console.log('Queue is empty. Nothing to process.');
    return;
  }

  if (queueFiles.length < MIN_BATCH_SIZE && !isForceRun) {
    console.log(`Queue has ${queueFiles.length} items. Waiting for at least ${MIN_BATCH_SIZE} before processing.`);
    return;
  }

  console.log(`Found ${queueFiles.length} reported authors in queue.`);
  const batch = queueFiles.slice(0, MAX_BATCH_SIZE);
  console.log(`Processing batch of ${batch.length} authors...`);

  // Initialize Groq — 14,400 free requests/day with llama-3.3-70b-versatile
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

  // Launch a single stealth browser for all requests in this batch
  let browser = null;
  if (ENABLE_BROWSER_FETCH) {
    console.log('[Browser] Launching stealth Chromium browser...');
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ]
    });
  }

  let hasErrors = false;
  try {
    for (let idx = 0; idx < batch.length; idx++) {
      const item = batch[idx];
      let data;
      try {
        data = JSON.parse(fs.readFileSync(item.filePath, 'utf8'));
      } catch (e) {
        console.error(`Failed to read/parse queue file ${item.file}:`, e.message);
        fs.unlinkSync(item.filePath);
        continue;
      }

      const rawNickname = data.nickname;
      if (!rawNickname) {
        console.error(`Invalid data in queue file ${item.file}: missing 'nickname'.`);
        fs.unlinkSync(item.filePath);
        continue;
      }

      const nickname = rawNickname.trim().toLowerCase();
      console.log(`\n--- [${idx + 1}/${batch.length}] Analyzing yazar: ${nickname} ---`);

      // Check 24 hour limit
      const existing = trolls[nickname];
      if (existing && existing.last_evaluated) {
        const hoursSinceLastEval = (Date.now() - new Date(existing.last_evaluated).getTime()) / (1000 * 60 * 60);
        if (hoursSinceLastEval < 24) {
          console.log(`Skipping '${nickname}'. Evaluated recently (${hoursSinceLastEval.toFixed(1)} hours ago).`);
          fs.unlinkSync(item.filePath);
          continue;
        }
      }

      // Use pre-fetched entries from queue file if available, otherwise use browser
      let entries = (data.entries || []).filter(e => e.content && e.content.trim().length > 0);
      const hasCachedEntries = entries.length > 0;

      if (!hasCachedEntries && idx > 0) {
        if (ENABLE_BROWSER_FETCH) {
          console.log(`Waiting ${REQUEST_DELAY_MS / 1000} seconds before next browser fetch...`);
          await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY_MS));
        }
      }

      try {
        if (!hasCachedEntries) {
          if (ENABLE_BROWSER_FETCH) {
            console.log(`No entries in queue file. Using stealth browser to fetch profile...`);
            const html = await fetchUserProfileWithBrowser(browser, nickname);
            const $ = cheerio.load(html);

            $('#entry-item-list li').each((i, el) => {
              const content = $(el).find('.content').text().trim();
              const title = $(el).find('.entry-title').text().trim() || $(el).find('a').first().text().trim() || '';
              if (content) {
                entries.push({ title, content });
              }
            });
          } else {
            console.warn(`No entries found for '${nickname}' and browser fetch is disabled. Skipping...`);
            fs.unlinkSync(item.filePath);
            continue;
          }
        } else {
          console.log(`Using ${entries.length} pre-fetched entries from queue file.`);
        }

        if (entries.length === 0) {
          console.warn(`No entries found for '${nickname}'. User may not exist or have no entries.`);
          fs.unlinkSync(item.filePath);
          continue;
        }

        // Token limitlerini aşmamak için yazıları kısalt (Groq 8b-instant limiti genelde 6000 token)
        entries = entries.map(e => ({
          title: e.title,
          content: e.content.length > 800 ? e.content.substring(0, 800) + '... (kısaltıldı)' : e.content
        })).slice(0, 5); // Yapay zekaya en fazla 5 entry gönder

        console.log(`Successfully got ${entries.length} entries. Sending to Groq for scoring...`);

        // Prepare Groq Prompt
        const prompt = `Aşağıda bir Ekşi Sözlük yazarının yazdığı son ${entries.length} entry bulunmaktadır. Bu yazıları dikkatlice analiz et ve yazarın yazılarındaki ihlal durumunu 4 farklı kategoride değerlendir:

1. dini (Dini ve Kutsal Değerler Hassasiyeti): İnançlara, kutsal figürlere, dini ritüellere yönelik hakaret veya aşırı provokatif üslup var mı?
2. milli (Milli ve Tarihi Değerler Hassasiyeti): Cumhuriyetin kurucu değerlerine, kurucularına, milli marşa, bayrağa veya tarihi değerlere yönelik provokatif, alaycı veya karalayıcı üslup var mı?
3. siyasi (Siyasi Fanatizm Hassasiyeti): Siyasi kişi veya partileri militanca savunan, hakaret içeren, yapıcı tartışma yerine sadece propaganda odaklı üslup var mı?
4. nefret (Nefret Söylemi Hassasiyeti): Irk, etnik köken, cinsiyet, cinsel yönelim veya toplumsal gruplara karşı ayrımcı, düşmanca ve nefret dolu bir üslup var mı?

Her kategori için 0.0 (temiz/hiç yok) ile 1.0 (aşırı düzeyde ihlal/provokasyon) arasında bir puan ver.

Yazarın Entry'leri:
${entries.map((e, index) => `[Entry ${index + 1}] Başlık: ${e.title}\nİçerik: ${e.content}`).join('\n\n')}

Sonucu kesinlikle sadece aşağıdaki JSON formatında döndür, markdown bloğu (örn. \`\`\`json ... \`\`\`) veya başka hiçbir açıklama/metin ekleme:
{
  "dini": 0.0,
  "milli": 0.0,
  "siyasi": 0.0,
  "nefret": 0.0
}`;

        const response = await callGroqWithRetry(groq, prompt);
        let text = response.trim();

        // Strip <think>...</think> reasoning blocks (Qwen3 and similar thinking models).
        // Strategy: if </think> exists take everything after it; otherwise strip from <think> onward
        // and then hunt for the JSON block directly.
        const thinkEnd = text.indexOf('</think>');
        if (thinkEnd !== -1) {
          text = text.slice(thinkEnd + '</think>'.length).trim();
        } else if (/<think>/i.test(text)) {
          // Thinking block was cut off (no closing tag) — extract the trailing JSON if present
          const lastBrace = text.lastIndexOf('{');
          if (lastBrace !== -1) text = text.slice(lastBrace);
          else text = '';
        }

        // Extract JSON — prefer object that contains our expected keys
        let jsonStr = text;
        const specificMatch = text.match(/\{[^{}]*"dini"[^{}]*\}/s);
        if (specificMatch) {
          jsonStr = specificMatch[0];
        } else {
          const fallback = text.match(/\{[\s\S]*\}/);
          if (fallback) jsonStr = fallback[0];
        }

        console.log(`Groq response: ${text}`);
        const scores = JSON.parse(jsonStr);

        const dini = parseFloat(scores.dini) || 0.0;
        const milli = parseFloat(scores.milli) || 0.0;
        const siyasi = parseFloat(scores.siyasi) || 0.0;
        const nefret = parseFloat(scores.nefret) || 0.0;

        // Overall score = highest category * 100
        const maxScoreVal = Math.max(dini, milli, siyasi, nefret);
        const overallScore = Math.round(maxScoreVal * 100);

        trolls[nickname] = {
          score: overallScore,
          last_evaluated: new Date().toISOString(),
          details: { dini, milli, siyasi, nefret }
        };

        console.log(`Scored '${nickname}': Overall=${overallScore}, Dini=${dini}, Milli=${milli}, Siyasi=${siyasi}, Nefret=${nefret}`);

        // Delete queue file upon successful evaluation
        fs.unlinkSync(item.filePath);

      } catch (e) {
        console.error(`Error processing '${nickname}':`, e.message);
        hasErrors = true;
        // Keep queue file on error for retry in next run
      }
    }
  } finally {
    if (browser) {
      await browser.close();
      console.log('[Browser] Stealth browser closed.');
    }
  }

  // Save updated database
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(trolls, null, 2), 'utf8');
    console.log(`\nSuccessfully updated trolls.json.`);
  } catch (e) {
    console.error('Failed to write trolls.json:', e.message);
    hasErrors = true;
  }
  
  if (hasErrors) {
    console.error('\nScript finished with errors. Exiting with code 1 so GitHub Actions will report a failure.');
    process.exit(1);
  }
}

run().catch(console.error);
