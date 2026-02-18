/**
 * BrainsMingle Design System — Figma Variables Export
 * =====================================================
 * Reads all DTCG token JSON files from tokens/ and generates a Figma
 * Variables API payload (POST /v1/files/:file_key/variables).
 *
 * Usage:
 *   node scripts/figma-export.js
 *
 * To push directly to Figma, set env vars and run:
 *   FIGMA_FILE_KEY=<your_file_key> FIGMA_TOKEN=<your_pat> node scripts/figma-export.js
 *   # or:
 *   npm run figma:push
 *
 * Output:
 *   figma-variables-payload.json  — ready to POST to Figma API
 *   figma-tokens-studio.json      — Tokens Studio / VS Code extension format
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const TOKENS_DIR = join(ROOT, 'tokens');

// ── Helpers ────────────────────────────────────────────────────────

/** Recursively read all JSON files from a directory */
function readJsonFiles(dir) {
  const result = {};
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      Object.assign(result, readJsonFiles(full));
    } else if (entry.endsWith('.json')) {
      const data = JSON.parse(readFileSync(full, 'utf8'));
      deepMerge(result, data);
    }
  }
  return result;
}

/** Deep merge objects (b into a) */
function deepMerge(a, b) {
  for (const k of Object.keys(b)) {
    if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object') {
      deepMerge(a[k], b[k]);
    } else {
      a[k] = b[k];
    }
  }
  return a;
}

/** Flatten nested token object into { "path.to.token": { $value, $type, ... } } */
function flattenTokens(obj, prefix = '') {
  const flat = {};
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && '$value' in v) {
      flat[path] = v;
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(flat, flattenTokens(v, path));
    }
  }
  return flat;
}

/** Resolve a {path.to.token} reference to its raw value */
function resolveRef(ref, flatTokens) {
  const match = ref.match(/^\{(.+)\}$/);
  if (!match) return ref; // already a raw value
  const path = match[1];
  const token = flatTokens[path];
  if (!token) return ref; // unresolved — return as-is
  if (typeof token.$value === 'string' && token.$value.startsWith('{')) {
    return resolveRef(token.$value, flatTokens); // chain resolve
  }
  return token.$value;
}

/** Convert hex color string to Figma RGBA {r,g,b,a} (values 0–1) */
function hexToFigmaColor(hex) {
  const clean = hex.replace('#', '');
  if (clean.length === 3) {
    const [r, g, b] = clean.split('').map(c => parseInt(c + c, 16) / 255);
    return { r, g, b, a: 1 };
  }
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const a = clean.length === 8 ? parseInt(clean.slice(6, 8), 16) / 255 : 1;
  return { r: +r.toFixed(4), g: +g.toFixed(4), b: +b.toFixed(4), a };
}

/** Convert token path string to a safe Figma variable ID */
function toVarId(path) {
  return `bm/${path.replace(/\./g, '/')}`;
}

/** Convert DTCG $type to Figma resolvedType */
function toFigmaType(dtcgType) {
  const map = {
    color: 'COLOR',
    dimension: 'FLOAT',
    fontFamily: 'STRING',
    fontWeight: 'FLOAT',
    duration: 'STRING',
    number: 'FLOAT',
    other: 'STRING',
  };
  return map[dtcgType] || 'STRING';
}

/** Convert a dimension string like "12px" or "0.5em" to a float */
function parseDimension(val) {
  if (typeof val === 'number') return val;
  const n = parseFloat(val);
  return isNaN(n) ? 0 : n;
}

// ── Main ───────────────────────────────────────────────────────────

console.log('BrainsMingle → Figma Variables Export\n');

// 1. Load all token files
const allTokens = readJsonFiles(TOKENS_DIR);
const flat = flattenTokens(allTokens);
const allPaths = Object.keys(flat);

console.log(`  Loaded ${allPaths.length} tokens from tokens/`);

// 2. Categorise tokens into collections
//    - Primitives:  color.*, font.*, letterSpacing.*
//    - Semantic:    surface.*, text.*, border.*, icon.*, interactive.*, highlight.*, badge.*, status.*, overlay.*
//    - Components:  button.*, input.*, card.*, badge (component).*, alert.*, checkbox.*, toggle.*, tabs.*, modal.*
const isPrimitive = (p) => p.startsWith('color.') || p.startsWith('font.') || p.startsWith('letter');
const isComponent = (p) => /^(button|input|card|alert|checkbox|toggle|tabs|modal)\./.test(p);
const isSemantic  = (p) => !isPrimitive(p) && !isComponent(p);

