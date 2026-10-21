import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { JSDOM } from 'jsdom'
import { EXTRACT_SCRIPT, parseExtracted } from '../lib/extract.js'
import { candidatesFromExtracted, groupOutlineOf } from '../lib/task.js'

function extractFromHtml(html, url) {
  const dom = new JSDOM(html, { url, pretendToBeVisual: true })
  const { window } = dom
  window.Element.prototype.getBoundingClientRect = () => ({
    width: 100, height: 24, top: 10, left: 10, right: 110, bottom: 34, x: 10, y: 10,
    toJSON() {},
  })
  window.document.elementFromPoint = () => null
  Object.defineProperty(window.Element.prototype, 'innerText', {
    get() { return this.textContent }, configurable: true,
  })
  const run = new Function('document', 'innerWidth', 'innerHeight', 'getComputedStyle', 'location', `return ${EXTRACT_SCRIPT}`)
  const execute = () => parseExtracted(run(
    window.document,
    1024,
    768,
    window.getComputedStyle.bind(window),
    window.location,
  ))
  execute()
  const samples = []
  let page
  for (let index = 0; index < 20; index += 1) {
    const started = performance.now()
    page = execute()
    samples.push(performance.now() - started)
  }
  samples.sort((left, right) => left - right)
  dom.window.close()
  return { page, medianExtractMs: Number(samples[Math.floor(samples.length / 2)].toFixed(2)) }
}

function legacyItems(items) {
  return items.map(({ inputType, autocomplete, groupId, groupLabel, formId, ...item }) => item)
}

function summarize(name, page, medianExtractMs) {
  const goal = ''
  const baseline = candidatesFromExtracted(legacyItems(page.items), goal)
  const optimized = candidatesFromExtracted(page.items, goal)
  const baselineSnapshot = baseline
    .map((candidate) => `${candidate.role ?? ''} ${candidate.name ?? ''}${candidate.state ? `（${candidate.state}）` : ''}`.trim())
    .join('\n')
  const outline = groupOutlineOf(optimized)
  const baselineOptions = JSON.stringify(Object.fromEntries(baseline.slice(0, 10).map((candidate) => [candidate.id, candidate.description])))
  const optimizedOptions = JSON.stringify(Object.fromEntries(optimized.slice(0, 10).map((candidate) => [candidate.id, candidate.description])))
  const baselineChars = baselineSnapshot.length + baselineOptions.length
  const optimizedChars = outline.length + optimizedOptions.length
  const uniqueGroups = new Set(optimized.map((candidate) => candidate.groupId).filter(Boolean)).size
  return {
    fixture: name,
    extractedItems: page.items.length,
    truncated: page.truncated === true,
    candidatePool: { structuralMetadataDisabled: baseline.length, optimized: optimized.length },
    distinctGroupsInOptimizedPool: uniqueGroups,
    first10StructuralMetadataDisabled: baseline.slice(0, 10).map((candidate) => `${candidate.id} ${candidate.role ?? ''} ${candidate.name ?? ''}`.trim()),
    first10Optimized: optimized.slice(0, 10).map((candidate) =>
      `${candidate.id} ${candidate.role ?? ''}${candidate.groupRole === undefined ? '' : `/${candidate.groupRole}`} ${candidate.name ?? ''} [${candidate.groupId ?? candidate.formId ?? '-'}]`.trim(),
    ),
    baselineSnapshotChars: baselineSnapshot.length,
    groupedSnapshotChars: outline.length,
    optionsCharsStructuralMetadataDisabled: baselineOptions.length,
    optionsCharsOptimized: optimizedOptions.length,
    snapshotPlusOptionsChars: {
      structuralMetadataDisabled: baselineChars,
      optimized: optimizedChars,
      reductionPercent: baselineChars === 0 ? 0 : Number(((1 - optimizedChars / baselineChars) * 100).toFixed(1)),
    },
    groupedOutline: outline,
    medianExtractScriptMsInJSDOM: medianExtractMs,
  }
}

const fixtureFiles = [
  ['login.html', new URL('../bench/fixtures/login.html', import.meta.url)],
  ['dense.html', new URL('../bench/fixtures/dense.html', import.meta.url)],
]
const results = []
for (const [name, url] of fixtureFiles) {
  const html = await readFile(url, 'utf8')
  const { page, medianExtractMs } = extractFromHtml(html, `https://probe.test/${name}`)
  results.push(summarize(name, page, medianExtractMs))
}

const repeatedRows = Array.from({ length: 20 }, (_, row) =>
  `<li><a href="#r${row}">Record ${row}</a><button>Edit</button><button>Delete</button></li>`,
).join('')
const repeatedHtml = `<main><ul>${repeatedRows}</ul></main>`
const repeated = extractFromHtml(repeatedHtml, 'https://probe.test/repeated-rows')
results.push(summarize('synthetic-repeated-rows.html', repeated.page, repeated.medianExtractMs))

const fillerInputs = Array.from({ length: 320 }, (_, index) => `<input type="text" aria-label="Field ${index}">`).join('')
const credentialForm = '<form id="credentials"><input type="text" autocomplete="username" aria-label="Compte">' +
  '<input type="password" autocomplete="current-password" aria-label="Secret"><button type="submit">Envoyer</button></form>'
const largeInputPage = extractFromHtml(`<main><div>${fillerInputs}</div>${credentialForm}</main>`, 'https://probe.test/many-inputs')
results.push(summarize('synthetic-320-inputs-plus-credentials.html', largeInputPage.page, largeInputPage.medianExtractMs))

console.log(JSON.stringify({
  mode: 'offline first-round probe',
  comparison: 'structural metadata disabled vs enabled on identical extracted items; not a source-control revision benchmark',
  timingScope: 'JSDOM script execution only; not a real-browser latency benchmark',
  results,
}, null, 2))
