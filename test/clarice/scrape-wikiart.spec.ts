// Scrape WikiArt tonalism paintings via Playwright (handles client-side rendering).
// Downloads thumbnail images to test/clarice/reference/
// Run: npx playwright test test/clarice/scrape-wikiart.spec.ts --project=clarice

import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(__dirname, 'reference');

function downloadFile(url: string, dest: string): Promise<boolean> {
  return new Promise((resolve) => {
    const finalUrl = url.startsWith('//') ? 'https:' + url : url;
    https.get(finalUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadFile(res.headers.location!, dest).then(resolve);
      }
      if (res.statusCode !== 200) { resolve(false); return; }
      const ws = fs.createWriteStream(dest);
      res.pipe(ws);
      ws.on('finish', () => { ws.close(); resolve(true); });
      ws.on('error', () => resolve(false));
    }).on('error', () => resolve(false));
  });
}

// WikiArt style pages to scrape
const STYLE_PAGES = [
  'https://www.wikiart.org/en/paintings-by-style/tonalism',
  'https://www.wikiart.org/en/paintings-by-style/tonalism/2',
  'https://www.wikiart.org/en/paintings-by-style/tonalism/3',
];

// WikiArt artist pages for key tonalist painters
const ARTIST_PAGES = [
  'https://www.wikiart.org/en/george-inness/all-works/text-list',
  'https://www.wikiart.org/en/james-mcneill-whistler/all-works/text-list',
  'https://www.wikiart.org/en/ralph-blakelock/all-works/text-list',
  'https://www.wikiart.org/en/granville-redmond/all-works/text-list',
  'https://www.wikiart.org/en/alexander-helwig-wyant/all-works/text-list',
  'https://www.wikiart.org/en/vilhelm-hammershoi/all-works/text-list',
  'https://www.wikiart.org/en/dwight-william-tryon/all-works/text-list',
];

test('scrape WikiArt tonalism paintings', async ({ page }) => {
  test.setTimeout(300_000);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  let totalDownloaded = 0;
  const MAX_PER_PAGE = 40;
  const MAX_TOTAL = 200;

  // Scrape style pages
  for (const styleUrl of STYLE_PAGES) {
    if (totalDownloaded >= MAX_TOTAL) break;
    console.log(`\nScraping: ${styleUrl}`);

    try {
      await page.goto(styleUrl, { waitUntil: 'networkidle', timeout: 30_000 });
      await page.waitForTimeout(3000); // wait for lazy-loaded images

      // Extract image URLs from the painting grid
      const images = await page.evaluate(() => {
        const results: { src: string; title: string }[] = [];
        // WikiArt uses various image containers
        document.querySelectorAll('img').forEach(img => {
          const src = img.src || img.getAttribute('data-src') || '';
          if (src.includes('uploads') && (src.includes('!Large') || src.includes('!PinterestSmall') || src.includes('!Blog'))) {
            const title = img.alt || img.title || 'unknown';
            results.push({ src, title });
          }
        });
        // Also check background-image in painting tiles
        document.querySelectorAll('[style*="background-image"]').forEach(el => {
          const style = (el as HTMLElement).style.backgroundImage;
          const match = style.match(/url\("?([^"]+)"?\)/);
          if (match && match[1].includes('uploads')) {
            results.push({ src: match[1], title: (el as HTMLElement).title || 'unknown' });
          }
        });
        return results;
      });

      console.log(`  Found ${images.length} images`);

      for (const img of images.slice(0, MAX_PER_PAGE)) {
        if (totalDownloaded >= MAX_TOTAL) break;
        const slug = img.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
        const filename = `wikiart-${slug}.jpg`;
        const dest = path.join(OUTPUT_DIR, filename);
        if (fs.existsSync(dest)) continue;

        const ok = await downloadFile(img.src, dest);
        if (ok) {
          // Verify it's a valid image (> 5KB)
          const stat = fs.statSync(dest);
          if (stat.size < 5000) { fs.unlinkSync(dest); continue; }
          console.log(`  ✓ ${filename}`);
          totalDownloaded++;
        }
      }
    } catch (e) {
      console.warn(`  Failed: ${e}`);
    }
  }

  // Scrape artist pages — get painting links, then thumbnails
  for (const artistUrl of ARTIST_PAGES) {
    if (totalDownloaded >= MAX_TOTAL) break;
    console.log(`\nScraping artist: ${artistUrl}`);

    try {
      await page.goto(artistUrl, { waitUntil: 'networkidle', timeout: 30_000 });
      await page.waitForTimeout(2000);

      // Get painting page links from text list
      const paintingLinks = await page.evaluate(() => {
        const links: string[] = [];
        document.querySelectorAll('a[href*="/en/"]').forEach(a => {
          const href = (a as HTMLAnchorElement).href;
          if (href && !href.includes('/all-works') && !href.includes('/mode/') &&
              !href.includes('#') && href.split('/').length >= 5) {
            links.push(href);
          }
        });
        return [...new Set(links)].slice(0, 30); // limit per artist
      });

      console.log(`  Found ${paintingLinks.length} painting links`);

      for (const link of paintingLinks.slice(0, 15)) {
        if (totalDownloaded >= MAX_TOTAL) break;
        try {
          await page.goto(link, { waitUntil: 'networkidle', timeout: 15_000 });
          await page.waitForTimeout(1000);

          const imgInfo = await page.evaluate(() => {
            // Look for the main painting image
            const img = document.querySelector('img[itemprop="image"]') ||
                       document.querySelector('.wiki-layout-artist-image-wrapper img') ||
                       document.querySelector('img.artwork-image');
            if (!img) return null;
            return {
              src: (img as HTMLImageElement).src || (img as HTMLImageElement).getAttribute('data-src') || '',
              title: (img as HTMLImageElement).alt || document.title || 'unknown',
            };
          });

          if (imgInfo && imgInfo.src && imgInfo.src.includes('uploads')) {
            const slug = imgInfo.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
            const filename = `wikiart-${slug}.jpg`;
            const dest = path.join(OUTPUT_DIR, filename);
            if (!fs.existsSync(dest)) {
              const ok = await downloadFile(imgInfo.src, dest);
              if (ok) {
                const stat = fs.statSync(dest);
                if (stat.size < 5000) { fs.unlinkSync(dest); }
                else { console.log(`  ✓ ${filename}`); totalDownloaded++; }
              }
            }
          }
        } catch { /* skip individual painting errors */ }
      }
    } catch (e) {
      console.warn(`  Failed: ${e}`);
    }
  }

  console.log(`\nTotal downloaded: ${totalDownloaded}`);
  const total = fs.readdirSync(OUTPUT_DIR).filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f)).length;
  console.log(`Total reference images: ${total}`);
});
