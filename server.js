require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { parseStringPromise } = require('xml2js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── STATE ─────────────────────────────────────────────
const DEDUP_FILE = path.join(__dirname, 'submitted_articles.json');
const MODEL_FILE = path.join(__dirname, 'selected_model.txt');
const defaultModel = 'gemini-2.5-flash-lite';
let automationRunning = false;
let automationInterval = null;
let activityLog = [];
let stats = { 
    totalSubmitted: 0, 
    totalFetched: 0, 
    errors: 0, 
    lastSubmission: null, 
    startedAt: null,
    currentArticle: null, // { title, url }
    currentStep: 0 // 0: Idle, 1-4: Form Parts
};

// ─── DAILY LIMIT STATE ─────────────────────────────────
let dailyLimitReached = false;
let dailyLimitDate = null; // The date string (YYYY-MM-DD) when limit was hit

function getTodayDateStr() {
    return new Date().toISOString().split('T')[0]; // 'YYYY-MM-DD'
}

function resetDailyLimitIfNewDay() {
    const today = getTodayDateStr();
    if (dailyLimitReached && dailyLimitDate && dailyLimitDate !== today) {
        log('🌅 Hari baharu! Had harian direset. Automasi akan diteruskan.', 'success');
        dailyLimitReached = false;
        dailyLimitDate = null;
    }
}

// Returns ms until the next midnight (local time)
function msUntilMidnight() {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0); // next midnight
    return midnight.getTime() - now.getTime();
}

// ─── HELPERS ───────────────────────────────────────────
function log(msg, type = 'info') {
    const entry = { time: new Date().toISOString(), msg, type };
    activityLog.unshift(entry);
    if (activityLog.length > 100) activityLog.length = 100;
    console.log(`[${type.toUpperCase()}] ${msg}`);
    return entry;
}

function loadSubmitted() {
    try {
        return JSON.parse(fs.readFileSync(DEDUP_FILE, 'utf-8'));
    } catch { return []; }
}

function saveSubmitted(articles) {
    fs.writeFileSync(DEDUP_FILE, JSON.stringify(articles, null, 2), 'utf-8');
}

function isAlreadySubmitted(url, title) {
    const submitted = loadSubmitted();
    return submitted.some(a => {
        // Match by exact URL
        if (a.url === url) return true;
        // Match by title (case-insensitive, trimmed)
        if (title && a.title && a.title.toLowerCase().trim() === title.toLowerCase().trim()) return true;
        return false;
    });
}

function markAsSubmitted(article, status = 'success') {
    if (isAlreadySubmitted(article.url, article.title)) {
        // If it exists, update its status
        const submitted = loadSubmitted();
        const index = submitted.findIndex(a => a.url === article.url || (article.title && a.title === article.title));
        if (index !== -1) {
            submitted[index].status = status;
            submitted[index].submittedAt = new Date().toISOString();
            saveSubmitted(submitted);
        }
        return;
    }
    const submitted = loadSubmitted();
    submitted.push({ 
        ...article, 
        status: status,
        submittedAt: new Date().toISOString() 
    });
    saveSubmitted(submitted);
}

// ─── FETCH ARTICLES FROM GOOGLE NEWS RSS ───────────────
function fetchUrl(url) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        const options = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9,ms;q=0.8'
            },
            timeout: 15000
        };
        client.get(url, options, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchUrl(res.headers.location).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`Server returned status ${res.statusCode}`));
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
            res.on('error', reject);
        }).on('error', reject);
    });
}

async function fetchBeritaHarianArticles() {
    log('📡 Mengambil artikel Berita Harian dari Google News RSS...');
    try {
        const rssUrl = 'https://news.google.com/rss/search?q=site:bharian.com.my&hl=ms&gl=MY&ceid=MY:ms';
        const xml = await fetchUrl(rssUrl);
        const result = await parseStringPromise(xml);
        const items = result.rss.channel[0].item || [];

        const articles = items
            .filter(item => {
                const title = item.title?.[0] || '';
                // Filter out category/index pages and very short/generic titles
                return title.length > 25 && 
                       !title.includes('BHarian Online') && 
                       !title.includes('Berita popular') &&
                       !title.startsWith('Lain-lain') &&
                       !title.toLowerCase().includes('sukan');
            })
            .map(item => {
                const fullTitle = (item.title?.[0] || '').replace(/ - Berita Harian$/, '').trim();
                // Try to extract author from description if available in Google News RSS
                const description = item.description?.[0] || '';
                let author = 'Berita Harian';
                const authorMatch = description.match(/oleh (.+?)(?=<\/| - )/i) || description.match(/Wartawan BH/i);
                if (authorMatch) author = authorMatch[0].replace('oleh ', '');

                return {
                    title: fullTitle,
                    googleLink: item.link?.[0] || '',
                    pubDate: item.pubDate?.[0] || '',
                    author: author,
                    source: 'Berita Harian'
                };
            })
            .slice(0, 50);

        stats.totalFetched = articles.length;
        log(`✅ Berjaya mengambil ${articles.length} artikel dari Berita Harian`);
        return articles;
    } catch (err) {
        let errMsg = err.message;
        if (errMsg.includes('Unquoted attribute value')) {
            errMsg = "Google menyekat akses (Blocked by Google)";
        }
        log(`❌ Gagal mengambil artikel: ${errMsg}`, 'error');
        stats.errors++;
        return [];
    }
}

function findNewArticle(articles) {
    for (const article of articles) {
        if (!isAlreadySubmitted(article.googleLink, article.title)) {
            return article;
        }
    }
    return null;
}

