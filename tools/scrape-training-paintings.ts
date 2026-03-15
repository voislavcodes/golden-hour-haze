#!/usr/bin/env npx tsx
/**
 * Scrape tonalist/atmospheric paintings from the Met Museum API (CC0 public domain)
 * and WikiArt tonalism page for ML training data.
 *
 * Usage: npx tsx tools/scrape-training-paintings.ts [--max 300] [--output test/clarice/reference]
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';

const MAX_PAINTINGS = parseInt(process.argv.find(a => a.startsWith('--max='))?.split('=')[1] || '300');
const OUTPUT_DIR = process.argv.find(a => a.startsWith('--output='))?.split('=')[1]
  || path.resolve(import.meta.dirname || '.', '../test/clarice/reference');

// --- HTTP helpers ---

function fetchJSON(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'GHH-Training-Scraper/1.0' } }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        return fetchJSON(res.headers.location!).then(resolve, reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`JSON parse failed for ${url}: ${data.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

function downloadFile(url: string, dest: string): Promise<boolean> {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'GHH-Training-Scraper/1.0' } }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
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

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// --- Met Museum API ---

const MET_BASE = 'https://collectionapi.metmuseum.org/public/collection/v1';

const SEARCH_QUERIES = [
  // Tonalism movement
  'tonalism', 'tonalist',
  // Key tonalist artists
  'George+Inness', 'James+McNeill+Whistler', 'Thomas+Wilmer+Dewing',
  'Dwight+Tryon', 'Henry+Ward+Ranger', 'Alexander+Wyant',
  'Ralph+Blakelock', 'Albert+Pinkham+Ryder', 'Granville+Redmond',
  'J+Francis+Murphy+landscape',
  // Atmospheric impressionists
  'Corot+landscape', 'Monet+landscape', 'Sisley+landscape',
  'Pissarro+landscape', 'Boudin+seascape', 'Whistler+nocturne',
  'Turner+landscape', 'Constable+landscape',
  // Hammershøi and Nordic
  'Hammershoi', 'Vilhelm+Hammershoi',
  // Australian tonalists
  'Australian+landscape+painting', 'Streeton+landscape',
  // Subject-based atmospheric searches
  'impressionist+landscape+fog', 'turner+landscape+atmosphere',
  'twilight+landscape+painting', 'nocturne+painting',
  'atmospheric+landscape', 'harbor+mist+painting',
  'figure+fog+painting', 'street+rain+painting',
  'beach+impressionist', 'evening+landscape+painting',
  'misty+morning+landscape', 'dusk+painting+landscape',
  'moonlight+landscape', 'harbor+evening', 'rain+street+scene',
  'grey+day+landscape', 'winter+fog+painting', 'river+morning',
  'coast+mist', 'marsh+landscape', 'meadow+twilight',
  // Barbizon school (tonalism precursors)
  'Barbizon+landscape', 'Millet+landscape', 'Rousseau+landscape',
  'Daubigny+landscape', 'Diaz+landscape',
  // American impressionist landscapes
  'Twachtman+landscape', 'Hassam+landscape', 'Robinson+landscape',
  'Weir+landscape', 'Metcalf+landscape',
];

async function searchMet(): Promise<number[]> {
  const allIds = new Set<number>();

  for (const q of SEARCH_QUERIES) {
    try {
      const result = await fetchJSON(
        `${MET_BASE}/search?q=${q}&medium=Paintings&hasImages=true&isPublicDomain=true`
      );
      if (result.objectIDs) {
        for (const id of result.objectIDs) allIds.add(id);
      }
      console.log(`  Met search "${q}": ${result.total || 0} results`);
      await sleep(50); // respect rate limits
    } catch (e) {
      console.warn(`  Met search "${q}" failed: ${e}`);
    }
  }

  return [...allIds];
}

async function downloadMetPainting(objectId: number, index: number): Promise<boolean> {
  try {
    const obj = await fetchJSON(`${MET_BASE}/objects/${objectId}`);
    if (!obj.primaryImageSmall) return false;

    // Filter: only oil paintings, watercolors, or similar
    const medium = (obj.medium || '').toLowerCase();
    if (!medium.includes('oil') && !medium.includes('watercolor') && !medium.includes('canvas')) {
      return false;
    }

    // Filter: landscape, seascape, cityscape, or atmospheric subjects
    const title = (obj.title || '').toLowerCase();
    const tags = (obj.tags || []).map((t: any) => (t.term || '').toLowerCase()).join(' ');
    const classification = (obj.classification || '').toLowerCase();

    // Hard reject: still life close-ups, small decorative objects
    if (classification.includes('miniature') || classification.includes('textile')) return false;

    // Known tonalist/atmospheric artists — always accept their paintings
    const artist = (obj.artistDisplayName || '').toLowerCase();
    const TONALIST_ARTISTS = [
      'inness', 'whistler', 'dewing', 'tryon', 'ranger', 'murphy', 'wyant',
      'blakelock', 'ryder', 'redmond', 'corot', 'monet', 'sisley', 'pissarro',
      'boudin', 'turner', 'constable', 'hammershoi', 'hammershøi',
      'twachtman', 'hassam', 'robinson', 'weir', 'metcalf',
      'millet', 'rousseau', 'daubigny', 'diaz', 'streeton', 'heysen',
      'homer', 'sargent', 'seurat', 'cézanne', 'cezanne',
    ];
    const isTonalistArtist = TONALIST_ARTISTS.some(a => artist.includes(a));
    if (isTonalistArtist) return true; // trust the artist

    // For non-tonalist artists, accept if oil on canvas — broad net for training data.
    // Non-landscape paintings add diversity; the heuristic pipeline handles any image.
    if (medium.includes('oil on canvas') || medium.includes('oil on panel') ||
        medium.includes('oil on board') || medium.includes('watercolor')) {
      return true;
    }

    return false;

    const ext = obj.primaryImageSmall.includes('.png') ? 'png' : 'jpg';
    const filename = `met-${objectId}.${ext}`;
    const dest = path.join(OUTPUT_DIR, filename);

    if (fs.existsSync(dest)) {
      console.log(`  [${index}] skip ${filename} (exists)`);
      return true;
    }

    // Use small image (suitable for training — 800px or so)
    const ok = await downloadFile(obj.primaryImageSmall, dest);
    if (ok) {
      console.log(`  [${index}] ✓ ${filename} — "${obj.title}" (${obj.artistDisplayName || 'unknown'})`);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// --- Main ---

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // Count existing
  const existing = fs.readdirSync(OUTPUT_DIR).filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f));
  console.log(`Existing reference images: ${existing.length}`);
  console.log(`Target: ${MAX_PAINTINGS} total\n`);

  const needed = MAX_PAINTINGS - existing.length;
  if (needed <= 0) {
    console.log('Already have enough images.');
    return;
  }

  // Search Met Museum
  console.log('Searching Met Museum API...');
  const metIds = await searchMet();
  console.log(`\nFound ${metIds.length} unique Met object IDs\n`);

  // Download
  let downloaded = 0;
  for (let i = 0; i < metIds.length && downloaded < needed; i++) {
    const ok = await downloadMetPainting(metIds[i], i);
    if (ok) downloaded++;
    await sleep(100); // rate limit: ~10/sec
  }

  // Final count
  const final = fs.readdirSync(OUTPUT_DIR).filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f));
  console.log(`\nDone. Total reference images: ${final.length} (${downloaded} new)`);
}

main().catch(console.error);