// Collection IDs & mode IDs (using short IDs for the payload)
const COLL = {
  primitives: { id: 'bm-coll-primitives', name: 'Primitives',  modes: [{ id: 'bm-mode-default', name: 'Default' }] },
  semantic:   { id: 'bm-coll-semantic',   name: 'Semantic',    modes: [{ id: 'bm-mode-dark', name: 'Dark' }, { id: 'bm-mode-light', name: 'Light' }] },
  components: { id: 'bm-coll-components', name: 'Components',  modes: [{ id: 'bm-mode-comp', name: 'Default' }] },
};

// Build variable collections array
const variableCollections = Object.values(COLL).map(c => ({
  action: 'CREATE',
  id: c.id,
  name: c.name,
  initialModeId: c.modes[0].id,
}));

// Build variable modes array
const variableModes = [];
for (const c of Object.values(COLL)) {
  for (const m of c.modes) {
    variableModes.push({ action: 'CREATE', id: m.id, name: m.name, variableCollectionId: c.id });
  }
}

// 3. Build variables & mode values
const variables = [];
const variableModeValues = [];

for (const [path, token] of Object.entries(flat)) {
  const { $value, $type = 'other', $description, $extensions } = token;
  const figmaType = toFigmaType($type);

  // Determine collection
  let coll, primaryModeId, secondaryModeId;
  if (isPrimitive(path)) {
    coll = COLL.primitives;
    primaryModeId = 'bm-mode-default';
  } else if (isSemantic(path)) {
    coll = COLL.semantic;
    primaryModeId = 'bm-mode-dark';
    secondaryModeId = 'bm-mode-light';
  } else {
    coll = COLL.components;
    primaryModeId = 'bm-mode-comp';
  }

  const varId = toVarId(path);
  const varName = path.replace(/\./g, '/'); // Figma uses "/" for groups

  variables.push({
    action: 'CREATE',
    id: varId,
    name: varName,
    variableCollectionId: coll.id,
    resolvedType: figmaType,
    description: $description || '',
    scopes: figmaType === 'COLOR' ? ['ALL_SCOPES'] : ['ALL_SCOPES'],
    codeSyntax: { WEB: `var(--${path.replace(/\./g, '-')})` },
  });

  // Primary (dark) mode value
  const darkValue = $value;
  variableModeValues.push(
    buildModeValue(varId, primaryModeId, darkValue, figmaType, flat)
  );

  // Light mode value (from $extensions.modes.light if present)
  if (secondaryModeId) {
    const lightRef = $extensions?.modes?.light || $value; // fall back to dark value
    variableModeValues.push(
      buildModeValue(varId, secondaryModeId, lightRef, figmaType, flat)
    );
  }
}

/**
 * Build a variableModeValues entry.
 * If val is a {reference}, emits a VARIABLE_ALIAS; otherwise resolves to literal.
 */
function buildModeValue(varId, modeId, val, figmaType, flatTokens) {
  const entry = { variableId: varId, modeId };

  // Check if val is a reference
  const refMatch = typeof val === 'string' && val.match(/^\{(.+)\}$/);
  if (refMatch) {
    const refPath = refMatch[1];
    const refVarId = toVarId(refPath);
    // Check the ref variable exists in our token set
    if (flatTokens[refPath]) {
      entry.value = { type: 'VARIABLE_ALIAS', id: refVarId };
      return entry;
    }
    // Not found — resolve to literal
    val = resolveRef(val, flatTokens);
  }

  // Build literal value
  if (figmaType === 'COLOR') {
    const rawHex = typeof val === 'string' && val.startsWith('#') ? val : resolveRef(val, flatTokens);
    if (rawHex && rawHex.startsWith('#')) {
      entry.value = hexToFigmaColor(rawHex);
    } else {
      entry.value = { r: 1, g: 0, b: 1, a: 1 }; // magenta = unresolved
    }
  } else if (figmaType === 'FLOAT') {
    entry.value = parseDimension(val);
  } else {
    entry.value = String(val);
  }

  return entry;
}

// 4. Assemble final payload
const payload = {
  variableCollections,
  variableModes,
  variables,
  variableModeValues,
};