// ─── GEMINI AI ─────────────────────────────────────────
async function generateAIContentGemini(prompt) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === 'your-gemini-api-key-here') {
        log('⚠️ Gemini API key tidak ditetapkan, menggunakan kandungan generik', 'warn');
        return {
            sinopsis: `Artikel ini membincangkan tentang tajuk yang diberikan. Ia menyediakan maklumat terkini mengenai perkara tersebut dan memberikan perspektif yang penting untuk diketahui oleh pembaca.`,
            pengajaran: `Artikel ini mengajar kita tentang kepentingan memahami isu semasa dan sentiasa peka terhadap perkembangan terkini.`
        };
    }

    log('🤖 Menjana sinopsis dan pengajaran menggunakan Gemini AI...');
    try {
        const genAI = new GoogleGenerativeAI(apiKey);
        // Models that are most likely available on v1beta as of early 2026
        const modelsToTry = [
            'gemini-2.5-flash-lite',
            'gemini-flash-latest',
            'gemini-3.1-flash-lite-preview',
            'gemini-2.5-flash',
            'gemini-2.0-flash'
        ];
        let text = '';
        let lastError = null;

        for (const modelName of modelsToTry) {
            try {
                const model = genAI.getGenerativeModel({ model: modelName });
                const result = await model.generateContent(prompt);
                const response = await result.response;
                text = response.text();
                if (text) break;
            } catch (err) {
                lastError = err;
                continue;
            }
        }

        if (!text) throw lastError || new Error('Tiada respon dari AI');

        return parseAIResponse(text);
    } catch (err) {
        log(`❌ Gagal menjana AI: ${err.message}`, 'error');
        stats.errors++;
        return {
            sinopsis: `Artikel ini membincangkan tentang tajuk yang diberikan. Ia menyediakan maklumat terkini mengenai perkara tersebut.`,
            pengajaran: `Artikel ini mengajar kita tentang kepentingan memahami isu semasa.`
        };
    }
}

async function generateAIContentGeneric(prompt) {
    // Placeholder for other AI models or a generic fallback
    log('⚠️ Menggunakan penjanaan kandungan AI generik (model tidak disokong atau tidak ditetapkan)', 'warn');
    return {
        sinopsis: `Artikel ini membincangkan tentang tajuk yang diberikan. Ia menyediakan maklumat penting untuk pembaca.`,
        pengajaran: `Kita boleh belajar tentang kepentingan isu semasa daripada artikel ini.`
    };
}

async function generateAIContent(title, contentSnippet = '') {
    const prompt = `Buat ulasan ringkas untuk artikel bertajuk "${title}"${contentSnippet ? ' dengan kandungan: ' + contentSnippet : ''}.
Tolong berikan balasan dalam format JSON ini HANYA (jangan tulis markdown \`\`\`json, hanya kod JSON murni):
{
  "sinopsis": "ringkasan ringkas artikel dalam 2-3 ayat (jangan gunakan tanda bintang atau format tebal)",
  "pengajaran": "satu pengajaran moral ringkas dari artikel ini (jangan gunakan tanda bintang)"
}`;

    // Read the selected model from file
    const selectedModelStr = fs.existsSync(MODEL_FILE) ? fs.readFileSync(MODEL_FILE, 'utf-8').trim() || defaultModel : defaultModel;
    
    // Choose which API block to call based on model name prefix
    if (selectedModelStr.startsWith('gemini-')) {
        return generateAIContentGemini(prompt);
    } else {
        // Fallback or handle standard openai format
        return generateAIContentGeneric(prompt);
    }
}

function parseAIResponse(text) {
    let sinopsis = '';
    let pengajaran = '';

    try {
        // Find json if wrapped in markdown
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        const rawJson = jsonMatch ? jsonMatch[0] : text;
        const parsed = JSON.parse(rawJson);
        sinopsis = parsed.sinopsis || '';
        pengajaran = parsed.pengajaran || '';
    } catch (e) {
        log(`⚠️ Gagal parse JSON AI: ${e.message}`, 'warn');
        // Simple fallback
        const parts = text.split(/pengajaran/i);
        sinopsis = parts[0].replace(/sinopsis|:|\*/gi, '').trim();
        if (parts.length > 1) {
             pengajaran = parts[1].replace(/[:\*]/g, '').trim();
        }
    }

    return {
        sinopsis: sinopsis.substring(0, 1000) || 'Tiada sinopsis dijana.',
        pengajaran: pengajaran.substring(0, 500) || 'Tiada pengajaran dijana.'
    };
}

// ─── AINS PUPPETEER AUTOMATION ─────────────────────────
// Helper: get the current active page (fixes detached frame issues after navigations)
async function getActivePage(browser) {
    const pages = await browser.pages();
    // Return the last page (most recently opened/navigated)
    return pages[pages.length - 1];
}

