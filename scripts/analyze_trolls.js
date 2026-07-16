const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

// Activate stealth mode to bypass Cloudflare bot detection
chromium.use(StealthPlugin());

// Config
const DB_FILE = path.join(__dirname, '../trolls.json');
const QUEUE_DIR = path.join(__dirname, '../queue');
const MAX_BATCH_SIZE = 5;
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

// Retry with exponential backoff for Gemini API
async function callGeminiWithRetry(model, prompt, retries = 3, delay = 5000) {
  for (let i = 0; i < retries; i++) {
    try {
      const result = await model.generateContent(prompt);
      return result;
    } catch (e) {
      if (i === retries - 1) throw e;
      console.warn(`[Gemini] API error (retry ${i + 1}/${retries}): ${e.message}. Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
}

async function run() {
  if (!process.env.GEMINI_API_KEY) {
    console.error('Error: GEMINI_API_KEY environment variable is not set.');
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
    .map(file => ({
      file,
      filePath: path.join(QUEUE_DIR, file)
    }));

  if (queueFiles.length === 0) {
    console.log('Queue is empty. Nothing to process.');
    return;
  }

  console.log(`Found ${queueFiles.length} reported authors in queue.`);
  const batch = queueFiles.slice(0, MAX_BATCH_SIZE);
  console.log(`Processing batch of ${batch.length} authors...`);

  // Initialize Gemini
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

  // Launch a single stealth browser for all requests in this batch
  console.log('[Browser] Launching stealth Chromium browser...');
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ]
  });

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
        console.log(`Waiting ${REQUEST_DELAY_MS / 1000} seconds before next browser fetch...`);
        await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY_MS));
      }

      try {
        if (!hasCachedEntries) {
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
          console.log(`Using ${entries.length} pre-fetched entries from queue file.`);
        }

        if (entries.length === 0) {
          console.warn(`No entries found for '${nickname}'. User may not exist or have no entries.`);
          fs.unlinkSync(item.filePath);
          continue;
        }

        console.log(`Successfully got ${entries.length} entries. Sending to Gemini for scoring...`);

        // Prepare Gemini Prompt
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

        const response = await callGeminiWithRetry(model, prompt);
        let text = response.text().trim();

        // Clean markdown code blocks if Gemini wraps response
        if (text.startsWith('```')) {
          text = text.replace(/^```json\s*/, '').replace(/```$/, '').trim();
        }

        console.log(`Gemini response: ${text}`);
        const scores = JSON.parse(text);

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
        // Keep queue file on error for retry in next run
      }
    }
  } finally {
    await browser.close();
    console.log('[Browser] Stealth browser closed.');
  }

  // Save updated database
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(trolls, null, 2), 'utf8');
    console.log(`\nSuccessfully updated trolls.json.`);
  } catch (e) {
    console.error('Failed to write trolls.json:', e.message);
  }
}

run().catch(console.error);