// 5. Write Figma payload JSON
const payloadPath = join(ROOT, 'figma-variables-payload.json');
writeFileSync(payloadPath, JSON.stringify(payload, null, 2));
console.log(`\n  ✓ Figma Variables payload → figma-variables-payload.json`);
console.log(`    Collections: ${variableCollections.length}`);
console.log(`    Modes:       ${variableModes.length}`);
console.log(`    Variables:   ${variables.length}`);
console.log(`    Mode values: ${variableModeValues.length}`);

// 6. Write Tokens Studio / VS Code extension format
const tokensStudio = buildTokensStudio(flat);
const tsPath = join(ROOT, 'figma-tokens-studio.json');
writeFileSync(tsPath, JSON.stringify(tokensStudio, null, 2));
console.log(`  ✓ Tokens Studio JSON        → figma-tokens-studio.json`);

// 7. Optionally push to Figma API
const FIGMA_FILE_KEY = process.env.FIGMA_FILE_KEY;
const FIGMA_TOKEN    = process.env.FIGMA_TOKEN;
const FIGMA_PUSH     = process.env.FIGMA_PUSH === 'true';

if (FIGMA_PUSH && FIGMA_FILE_KEY && FIGMA_TOKEN) {
  console.log(`\n  Pushing to Figma file: ${FIGMA_FILE_KEY} …`);
  await pushToFigma(FIGMA_FILE_KEY, FIGMA_TOKEN, payload);
} else if (FIGMA_PUSH) {
  console.warn('\n  ⚠ FIGMA_PUSH=true but FIGMA_FILE_KEY or FIGMA_TOKEN not set.');
  console.warn('  Set both env vars to push: FIGMA_FILE_KEY=xxx FIGMA_TOKEN=yyy npm run figma:push');
} else {
  console.log('\n  To push to Figma:');
  console.log('  FIGMA_FILE_KEY=<key> FIGMA_TOKEN=<pat> npm run figma:push');
}

console.log('\nDone.\n');

// ── Figma API push ─────────────────────────────────────────────────

async function pushToFigma(fileKey, token, body) {
  const url = `https://api.figma.com/v1/files/${fileKey}/variables`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-FIGMA-TOKEN': token,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error('  ✗ Network error:', err.message);
    process.exit(1);
  }

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }

  if (res.ok) {
    console.log('  ✓ Pushed successfully!');
    console.log('  Figma response:', JSON.stringify(json, null, 2).slice(0, 400));
  } else {
    console.error(`  ✗ Figma API error (${res.status}):`, JSON.stringify(json, null, 2).slice(0, 600));
    process.exit(1);
  }
}

// ── Tokens Studio format builder ───────────────────────────────────

/**
 * Builds a Tokens Studio compatible JSON:
 * { "global": { "color": { "neutral": { "50": { "value": "#...", "type": "color" } } } } }
 * Each collection gets a separate key.
 */
function buildTokensStudio(flat) {
  const primitives = {};
  const semantic   = {};
  const components = {};

  for (const [path, token] of Object.entries(flat)) {
    const { $value, $type = 'other', $description, $extensions } = token;
    const parts = path.split('.');
    const tsToken = {
      value: $value,
      type: $type === 'dimension' ? 'sizing' : $type === 'fontWeight' ? 'fontWeights' : $type,
    };
    if ($description) tsToken.description = $description;

    let target;
    if (isPrimitive(path))  target = primitives;
    else if (isSemantic(path)) target = semantic;
    else                    target = components;

    // Build nested object from dotted path
    let cur = target;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!cur[parts[i]]) cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = tsToken;

    // Add light mode as a separate value if present
    if ($extensions?.modes?.light) {
      const lightParts = [...parts];
      lightParts[lightParts.length - 1] += '-light';
      let lightCur = semantic;
      for (let i = 0; i < lightParts.length - 1; i++) {
        if (!lightCur[lightParts[i]]) lightCur[lightParts[i]] = {};
        lightCur = lightCur[lightParts[i]];
      }
      lightCur[lightParts[lightParts.length - 1]] = {
        value: $extensions.modes.light,
        type: tsToken.type,
        description: ($description || '') + ' [light mode]',
      };
    }
  }

  return {
    $metadata: {
      tokenSetOrder: ['primitives', 'semantic', 'components'],
    },
    primitives,
    semantic,
    components,
  };
}