// Helper: safe wait
const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function submitToAINS(article, aiContent) {
    const email = process.env.DELIMA_EMAIL;
    const password = process.env.DELIMA_PASSWORD;

    if (!email || !password) {
        log('❌ Kelayakan DELIMa tidak ditetapkan!', 'error');
        return false;
    }

    log(`🚀 Memulakan penghantaran ke AINS: "${article.title}"`);
    let browser = null;

    try {
        // HEADLESS env var: set to 'true' for cloud/server, 'false' for local debugging
        const isHeadless = process.env.HEADLESS !== 'false';
        log(`🖥️ Mode: ${isHeadless ? 'Headless (Cloud)' : 'Visible (Tempatan)'}`);

        browser = await puppeteer.launch({
            headless: isHeadless,
            defaultViewport: isHeadless ? { width: 1280, height: 900 } : null,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                isHeadless ? '--window-size=1280,900' : '--start-maximized',
                '--disable-blink-features=AutomationControlled'
            ],
            ignoreDefaultArgs: ['--enable-automation']
        });

        let page = (await browser.pages())[0] || await browser.newPage();

        // Extra stealth: remove webdriver flag
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            // Remove Chrome automation indicators
            window.chrome = { runtime: {} };
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            Object.defineProperty(navigator, 'languages', { get: () => ['ms', 'en-US', 'en'] });
        });

        // Step 0: Go to Article, get real URL, scrape Author, take Screenshot
        log(`📍 Menavigasi ke artikel asal untuk mendapatkan butiran penuh dan tangkapan skrin...`);
        try {
            await page.goto(article.googleLink, { waitUntil: 'load', timeout: 30000 });
            await delay(1500); // give it time to fully load and redirect
            
            const realUrl = page.url();
            article.googleLink = realUrl; // Update to the real URL so it gets filled in the form
            log(`📍 Pautan sebenar: ${article.googleLink}`);
            
            // Extract real author from the BHarian page
            const scrapedAuthor = await page.evaluate(() => {
                const authorSelectors = [
                    '.author-name', '.article-author', '.author a', 
                    'meta[name="author"]', 'meta[property="article:author"]',
                    '.byline'
                ];
                for (const sel of authorSelectors) {
                    const el = document.querySelector(sel);
                    if (el) {
                        return (el.content || el.innerText || el.textContent || '').trim();
                    }
                }
                const match = document.body.innerText.match(/Oleh\s+([A-Z][a-zA-Z\s@]+?)(?:\n|-)/i);
                if (match && match[1]) return match[1].trim();
                return null;
            });
            
            if (scrapedAuthor && !scrapedAuthor.toLowerCase().includes('berita harian')) {
                article.author = scrapedAuthor.trim().substring(0, 100);
                log(`✍️ Penulis (scraped): ${article.author}`);
            } else {
                 if (article.author === 'Berita Harian' || !article.author) {
                     article.author = 'Pengarang Berita Harian';
                 }
            }
            
            // Take screenshot for Part 3! 
            const screenshotPath = path.join(__dirname, 'article-screenshot.png');
            await page.screenshot({ path: screenshotPath });
            log(`📸 Tangkapan skrin artikel disimpan untuk Bahagian 3`);
        } catch (e) {
            log(`⚠️ Gagal mengakses artikel asal: ${e.message}`, 'warn');
        }

        // Step 1: Navigate to AINS
        log('📍 Menavigasi ke AINS...');
        await page.goto('https://ains.moe.gov.my/', { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(2000);

        // Re-acquire page after any redirects
        page = await getActivePage(browser);

        // Check for "Ralat!" or "No Authorization"
        const hasError = await page.evaluate(() => {
            return document.body.innerText.includes('Ralat!') || document.body.innerText.includes('No Authorization');
        });

        if (hasError) {
            log('⚠️ Halaman ralat dikesan, cuba muat semula...', 'warn');
            await page.reload({ waitUntil: 'networkidle2' });
            await delay(3000);
            page = await getActivePage(browser);
        }

        // Take a screenshot to see what we're working with
        await page.screenshot({ path: path.join(__dirname, 'step1-ains-home.png') });
        log('📸 Tangkapan skrin halaman utama AINS');

        // Step 2: Click Login button
        log('🔐 Mencari butang Log Masuk...');
        let loginClicked = false;

        // First try: click by evaluating text content (most reliable)
        try {
            loginClicked = await page.evaluate(() => {
                const allElements = document.querySelectorAll('a, button, div[role="button"], span');
                for (const el of allElements) {
                    const text = (el.textContent || '').toLowerCase().trim();
                    const href = (el.getAttribute('href') || '').toLowerCase();
                    if (text.includes('log masuk') || text.includes('login') || text === 'murid' ||
                        href.includes('login') || href.includes('auth') || href.includes('google')) {
                        el.click();
                        return true;
                    }
                }
                return false;
            });
        } catch { }

        if (!loginClicked) {
            // Try common selectors
            const loginSelectors = ['a[href*="login"]', 'a[href*="auth"]', '.btn-login', '[class*="login"]', 'a[href*="google"]'];
            for (const sel of loginSelectors) {
                try {
                    const el = await page.$(sel);
                    if (el) { await el.click(); loginClicked = true; break; }
                } catch { }
            }
        }

        if (loginClicked) log('✅ Butang Log Masuk diklik');
        else log('⚠️ Butang Log Masuk tidak dijumpai, mencuba navigasi terus...', 'warn');

        // Wait for navigation after login click
        await delay(3000);

        // CRITICAL: Re-acquire page reference after login redirect
        page = await getActivePage(browser);
        const currentUrl = page.url();
        log(`📍 URL semasa: ${currentUrl}`);

        // Step 3: Handle Google/DELIMa Authentication
        log('🔑 Mengendalikan pengesahan DELIMa...');

        // Check if we're on a Google login page
        const isGoogleAuth = currentUrl.includes('accounts.google.com') || currentUrl.includes('google.com/o/oauth');

        if (isGoogleAuth) {
            log('🌐 Halaman Google Auth dikesan');

            try {
                // Email input
                await page.waitForSelector('input[type="email"]', { timeout: 15000 });
                await delay(1000);
                await page.click('input[type="email"]');
                await page.type('input[type="email"]', email, { delay: 80 });
                await delay(500);

                // Click Next button
                const nextClicked = await page.evaluate(() => {
                    const buttons = document.querySelectorAll('button, div[role="button"]');
                    for (const btn of buttons) {
                        const text = (btn.textContent || '').toLowerCase();
                        if (text.includes('next') || text.includes('seterusnya') || text.includes('berikutnya')) {
                            btn.click();
                            return true;
                        }
                    }
                    // Try clicking #identifierNext
                    const nextBtn = document.querySelector('#identifierNext');
                    if (nextBtn) { nextBtn.click(); return true; }
                    return false;
                });

                if (!nextClicked) await page.keyboard.press('Enter');
                log('📧 Email dimasukkan');

                await delay(2000);
                // Re-acquire page after possible redirect
                page = await getActivePage(browser);

                // Password input
                await page.waitForSelector('input[type="password"]:not([aria-hidden="true"])', { timeout: 15000 });
                await delay(1000);
                const pwdInput = await page.$('input[type="password"]:not([aria-hidden="true"])');
                if (pwdInput) {
                    await pwdInput.click();
                    await pwdInput.type(password, { delay: 80 });
                }
                await delay(500);

                // Click sign in
                const signInClicked = await page.evaluate(() => {
                    const buttons = document.querySelectorAll('button, div[role="button"]');
                    for (const btn of buttons) {
                        const text = (btn.textContent || '').toLowerCase();
                        if (text.includes('sign in') || text.includes('log masuk') || text.includes('next') || text.includes('seterusnya')) {
                            btn.click();
                            return true;
                        }
                    }
                    const nextBtn = document.querySelector('#passwordNext');
                    if (nextBtn) { nextBtn.click(); return true; }
                    return false;
                });

                if (!signInClicked) await page.keyboard.press('Enter');
                log('🔒 Kata laluan dimasukkan');

                // Wait for auth to complete and redirect back to AINS
                await delay(5000);
                page = await getActivePage(browser);
                log('✅ Pengesahan selesai');

            } catch (err) {
                log(`⚠️ Pengesahan Google: ${err.message}`, 'warn');
                // Wait extra time for manual intervention if needed
                await delay(15000);
                page = await getActivePage(browser);
            }
        } else {
            log('📍 Bukan halaman Google Auth, meneruskan...');
        }

        // Re-acquire page one more time after all auth
        await delay(1500);
        page = await getActivePage(browser);
        const postLoginUrl = page.url();
        log(`📍 URL selepas login: ${postLoginUrl}`);
        await page.screenshot({ path: path.join(__dirname, 'step2-after-login.png') });

        // Step 4: Navigate to add new record
        log('📝 Mencari butang tambah rekod (Bahagian 1)...');
        await delay(2000); 

        // Try to find the button and click it
        const clickResult = await page.evaluate(() => {
            const findAndClick = (selectorsStr, textMatch = null) => {
                const selectors = selectorsStr.split(',').map(s => s.trim());
                for (const sel of selectors) {
                    try {
                        const elements = document.querySelectorAll(sel);
                        for (const el of elements) {
                            if (el.offsetParent === null) continue; // Skip hidden
                            const txt = (el.innerText || el.textContent || '').trim();
                            if (textMatch === null || txt.includes(textMatch)) {
                                el.click();
                                return true;
                            }
                        }
                    } catch (e) {}
                }
                return false;
            };

            // Priority 0: Bottom Nav Plus Button (href="/record/add")
            const bottomPlus = document.querySelector('nav a[href*="record"], a[href*="record/add"]');
            if (bottomPlus && bottomPlus.offsetParent !== null) {
                bottomPlus.click();
                return 'bottom-nav-plus';
            }

            // Priority 1: "AINS+" or "Tambah Rekod"
            if (findAndClick('a, button, .card', 'AINS+')) return 'AINS+ card';
            if (findAndClick('a, button, .card', 'Tambah Rekod')) return 'Tambah Rekod button';
            if (findAndClick('a, button, .card', 'Mula masukkan')) return 'start-now-btn';
            
            // Priority 2: Bottom plus icon (SVG or font-awesome)
            const plusIcon = document.querySelector('i.fa-plus, .fa-plus, svg[class*="icon-plus"]');
            if (plusIcon && plusIcon.offsetParent !== null) {
                const btn = plusIcon.closest('a, button');
                if (btn) { btn.click(); return 'plus-icon-btn'; }
            }

            return null;
        });

        if (clickResult) log(`✅ Butang Tambah diklik via ${clickResult}`);
        else log('⚠️ Butang Tambah tidak dijumpai - meneruskan ke skrin seterusnya', 'warn');

        // Wait and check if URL changed or if form appeared
        await delay(2000);
        page = await getActivePage(browser);
        let url = page.url();
        log(`📍 URL semasa: ${url}`);

        // Take screenshot of the screen where form should be
        await page.screenshot({ path: path.join(__dirname, 'step3-pre-form.png') });

        // WAIT for the form or the "Pilih sumber bacaan" screen
        log('⏳ Menunggu borang atau skrin pilihan...');
        await delay(1500);
        
        // Handle "Pilih sumber bacaan" screen if it appears
        const choiceScreenData = await page.evaluate(() => {
            const text = document.body.innerText;
            const hasChoice = text.includes('Pilih sumber bacaan');
            return { hasChoice };
        });

        if (choiceScreenData.hasChoice) {
            log('📍 Skrin pilihan dikesan, menavigasi ke borang Artikel...');
            
            // Robust click on "Artikel" card
            const clickedArtikel = await page.evaluate(() => {
                // Cari elemen yang teksnya mengandungi 'Artikel' tetapi teksnya tidak terlalu panjang
                const elements = Array.from(document.querySelectorAll('*'));
                let target = null;
                for (const el of elements) {
                    const text = (el.textContent || '').trim();
                    if (text.includes('Artikel') && text.length < 50) {
                        target = el;
                        // Kita mahu elemen yang paling spesifik (leaf-ish)
                    }
                }
                
                if (target) {
                    // Klik pada kad sekiranya ada, jika tidak klik elemen tersebut
                    const clickTarget = target.closest('.card, .MuiCard-root, [role="button"], button') || target;
                    clickTarget.click();
                    return true;
                }
                return false;
            });

            if (clickedArtikel) {
                log('✅ Kad Artikel diklik');
                await delay(1000);
                
                // Click "Seterusnya"
                await page.evaluate(() => {
                    const btns = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
                    const nextBtn = btns.find(b => b.innerText && b.innerText.includes('Seterusnya'));
                    if (nextBtn) nextBtn.click();
                });
                log('✅ Butang Seterusnya diklik');
                await delay(1500);
            } else {
                log('⚠️ Gagal mencari kad Artikel secara automatik', 'warn');
            }
        }

        // WAIT for the ACTUAL form to exist (with longer timeout)
        log('⏳ Menunggu borang input dimuatkan...');
        try {
            // Wait for ANY input or select that looks like a form field
            await page.waitForFunction(() => {
                const inputs = document.querySelectorAll('input, select, textarea');
                return inputs.length > 5; // AINS form has many fields
            }, { timeout: 30000 });
            log('✅ Borang input dikesan');
        } catch (e) {
            log('⚠️ Borang input tidak dikesan selepas 30s, cuba meneruskan sahaja...', 'warn');
        }

        // Step 5: Fill in the form
        log('📋 Mengisi borang NILAM (Pelbagai muka surat)...');
        await page.screenshot({ path: path.join(__dirname, 'step3-form-found.png') });

        let formCompleted = false;
        for (let i = 0; i < 4; i++) {
            stats.currentStep = i + 1;
            
            if (i === 2) {
                log('📸 Melangkau muat naik gambar (Bahagian 3) mengikut tetapan...');
            }

            // Fill visible fields depending on the page index
            await page.evaluate((data, pageIndex) => {
                const isVisible = el => el.offsetParent !== null;

                // 0. Dismiss any error popups "Perhatian"
                const okBtns = Array.from(document.querySelectorAll('button'));
                const okBtn = okBtns.find(b => b.textContent && b.textContent.trim().toUpperCase() === 'OK' && isVisible(b));
                if (okBtn) { okBtn.click(); }
                
                if (pageIndex === 0) {
                    // --- BAHAGIAN 1: Maklumat Bahan ---
                    
                    // 1. Handle Selects
                    const selects = document.querySelectorAll('select');
                    for (const sel of selects) {
                        if (!isVisible(sel)) continue;
                        const labelStr = (sel.closest('label')?.textContent || sel.previousElementSibling?.textContent || '').toLowerCase();
                        const options = Array.from(sel.querySelectorAll('option'));
                        
                        if (!sel.value || sel.value === 'Pilih satu' || sel.value === '') {
                             const lbl = labelStr || '';
                             if (lbl.includes('kategori') || lbl.includes('bahan')) {
                                 const opt = options.find(o => o.textContent.toLowerCase().includes('artikel')) || options[1];
                                 if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); sel.dispatchEvent(new Event('input', { bubbles: true })); }
                             }
                             else if (lbl.includes('bahasa')) {
                                 const myOpt = options.find(o => 
                                     o.textContent.toLowerCase().includes('melayu') || 
                                     o.textContent.toLowerCase().includes('malay') || 
                                     o.textContent.toLowerCase().includes('bm')
                                 );
                                 const opt = myOpt || (options.length > 1 ? options[1] : options[0]);
                                 if (opt) { 
                                     sel.value = opt.value; 
                                     sel.dispatchEvent(new Event('change', { bubbles: true })); 
                                     sel.dispatchEvent(new Event('input', { bubbles: true })); 
                                 }
                             }
                             else if (options.length > 1 && !lbl.includes('pilih')) {
                                 sel.value = options[1].value;
                                 sel.dispatchEvent(new Event('change', { bubbles: true }));
                                 sel.dispatchEvent(new Event('input', { bubbles: true }));
                             }
                        }
                    }
                    
                    // 2. Handle Inputs
                    const fillField = (keywords, value) => {
                        const inputs = document.querySelectorAll('input[type="text"], input:not([type]), input[type="url"], input[type="number"]');
                        for (const input of inputs) {
                            if (!isVisible(input) || input.value) continue;
                            const name = (input.name || '').toLowerCase();
                            const id = (input.id || '').toLowerCase();
                            const placeholder = (input.placeholder || '').toLowerCase();
                            const label = input.closest('label')?.textContent?.toLowerCase() || '';
                            const prevLabel = input.previousElementSibling?.textContent?.toLowerCase() || '';
                            const allText = name + ' ' + id + ' ' + placeholder + ' ' + label + ' ' + prevLabel;

                            for (const kw of keywords) {
                                if (allText.includes(kw)) {
                                    input.focus();
                                    input.value = value;
                                    input.dispatchEvent(new Event('input', { bubbles: true }));
                                    input.dispatchEvent(new Event('change', { bubbles: true }));
                                    return true;
                                }
                            }
                        }
                        return false;
                    };

                    fillField(['tajuk', 'title', 'judul'], data.title);
                    fillField(['penulis', 'author', 'pengarang'], data.author);
                    fillField(['url', 'pautan', 'link', 'alamat'], data.url);
                    fillField(['muka surat', 'pages', 'halaman', 'bilangan'], '1');
                    fillField(['tahun', 'year', 'terbitan'], new Date().getFullYear().toString());
                    fillField(['penerbit', 'publisher'], 'Berita Harian');

                } else if (pageIndex === 1) {
                    // --- BAHAGIAN 2: Rumusan (Sinopsis & Pengajaran) ---
                    
                    const textareas = Array.from(document.querySelectorAll('textarea, input[type="text"]:not([readonly])')).filter(isVisible);
                    
                    if (textareas.length >= 1 && !textareas[0].value) {
                         textareas[0].focus();
                         textareas[0].value = data.sinopsis;
                         textareas[0].dispatchEvent(new Event('input', { bubbles: true }));
                         textareas[0].dispatchEvent(new Event('change', { bubbles: true }));
                    }
                    if (textareas.length >= 2 && !textareas[1].value) {
                         textareas[1].focus();
                         textareas[1].value = data.pengajaran;
                         textareas[1].dispatchEvent(new Event('input', { bubbles: true }));
                         textareas[1].dispatchEvent(new Event('change', { bubbles: true }));
                    }

                    // --- Refined: Give 5 Stars Rating ---
                    // According to debug HTML: Stars are buttons containing .fa-star icons
                    try {
                        const starButtons = Array.from(document.querySelectorAll('button')).filter(btn => {
                            return isVisible(btn) && btn.querySelector('.fa-star');
                        });
                        
                        if (starButtons.length >= 5) {
                            // Click the 5th star button
                            starButtons[4].click();
                            console.log('✅ 5-star rating clicked (button approach)');
                        } else {
                            // Fallback to original logic if buttons not found
                            const radioGroups = {};
                            document.querySelectorAll('input[type="radio"]').forEach(radio => {
                                if (!isVisible(radio)) return;
                                const name = radio.name || 'unknown';
                                if (!radioGroups[name]) radioGroups[name] = [];
                                radioGroups[name].push(radio);
                            });
                            
                            for (const name in radioGroups) {
                                const group = radioGroups[name];
                                if (group.length === 5) {
                                    group.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
                                    group[4].click(); 
                                    break;
                                }
                            }
                        }
                    } catch (e) {
                        console.error('⚠️ Error clicking stars:', e);
                    }
                }
            }, {
                title: article.title,
                author: article.author || 'Berita Harian',
                sinopsis: aiContent.sinopsis,
                pengajaran: aiContent.pengajaran,
                url: article.googleLink
            }, i);
            
            await delay(1000);
            await page.screenshot({ path: path.join(__dirname, `step3-form-page-${i}.png`) });

            // Logic to choose between Next and Submit
            // Strictly Parts 1-3 -> Seterusnya, Part 4 -> Hantar
            const buttonAction = await page.evaluate((pageIndex) => {
                const btns = Array.from(document.querySelectorAll('button, input[type="submit"], a, div[role="button"]'));
                const isVisible = el => el.offsetParent !== null;
                
                const findBtn = (keywords) => btns.find(btn => {
                    if (!isVisible(btn)) return false;
                    const text = (btn.textContent || '').toLowerCase().trim();
                    return keywords.some(kw => text === kw || text.endsWith(kw));
                });

                if (pageIndex < 3) {
                    // Part 1, 2, and 3: Strictly click 'Seterusnya'
                    const nextBtn = findBtn(['seterusnya']);
                    if (nextBtn) { 
                        nextBtn.click(); 
                        return 'next'; 
                    }
                } else {
                    // Part 4 (index 3): Strictly click 'Hantar'
                    const submitBtn = findBtn(['hantar']);
                    if (submitBtn) { 
                        submitBtn.click(); 
                        return 'submit'; 
                    }
                }
                return 'none';
            }, i);

            if (buttonAction === 'submit') {
                log('📤 Borang dihantar (Butang Hantar/Simpan diklik)');
                
                // --- NEW: Handle "Pasti" Confirmation ---
                await delay(1000); // 1. Wait for modal to appear
                const confirmed = await page.evaluate(() => {
                    const btns = Array.from(document.querySelectorAll('button, .swal2-confirm, .btn-primary'));
                    const pastiBtn = btns.find(btn => {
                        const text = (btn.textContent || '').toLowerCase().trim();
                        return text === 'pasti' || text.includes('pasti');
                    });
                    
                    if (pastiBtn && pastiBtn.offsetParent !== null) {
                        pastiBtn.click();
                        return true;
                    }
                    return false;
                });
                
                if (confirmed) {
                    log('✅ Pengesahan "Pasti" diklik.');
                } else {
                    log('⚠️ Butang "Pasti" tidak dijumpai atau tidak diperlukan.', 'warn');
                }
                
                formCompleted = true;
                break;
            } else if (buttonAction === 'next') {
                log(`⏭️ Navigasi ke muka surat seterusnya borang (Muka surat ${i+2})`);
                await delay(1000); // Wait for transition
                continue;
            } else {
                log('⚠️ Tiada butang Seterusnya atau Submit/Simpan dijumpai lagi pada borang.');
                break;
            }
        }
        
        if (!formCompleted) {
             log('⚠️ Tiada pengesahan hantar dicatatkan dari gelung form', 'warn');
        }

        // Wait for potential success/redirect after submission
        await delay(10000);
        page = await getActivePage(browser);

        // ── DAILY LIMIT DETECTION ─────────────────────────────────
        const limitData = await page.evaluate(() => {
            const txt = document.body.innerText.toLowerCase();
            const limitKeywords = [
                'had harian',
                'had rekod',
                'had telah',
                'had anda',
                'had maksimum',
                'melebihi had',
                'telah mencapai had',
                'daily limit',
                'limit reached',
                'rekod harian telah penuh',
                'rekod harian anda telah',
                'tidak boleh menambah',
                'had 30',
                '30 rekod'
            ];
            const hasLimit = limitKeywords.some(kw => txt.includes(kw));
            return { hasLimit, bodySnippet: document.body.innerText.substring(0, 400) };
        });

        if (limitData.hasLimit) {
            log('🚫 [HAD HARIAN] Had 30 rekod sehari telah dicapai! Automasi dijeda sehingga tengah malam.', 'error');
            log(`🚫 Petikan halaman: ${limitData.bodySnippet.substring(0, 200)}`, 'error');
            await browser.close();
            return { success: false, confirmed: false, limitReached: true };
        }

        // ── SUCCESS SCREEN DETECTION ──────────────────────────────
        const successData = await page.evaluate(() => {
            const txt = document.body.innerText.toLowerCase();
            const url = window.location.href.toLowerCase();
            const hasSuccessText = 
                txt.includes('berjaya') ||
                txt.includes('disimpan') ||
                txt.includes('success') ||
                txt.includes('tahniah') ||
                txt.includes('rekod anda telah') ||
                txt.includes('selesai');
            const hasSuccessUrl =
                url.includes('/record/view') ||
                url.includes('/record/detail') ||
                url.includes('/dashboard') ||
                url.includes('/home');
            return { hasSuccessText, hasSuccessUrl, url, bodySnippet: document.body.innerText.substring(0, 300) };
        });

        const submissionConfirmed = successData.hasSuccessText || successData.hasSuccessUrl;

        // Final screenshot (always taken)
        await page.screenshot({ path: path.join(__dirname, 'step4-after-submit.png'), fullPage: true });
        log('📸 Tangkapan skrin akhir disimpan');

        if (submissionConfirmed) {
            log('🎉 Skrin kejayaan dikesan! Penghantaran disahkan.', 'success');
            stats.totalSubmitted++;
            stats.lastSubmission = new Date().toISOString();
            log(`✅ Rekod berjaya diproses: "${article.title}"`, 'success');
        } else {
            log(`🚩 [FAILED] Skrin kejayaan TIDAK dikesan selepas penghantaran! Artikel akan ditandakan sebagai GAGAL.`, 'error');
            log(`🚩 URL semasa: ${successData.url}`, 'error');
            log(`🚩 Petikan halaman: ${successData.bodySnippet.substring(0, 150)}`, 'error');
            stats.errors++;
        }

        await browser.close();
        return { success: submissionConfirmed, confirmed: submissionConfirmed, limitReached: false };

    } catch (err) {
        log(`❌ Gagal menghantar ke AINS: ${err.message}`, 'error');
        stats.errors++;
        if (browser) {
            try {
                const pages = await browser.pages();
                if (pages && pages.length > 0) {
                    const lastPage = pages[pages.length - 1];
                    await lastPage.screenshot({ path: path.join(__dirname, 'error-screenshot.png'), fullPage: true });
                }
                await browser.close();
            } catch (e) { log(`⚠️ Gagal menutup browser: ${e.message}`, 'debug'); }
        }
        stats.currentStep = 0;
        return { success: false, confirmed: false, limitReached: false };
    } finally {
        stats.currentStep = 0;
    }
}

