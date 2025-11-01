const puppeteer = require('puppeteer-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const path = require('path');
const os = require('os');
const fs = require('fs');
puppeteer.use(stealth);

async function clickButtonsByText(page, texts = []) {
  // Essaie de cliquer des boutons/links dont le texte correspond à l'un des motifs fournis
  for (const t of texts) {
    const handles = await page.$x(`//button[contains(., "${t}")] | //a[contains(., "${t}")]`);
    for (const h of handles) {
      try {
        await h.click({ delay: 20 });
        await page.waitForTimeout(500);
      } catch (_) {}
    }
  }
}

async function clickInAllFrames(page, selectors = []) {
  for (const frame of page.mainFrame().childFrames()) {
    for (const sel of selectors) {
      try {
        const btn = await frame.$(sel);
        if (btn) { await btn.click({ delay: 20 }); await page.waitForTimeout(300); }
      } catch (_) {}
    }
  }
}

async function clickTextInAllFrames(page, texts = []) {
  for (const frame of page.mainFrame().childFrames()) {
    for (const t of texts) {
      try {
        const handles = await frame.$x(`//button[contains(., "${t}")] | //a[contains(., "${t}")]`);
        for (const h of handles) { await h.click({ delay: 20 }); await page.waitForTimeout(300); }
      } catch (_) {}
    }
  }
}

function parseHumanNumber(raw) {
  if (!raw) return null;
  const s = ('' + raw).trim().replace(/\s/g, '');
  // Remplacer virgule par point si décimale (fr)
  let n = s.replace(',', '.').toLowerCase();
  const m = n.match(/([\d.]+)\s*([kmb])?/i);
  if (!m) {
    const digits = n.replace(/[^\d]/g, '');
    return digits ? Number(digits) : null;
  }
  let value = parseFloat(m[1]);
  const suf = m[2];
  if (suf === 'k') value *= 1e3;
  else if (suf === 'm') value *= 1e6;
  else if (suf === 'b') value *= 1e9;
  return Math.round(value);
}

async function getProfileStatsFromDOM(page) {
  try {
    await page.waitForSelector('[data-e2e="followers-count"], [data-e2e="likes-count"], [data-e2e="following-count"]', { timeout: 15000 });
  } catch (_) {}
  const followersText = await page.$eval('[data-e2e="followers-count"]', el => el.textContent,).catch(() => null);
  const likesText = await page.$eval('[data-e2e="likes-count"]', el => el.textContent,).catch(() => null);
  const followingText = await page.$eval('[data-e2e="following-count"]', el => el.textContent,).catch(() => null);
  // Compter des vignettes chargées (approximation si pas de SIGI)
  const tiles = await page.$$('[data-e2e="user-post-item"]');
  const visibleVideos = tiles?.length ?? null;
  return {
    followers: parseHumanNumber(followersText),
    likes: parseHumanNumber(likesText),
    following: parseHumanNumber(followingText),
    videos: visibleVideos
  };
}

function getProfileStatsFromSIGI(username, sigiState) {
  try {
    const UserModule = sigiState?.UserModule;
    if (!UserModule) return null;
    // Il y a souvent une map uniqueId -> userId dans UserModule.uniqueIdToUserId
    const map = UserModule?.uniqueIdToUserId || {};
    const uid = map[username] || Object.keys(UserModule.users || {})
      .find(k => (UserModule.users[k]?.uniqueId || '').toLowerCase() === username.toLowerCase());
    const user = UserModule.users?.[uid];
    const stats = UserModule.stats?.[uid];
    if (!user && !stats) return null;
    return {
      followers: stats?.followerCount ?? null,
      likes: stats?.heartCount ?? null,
      following: stats?.followingCount ?? null,
      videos: stats?.videoCount ?? null,
      userId: uid || user?.id || null,
      nickname: user?.nickname || null
    };
  } catch (_) {
    return null;
  }
}

async function scrapeTikTokStats(username, opts = {}) {
  // Resolve headless mode (default to headless on servers):
  // - HEADLESS=0 => non-headless (for local debug with a display)
  // - HEADLESS=1/true => headless 'new'
  // - unset => headless 'new'
  const headlessEnv = (process.env.HEADLESS || '').toLowerCase();
  const defaultHeadless = headlessEnv === '0' ? false : 'new';
  const headlessOpt = typeof opts.headless !== 'undefined' ? opts.headless : defaultHeadless;

  // Use a unique writable temp directory for Chromium user data to avoid SingletonLock conflicts
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'puppeteer-profile-'));

  const launchOptions = {
    headless: headlessOpt,
    userDataDir,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote'
    ]
  };

  const browser = await puppeteer.launch(launchOptions);
  const page = await browser.newPage();

  // UA Desktop pour éviter le portail mobile/interstitiels
  const desktopUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';
  await page.setUserAgent(desktopUA);
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7'
  });
  await page.setViewport({ width: 1366, height: 800, deviceScaleFactor: 1 });

  // Petites astuces anti-bot
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // Simuler quelques propriétés de Chrome
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
    Object.defineProperty(navigator, 'language', { get: () => 'fr-FR' });
    Object.defineProperty(navigator, 'languages', { get: () => ['fr-FR','fr','en-US','en'] });
  });

  try {
    const url = `https://www.tiktok.com/@${username}?lang=en`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Fermer/valider les overlays les plus courants (RGPD / interstitiels / "Got it")
    try {
      await clickButtonsByText(page, [
        'Accept all', 'Tout accepter', 'I agree', "J\\'accepte", 'Agree', 'OK', 'Got it',
        'Allow all', 'Continue', 'Reject all', 'Manage options', 'Accept', 'Consent'
      ]);
      await clickTextInAllFrames(page, ['Accept all', 'I agree', 'Got it', 'Continue']);
      await clickInAllFrames(page, [
        'button[aria-label*="Accept"]', 'button[aria-label*="agree"]'
      ]);
    } catch (_) {}

    // Attendre l'injection des données
    let sigiState = null;
    try {
      await page.waitForSelector('script#SIGI_STATE', { timeout: 25000 });
    } catch (_) {
      // Réessaie après un petit scroll pour forcer des chargements
      try { await page.mouse.wheel({ deltaY: 1200 }); } catch (_) {}
      try { await page.waitForSelector('script#SIGI_STATE', { timeout: 20000 }); } catch (_) {}
    }

    // Extraire SIGI_STATE si présent
    sigiState = await page.evaluate(() => {
      const script = document.querySelector('script#SIGI_STATE');
      if (!script) return null;
      try {
        return JSON.parse(script.textContent || '{}');
      } catch (e) {
        return null;
      }
    });

    // Fallback: certaines versions exposent __UNIVERSAL_DATA__ avec ItemList/ItemModule imbriqués
    let universal = null;
    if (!sigiState) {
      universal = await page.evaluate(() => {
        const el = document.querySelector('script#__UNIVERSAL_DATA__');
        if (!el) return null;
        try { return JSON.parse(el.textContent || '{}'); } catch { return null; }
      });
    }

    // Essayer d'obtenir les stats profil
    let profileStats = null;
    if (sigiState) {
      profileStats = getProfileStatsFromSIGI(username, sigiState);
    }
    if (!profileStats) {
      profileStats = await getProfileStatsFromDOM(page);
    }

    // Extraire la liste des vidéos si possible
    let videoIds = [];
    let videos = [];
    if (sigiState && sigiState.ItemList && sigiState.ItemModule) {
      videoIds = sigiState.ItemList['user-post']?.list ?? [];
      videos = videoIds.map(id => {
        const item = sigiState.ItemModule[id] || {};
        return {
          id,
          description: item?.desc ?? null,
          viewCount: item?.stats?.playCount ?? null,
          likeCount: item?.stats?.diggCount ?? null,
          commentCount: item?.stats?.commentCount ?? null,
          shareCount: item?.stats?.shareCount ?? null,
          videoUrl: `https://www.tiktok.com/@${username}/video/${id}`
        };
      });
    }

    const output = {
      username,
      profile: profileStats,
      videosSampleCount: videos.length,
      videos
    };

    return output;
  } finally {
    try { await browser.close(); } catch (_) {}
    // Clean up temp Chromium profile to avoid stale SingletonLock files
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
  }
}

if (require.main === module) {
  const u = process.argv[2] || 'silvustv';
  scrapeTikTokStats(u).then(result => {
    console.dir(result, { depth: null });
  }).catch(err => {
    console.error('Scrape error:', err?.message || err);
    process.exitCode = 1;
  });
}

module.exports = { scrapeTikTokStats };