// ─── AUTOMATION LOOP ───────────────────────────────────
async function runOneSubmission() {
    if (!automationRunning) return;

    log('🔄 Memulakan kitaran penghantaran baharu...');

    // 1. Fetch articles
    const articles = await fetchBeritaHarianArticles();
    if (articles.length === 0) {
        log('⚠️ Tiada artikel dijumpai, cuba lagi nanti', 'warn');
        return false;
    }

    // 2. Find a new (non-duplicate) article
    const newArticle = findNewArticle(articles);
    
    if (!newArticle) {
        log('Tidak ada artikel baharu dijumpai.', 'warn');
        return false;
    }
    
    try {
        // 3. Generate AI content
        const aiContent = await generateAIContent(newArticle.title, '');
        
        // Update stats
        stats.currentArticle = { title: newArticle.title, url: newArticle.googleLink };
        log(`📰 Memproses artikel: "${newArticle.title}"`);
        log(`🔗 Pautan: ${newArticle.googleLink}`);

        // Pre-mark as 'pending' so it won't be re-attempted in the same run
        markAsSubmitted({
            url: newArticle.googleLink,
            title: newArticle.title,
            sinopsis: aiContent.sinopsis,
            pengajaran: aiContent.pengajaran
        }, 'pending');

        // 4. Submit to AINS — returns { success, confirmed, limitReached }
        const result = await submitToAINS(newArticle, aiContent);
        const submissionConfirmed = result && result.confirmed;
        const hitDailyLimit = result && result.limitReached;

        if (hitDailyLimit) {
            // Don't mark as failed — un-mark the pending so it can be retried tomorrow
            const submitted = loadSubmitted();
            const idx = submitted.findIndex(a => a.url === newArticle.googleLink || a.title === newArticle.title);
            if (idx !== -1) submitted.splice(idx, 1); // Remove the pending entry so it retries tomorrow
            saveSubmitted(submitted);
            log(`🚫 Had harian dicapai. Artikel "${newArticle.title}" akan dicuba semula esok.`, 'warn');
            return { limitReached: true };
        } else if (submissionConfirmed) {
            log(`✅ [BERJAYA] Rekod "${newArticle.title}" disahkan berjaya dihantar.`, 'success');
            markAsSubmitted({
                url: newArticle.googleLink,
                title: newArticle.title,
                sinopsis: aiContent.sinopsis,
                pengajaran: aiContent.pengajaran
            }, 'success');
        } else {
            log(`🚩 [GAGAL] Rekod "${newArticle.title}" TIDAK disahkan — skrin kejayaan tidak dijumpai.`, 'error');
            markAsSubmitted({
                url: newArticle.googleLink,
                title: newArticle.title,
                sinopsis: aiContent.sinopsis,
                pengajaran: 'GAGAL: Skrin kejayaan tidak dikesan'
            }, 'failed');
            stats.errors++;
        }
    } catch (err) {
        log(`❌ Ralat dikesan: ${err.message}`, 'error');
        stats.errors++;
        
        // Record as failed
        if (newArticle) {
            markAsSubmitted({
                url: newArticle.googleLink,
                title: newArticle.title,
                sinopsis: 'Gagal diproses: ' + err.message,
                pengajaran: '—'
            }, 'failed');
        }
    } finally {
        stats.lastSubmission = new Date().toISOString();
        stats.currentStep = 0;
        stats.currentArticle = null;
    }
    return true;
}

// ─── NEW CONTINUOUS LOOP ───────────────────────────────────
async function runContinuousLoop() {
    while (automationRunning) {
        // Reset daily limit if it's a new day
        resetDailyLimitIfNewDay();

        // If daily limit already reached, sleep until midnight
        if (dailyLimitReached) {
            const msLeft = msUntilMidnight();
            const minsLeft = Math.ceil(msLeft / 60000);
            log(`🌙 Had harian aktif. Menunggu ${minsLeft} minit sehingga tengah malam untuk reset...`, 'warn');
            // Sleep in 5-minute chunks so we can check automationRunning
            const chunkMs = Math.min(300000, msLeft);
            await new Promise(resolve => setTimeout(resolve, chunkMs));
            continue;
        }

        const result = await runOneSubmission();
        if (!automationRunning) break;

        // Check if daily limit was hit during this submission
        if (result && result.limitReached) {
            dailyLimitReached = true;
            dailyLimitDate = getTodayDateStr();
            const msLeft = msUntilMidnight();
            const hrsLeft = (msLeft / 3600000).toFixed(1);
            log(`🚫 Had harian 30 rekod dicapai! Automasi dijeda selama ${hrsLeft} jam sehingga tengah malam.`, 'error');
            continue; // Loop back, will hit the dailyLimitReached check above
        }

        const foundArticle = result && result !== false;

        // If an article was processed, wait briefly (5s) before the next.
        // If no new articles were found, wait for the full interval.
        const intervalMs = parseInt(process.env.SUBMISSION_INTERVAL_MS) || 60000;
        const sleepTime = foundArticle ? 5000 : intervalMs;

        if (foundArticle) {
            log(`✅ Kitaran selesai. Menunggu 5 saat sebelum mula rekod seterusnya...`);
        } else {
            log(`⏳ Menunggu ${Math.floor(sleepTime / 60000)} minit sebelum semakan semula.`);
        }

        await new Promise(resolve => setTimeout(resolve, sleepTime));
    }
}

// ─── API ROUTES ────────────────────────────────────────
app.get('/api/status', (req, res) => {
    const submitted = loadSubmitted();
    const msLeft = dailyLimitReached ? msUntilMidnight() : 0;
    res.json({
        running: automationRunning,
        stats: {
            ...stats,
            totalSubmitted: submitted.filter(a => a.status === 'success').length,
            totalAll: submitted.length
        },
        intervalMs: parseInt(process.env.SUBMISSION_INTERVAL_MS) || 600000,
        dailyLimit: {
            reached: dailyLimitReached,
            date: dailyLimitDate,
            resumesInMs: msLeft,
            resumesInMins: Math.ceil(msLeft / 60000)
        },
        log: activityLog.slice(0, 50)
    });
});

app.post('/api/start', (req, res) => {
    if (automationRunning) {
        return res.json({ success: false, msg: 'Automasi sudah berjalan' });
    }

    automationRunning = true;
    stats.startedAt = new Date().toISOString();
    log('▶️ Automasi Berterusan dimulakan! Memproses rekod satu demi satu...', 'success');

    // Start the continuous loop
    runContinuousLoop();

    res.json({ success: true, msg: `Automasi Berterusan dimulakan!` });
});

app.post('/api/stop', (req, res) => {
    automationRunning = false;
    if (automationInterval) {
        clearInterval(automationInterval);
        automationInterval = null;
    }
    log('⏹️ Automasi dihentikan', 'warn');
    res.json({ success: true, msg: 'Automasi dihentikan' });
});

app.get('/api/history', (req, res) => {
    const submitted = loadSubmitted();
    res.json({ articles: submitted.reverse() });
});

app.post('/api/settings', (req, res) => {
    const { geminiKey, delimaEmail, delimaPassword, intervalMs } = req.body;
    if (geminiKey) process.env.GEMINI_API_KEY = geminiKey;
    if (delimaEmail) process.env.DELIMA_EMAIL = delimaEmail;
    if (delimaPassword) process.env.DELIMA_PASSWORD = delimaPassword;
    if (intervalMs) process.env.SUBMISSION_INTERVAL_MS = intervalMs.toString();
    log('⚙️ Tetapan dikemas kini');
    res.json({ success: true });
});

// ─── START SERVER ──────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('');
    console.log('╔═══════════════════════════════════════════════════╗');
    console.log('║   🌑 Dvrk NILAM AutoM V1.4 - AINS Bot            ║');
    console.log(`║   🌐 Server berjalan di http://localhost:${PORT}      ║`);
    console.log('║   📰 Sumber: Berita Harian (Google News RSS)      ║');
    console.log('║   🧠 AI: Gemini (sinopsis + pengajaran)           ║');
    console.log('╚═══════════════════════════════════════════════════╝');
    console.log('');
    log('🚀 Server dimulakan');
});
