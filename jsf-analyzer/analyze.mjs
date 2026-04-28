#!/usr/bin/env node
/**
 * jsf-analyzer — JSF/XHTML page analyzer
 *
 * Scans a directory of JSF XHTML pages, extracts per-page:
 *   - screen title / i18n key
 *   - page URL (from breadcrumb h:link outcome, or derived from file path)
 *   - managed beans used, with property and method lists
 *
 * Correlates bean usage with OpenAPI endpoints (heuristic token matching).
 *
 * Deluxe (--wsdl): scans WSDL files (following xsd:import chains),
 * builds a type registry, and enriches endpoint schemas with field definitions.
 *
 * Supports incremental runs — already-processed files are cached by MD5
 * checksum and skipped unless the file changes.
 *
 * Usage:
 *   node analyze.mjs --pages <dir>
 *                   [--openapi <file>]   default: openapi.yaml next to this script
 *                   [--wsdl   <dir>]     enable WSDL type enrichment (deluxe)
 *                   [--out    <dir>]     output directory  (default: ./jsf-analysis-output)
 *                   [--dry-run]          preview without writing files
 *
 * Environment:
 *   DEBUG=1   print full stack traces on errors
 *
 * Requirements: node >= 20, npm install
 */

import { readdir, readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync }                           from 'fs'
import { join, basename, dirname, relative, resolve, isAbsolute } from 'path'
import { createHash }                           from 'crypto'
import { fileURLToPath }                        from 'url'

const __dir = fileURLToPath(new URL('.', import.meta.url))
const DEBUG = process.env.DEBUG === '1'

// ─── CLI ──────────────────────────────────────────────────────────────────────

const USAGE = `
Usage:
  node analyze.mjs --pages <dir>
                  [--openapi <file>]
                  [--wsdl   <dir>]
                  [--out    <dir>]
                  [--dry-run]

  --pages    Directory containing .xhtml page files (scanned recursively)
  --openapi  OpenAPI YAML/JSON spec  (default: openapi.yaml next to this script)
  --wsdl     Directory to scan for .wsdl files — adds field types to endpoints
  --out      Output directory        (default: ./jsf-analysis-output)
  --dry-run  Print what would happen without writing output

  DEBUG=1  print stack traces on errors
`.trim()

function parseArgs(argv) {
  const a = {}
  for (let i = 0; i < argv.length; i++) {
    const cur = argv[i]
    if (cur === '--dry-run' || cur === '--dryRun') { a.dryRun = true; continue }
    if (cur === '--help' || cur === '-h') { console.log(USAGE); process.exit(0) }
    if (cur.startsWith('--') && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      a[cur.slice(2)] = argv[++i]
    }
  }
  return a
}

const args = parseArgs(process.argv.slice(2))

if (!args.pages) {
  console.error('Error: --pages is required\n')
  console.error(USAGE)
  process.exit(1)
}

function absPath(p) {
  return isAbsolute(p) ? p : resolve(process.cwd(), p)
}

const pagesDir = absPath(args.pages)
const outDir   = absPath(args.out ?? 'jsf-analysis-output')
const wsdlDir  = args.wsdl ? absPath(args.wsdl) : null
const dryRun   = args.dryRun ?? false

const STATE_FILE  = join(outDir, 'state.json')
const OUTPUT_FILE = join(outDir, 'analysis.json')

// ─── YAML loader ──────────────────────────────────────────────────────────────

let yamlLoad = null
try {
  yamlLoad = (await import('js-yaml')).load
} catch {
  // Will fail later with a clear message if YAML parsing is actually needed
}

function parseSpec(content, filePath) {
  if (filePath.endsWith('.json')) return JSON.parse(content)
  if (!yamlLoad) {
    throw new Error(
      'js-yaml is not installed.\n' +
      'Run: npm install   (inside the jsf-analyzer directory)'
    )
  }
  return yamlLoad(content)
}

// ─── File utilities ───────────────────────────────────────────────────────────

function md5(content) {
  return createHash('md5').update(content).digest('hex')
}

async function findFiles(dir, ext) {
  const results = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (err) {
    throw new Error(`Cannot read directory "${dir}": ${err.message}`)
  }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) results.push(...await findFiles(full, ext))
    else if (e.isFile() && e.name.toLowerCase().endsWith(ext)) results.push(full)
  }
  return results
}

// ─── State / resume ───────────────────────────────────────────────────────────

async function loadState() {
  if (!existsSync(STATE_FILE)) return { pages: {} }
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8'))
  } catch {
    console.warn('  Warning: could not read state.json — starting fresh')
    return { pages: {} }
  }
}

async function saveState(state) {
  if (dryRun) return
  await mkdir(outDir, { recursive: true })
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8')
}

// ─── OpenAPI parsing ──────────────────────────────────────────────────────────

function buildEndpointData(spec) {
  const endpoints = []
  const byName    = {}
  const byId      = {}

  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    if (typeof pathItem !== 'object') continue
    for (const [method, op] of Object.entries(pathItem)) {
      if (!['get', 'post', 'put', 'delete', 'patch', 'head', 'options'].includes(method)) continue
      if (typeof op !== 'object' || !op) continue

      const opId   = op.operationId ?? `${method}:${path}`
      // strip service prefix: mobiCorePWWWAdmin_pauseBatch → pauseBatch
      const opName = opId.includes('_') ? opId.slice(opId.indexOf('_') + 1) : opId

      const reqRef  = op.requestBody?.content?.['application/json']?.schema?.['$ref'] ?? null
      const respRef = op.responses?.[200]?.content?.['application/json']?.schema?.['$ref'] ?? null

      const e = {
        path,
        method,
        operationId:        opId,
        operationName:      opName,
        summary:            op.summary ?? opName,
        tags:               op.tags ?? [],
        requestSchemaRef:   reqRef,
        responseSchemaRef:  respRef,
        requestSchemaName:  reqRef?.split('/').pop()  ?? null,
        responseSchemaName: respRef?.split('/').pop() ?? null,
      }

      endpoints.push(e)
      if (!byName[opName]) byName[opName] = e
      byId[opId] = e
    }
  }

  return { endpoints, byName, byId }
}

function buildSchemaMap(spec) {
  return spec.components?.schemas ?? {}
}

function findOpenapiFile(explicit) {
  if (explicit) return absPath(explicit)
  for (const name of ['openapi.yaml', 'openapi.yml', 'openapi.json']) {
    const p = join(__dir, name)
    if (existsSync(p)) return p
  }
  return null
}

// ─── XHTML analysis ───────────────────────────────────────────────────────────

// Well-known infrastructure/cross-cutting beans to flag (but still include)
const INFRA_BEANS = new Set([
  'labels', 'rolesBean', 'dictionaryBean', 'facesContext',
  'flash', 'request', 'session', 'application', 'param',
  'header', 'cookie', 'resource', 'view', 'component', 'flash',
])

function extractTitle(content) {
  // <ui:define name="title">TEXT</ui:define>  (whitespace before > allowed)
  const m = content.match(/<ui:define\s+name=["']title["'][^>]*>([\s\S]*?)<\/ui:define>/)
  if (!m) return { title: null, titleKey: null }

  const raw = m[1].trim()

  // i18n: #{labels.getLabel('some_key')}  or  #{labels.getLabel("some_key")}
  const keyMatch = raw.match(/labels\.getLabel\(['"]([^'"]+)['"]\)/)
  if (keyMatch) return { title: null, titleKey: keyMatch[1] }

  // Static text — strip any remaining EL, collapse whitespace
  const text = raw.replace(/#\{[^}]+\}/g, '').replace(/\s+/g, ' ').trim()
  return { title: text || null, titleKey: null }
}

function extractBreadcrumbUrl(content) {
  // First absolute outcome in the breadcrumbs block
  // Breadcrumbs are defined in <ui:define name="breadcrumbs">
  const bcBlock = content.match(/<ui:define\s+name=["']breadcrumbs["'][^>]*>([\s\S]*?)<\/ui:define>/)
  const searchIn = bcBlock ? bcBlock[1] : content
  const m = searchIn.match(/outcome=["'](\/[^"']+)["']/)
  return m ? m[1] : null
}

function extractLoopVars(content) {
  const vars = new Set()
  const re = /\bvar=["'](\w+)["']/g
  let m
  while ((m = re.exec(content)) !== null) vars.add(m[1])
  return vars
}

// JSF attributes that carry zero-arg method references (no () in the EL)
const METHOD_REF_ATTRS = new Set([
  'action', 'actionListener', 'validator', 'converter', 'binding',
  'ajaxListener', 'listener',
])

function extractBeans(content, loopVars) {
  const beanMap = new Map() // name → { props: Set, methods: Set }

  function ensure(name) {
    if (!beanMap.has(name)) beanMap.set(name, { props: new Set(), methods: new Set() })
    return beanMap.get(name)
  }

  // ── Pass 1: general EL expressions ───────────────────────────────────────
  // Pull out all #{...} EL expressions from the content
  const elRe = /#\{([^}]+)\}/g
  let elMatch
  while ((elMatch = elRe.exec(content)) !== null) {
    const el = elMatch[1]

    // Within each EL expression, find every top-level bean.member reference.
    // Negative lookbehind (?<![.\w]) ensures we only capture the START of a
    // property chain (batchBean.currentBatch.key → only batchBean.currentBatch).
    // \w{2,} skips single-character loop variables like 'g', 'j', 'i'.
    const memberRe = /(?<![.\w])(\w{2,})\.(\w+)\s*(\()?/g
    let mm
    while ((mm = memberRe.exec(el)) !== null) {
      const [, name, member, paren] = mm

      if (loopVars.has(name)) continue  // loop iteration variable
      if (/^\d/.test(name))   continue  // starts with digit

      const bean = ensure(name)
      if (paren === '(') bean.methods.add(member)
      else               bean.props.add(member)
    }
  }

  // ── Pass 2: zero-arg method references in action/actionListener attrs ────
  // In JSF, action="#{bean.method}" is a MethodExpression (not a property).
  // These appear without () so Pass 1 classifies them as properties — fix that.
  const attrRe = /\b(\w+)\s*=\s*["']#\{(\w{2,})\.(\w+)\}["']/g
  let am
  while ((am = attrRe.exec(content)) !== null) {
    const [, attr, name, member] = am
    if (!METHOD_REF_ATTRS.has(attr)) continue
    if (loopVars.has(name)) continue

    const bean = ensure(name)
    bean.methods.add(member)
    bean.props.delete(member)  // promote: remove from props if mistakenly added there
  }

  return beanMap
}

// Split camelCase/PascalCase/snake_case into lowercase tokens of length >= 2
function tokenize(str) {
  return str
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')   // ABCDef → ABC_Def
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')         // camelCase → camel_Case
    .replace(/[-_\s]+/g, '_')
    .split('_')
    .filter(t => t.length >= 2)
    .map(t => t.toLowerCase())
}

function matchEndpoints(beanName, methods, endpoints) {
  const core    = beanName.replace(/Bean$|Controller$|Manager$|Service$|Handler$/, '')
  const bTokens = tokenize(core)
  if (bTokens.length === 0) return []

  const scored = []

  for (const ep of endpoints) {
    const eTokens = tokenize(ep.operationName)

    // Count how many bean tokens appear in the operation name
    const overlap = bTokens.filter(bt => eTokens.includes(bt)).length
    if (overlap === 0) continue

    // Bonus point when a method name token also appears in the operation name
    const methodBonus = methods.some(meth => {
      return tokenize(meth).some(mt => eTokens.includes(mt))
    }) ? 1 : 0

    scored.push({
      operationName: ep.operationName,
      path:          ep.path,
      method:        ep.method,
      operationId:   ep.operationId,
      summary:       ep.summary,
      matchScore:    overlap * 2 + methodBonus,
    })
  }

  // Return top 8 candidates, best first
  return scored.sort((a, b) => b.matchScore - a.matchScore).slice(0, 8)
}

function analyzePage(content, filePath, endpoints) {
  const relPath  = relative(pagesDir, filePath).replace(/\\/g, '/')
  const { title, titleKey } = extractTitle(content)
  const bcUrl    = extractBreadcrumbUrl(content)
  const loopVars = extractLoopVars(content)
  const beanMap  = extractBeans(content, loopVars)

  const beans = []
  for (const [name, { props, methods }] of beanMap.entries()) {
    beans.push({
      name,
      isInfraBean:      INFRA_BEANS.has(name),
      properties:       [...props].sort(),
      methods:          [...methods].sort(),
      matchedEndpoints: matchEndpoints(name, [...methods], endpoints),
    })
  }
  beans.sort((a, b) => a.name.localeCompare(b.name))

  return {
    relativePath: relPath,
    filePath,
    title,
    titleKey,
    url:       bcUrl ?? ('/' + relPath),
    urlSource: bcUrl ? 'breadcrumb' : 'filepath',
    module:    relPath.split('/')[0],
    beans,
  }
}

// ─── WSDL / XSD parsing (deluxe) ─────────────────────────────────────────────

function extractXsdFields(typeBody) {
  const fields = []
  // Both xsd: and xs: namespace prefixes
  const elRe = /<(?:xsd|xs):element\s([^>]+?)\/?>/g
  let m
  while ((m = elRe.exec(typeBody)) !== null) {
    const attrs = m[1]
    const name  = attrs.match(/\bname=["']([^"']+)["']/)?.[1]
    if (!name) continue

    const rawType   = attrs.match(/\btype=["']([^"']+)["']/)?.[1] ?? 'any'
    const type      = rawType.replace(/^[a-z]+:/, '')  // strip xsd:/xs: prefix
    const minOccurs = attrs.match(/\bminOccurs=["']([^"']+)["']/)?.[1] ?? '1'
    const maxOccurs = attrs.match(/\bmaxOccurs=["']([^"']+)["']/)?.[1] ?? '1'
    const nillable  = /\bnillable=["']true["']/.test(attrs)

    fields.push({
      name,
      type,
      minOccurs: minOccurs === '0' ? 0 : (Number(minOccurs) || 1),
      maxOccurs: maxOccurs === 'unbounded' ? 'unbounded' : (Number(maxOccurs) || 1),
      required:  minOccurs !== '0' && !nillable,
    })
  }
  return fields
}

async function parseWsdlFile(filePath) {
  const content = await readFile(filePath, 'utf8')
  const dir     = dirname(filePath)
  const types   = {}
  const imports = []

  // Use the <wsdl:types> block; fall back to full content for plain XSD files
  const typesBlock = content.match(/<(?:wsdl:)?types>([\s\S]*?)<\/(?:wsdl:)?types>/)
  const xsd = typesBlock ? typesBlock[1] : content

  // Collect schema imports/includes to follow
  const impRe = /<(?:xsd|xs):(?:import|include)[^>]*schemaLocation=["']([^"']+)["'][^>]*\/?>/g
  let im
  while ((im = impRe.exec(xsd)) !== null) {
    if (!im[1].startsWith('http')) imports.push(resolve(dir, im[1]))
  }

  // Named complex types: <xsd:complexType name="Foo">...</xsd:complexType>
  const ctRe = /<(?:xsd|xs):complexType\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/(?:xsd|xs):complexType>/g
  let ct
  while ((ct = ctRe.exec(xsd)) !== null) {
    types[ct[1]] = extractXsdFields(ct[2])
  }

  // Elements with anonymous inline complex types: <xsd:element name="Foo"><xsd:complexType>...</xsd:complexType></xsd:element>
  const inlineRe = /<(?:xsd|xs):element\s+name=["']([^"']+)["'][^>]*>\s*<(?:xsd|xs):complexType[^>]*>([\s\S]*?)<\/(?:xsd|xs):complexType>/g
  let et
  while ((et = inlineRe.exec(xsd)) !== null) {
    if (!types[et[1]]) types[et[1]] = extractXsdFields(et[2])
  }

  return { types, imports }
}

async function buildWsdlRegistry(dir) {
  console.log(`\nScanning WSDL: ${dir}`)
  let files
  try {
    files = await findFiles(dir, '.wsdl')
  } catch (err) {
    console.error(`  ${err.message}`)
    return {}
  }

  // Also scan .xsd files at top-level (shared schema imports)
  let xsdFiles = []
  try {
    xsdFiles = await findFiles(dir, '.xsd')
  } catch { /* ignore */ }

  const allFiles = [...files, ...xsdFiles]
  if (allFiles.length === 0) { console.log('  No .wsdl or .xsd files found'); return {} }
  console.log(`  Found ${files.length} .wsdl + ${xsdFiles.length} .xsd file(s)`)

  const registry  = {}
  const processed = new Set()

  async function processFile(fp) {
    if (processed.has(fp)) return
    processed.add(fp)

    if (!existsSync(fp)) {
      console.log(`  SKIP (not found): ${basename(fp)}`)
      return
    }

    try {
      const { types, imports } = await parseWsdlFile(fp)
      const added = Object.keys(types).length
      Object.assign(registry, types)
      console.log(`  PARSED ${basename(fp).padEnd(40)} +${added} types`)
      for (const imp of imports) await processFile(imp)
    } catch (err) {
      console.error(`  ERROR ${basename(fp)}: ${err.message}`)
      if (DEBUG) console.error(err.stack)
    }
  }

  for (const f of allFiles) await processFile(f)
  console.log(`  Type registry total: ${Object.keys(registry).length} types`)
  return registry
}

// ─── Schema enrichment ────────────────────────────────────────────────────────

function resolveFields(schemaName, schemaMap, wsdlRegistry, depth = 0) {
  if (depth > 3) return null  // guard against circular refs

  // WSDL registry has priority (more granular field metadata)
  if (wsdlRegistry[schemaName]) {
    return { source: 'wsdl', fields: wsdlRegistry[schemaName] }
  }

  const schema = schemaMap[schemaName]
  if (!schema) return null

  if (schema['$ref']) {
    return resolveFields(schema['$ref'].split('/').pop(), schemaMap, wsdlRegistry, depth + 1)
  }

  if (schema.properties) {
    const req = new Set(schema.required ?? [])
    return {
      source: 'openapi',
      fields: Object.entries(schema.properties).map(([name, def]) => ({
        name,
        type:        def.type ?? def['$ref']?.split('/').pop() ?? 'any',
        required:    req.has(name),
        description: def.description ?? null,
      })),
    }
  }

  if (schema.allOf || schema.anyOf || schema.oneOf) {
    return { source: 'openapi', fields: [], note: 'composite schema (allOf/anyOf/oneOf)' }
  }

  return { source: 'openapi', fields: [] }
}

function enrichEndpoints(endpoints, schemaMap, wsdlRegistry) {
  const result = {}
  for (const ep of endpoints) {
    const e = { ...ep }
    if (ep.requestSchemaName)  e.requestFields  = resolveFields(ep.requestSchemaName,  schemaMap, wsdlRegistry)
    if (ep.responseSchemaName) e.responseFields = resolveFields(ep.responseSchemaName, schemaMap, wsdlRegistry)
    result[ep.operationName] = e
  }
  return result
}

// ─── Cross-reference: endpoint → pages ───────────────────────────────────────

function buildEndpointUsage(pages) {
  const usage = {}
  for (const page of pages) {
    for (const bean of page.beans) {
      for (const ep of bean.matchedEndpoints) {
        if (!usage[ep.operationName]) usage[ep.operationName] = []
        if (!usage[ep.operationName].includes(page.relativePath)) {
          usage[ep.operationName].push(page.relativePath)
        }
      }
    }
  }
  return usage
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(pagesDir)) {
    console.error(`Error: pages directory not found: ${pagesDir}`)
    process.exit(1)
  }

  console.log('jsf-analyzer\n')

  // ── Load OpenAPI ──
  let epData    = { endpoints: [], byName: {}, byId: {} }
  let schemaMap = {}
  const openapiFile = findOpenapiFile(args.openapi)

  if (openapiFile) {
    console.log(`OpenAPI: ${openapiFile}`)
    try {
      const raw  = await readFile(openapiFile, 'utf8')
      const spec = parseSpec(raw, openapiFile)
      epData     = buildEndpointData(spec)
      schemaMap  = buildSchemaMap(spec)
      console.log(`  ${epData.endpoints.length} endpoints, ${Object.keys(schemaMap).length} schemas`)
    } catch (err) {
      console.error(`Failed to load OpenAPI spec: ${err.message}`)
      if (DEBUG) console.error(err.stack)
      process.exit(1)
    }
  } else {
    console.log('OpenAPI: not found — endpoint correlation disabled')
    console.log('  (place openapi.yaml next to analyze.mjs, or use --openapi <file>)')
  }

  // ── Scan pages ──
  console.log(`\nPages: ${pagesDir}`)
  let xhtmlFiles
  try {
    xhtmlFiles = await findFiles(pagesDir, '.xhtml')
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
  console.log(`  Found ${xhtmlFiles.length} .xhtml file(s)`)

  const state = await loadState()
  const pages = []
  let nProcessed = 0, nSkipped = 0, nErrors = 0

  for (const fp of xhtmlFiles) {
    const relPath = relative(pagesDir, fp).replace(/\\/g, '/')
    let content
    try {
      content = await readFile(fp, 'utf8')
    } catch (err) {
      console.error(`  ERROR reading ${relPath}: ${err.message}`)
      nErrors++
      continue
    }

    const hash   = md5(content)
    const cached = state.pages[relPath]

    if (cached?.checksum === hash) {
      console.log(`  SKIP  ${relPath}`)
      pages.push(cached.result)
      nSkipped++
      continue
    }

    console.log(`  PARSE ${relPath}`)
    try {
      const result = analyzePage(content, fp, epData.endpoints)
      pages.push(result)
      state.pages[relPath] = {
        checksum:    hash,
        processedAt: new Date().toISOString(),
        result,
      }
      nProcessed++
    } catch (err) {
      console.error(`  ERROR ${relPath}: ${err.message}`)
      if (DEBUG) console.error(err.stack)
      // Not stored in state — will be retried on next run
      nErrors++
    }
  }

  console.log(`\n  ${nProcessed} parsed, ${nSkipped} cached, ${nErrors} error(s)`)

  // ── WSDL (deluxe) ──
  let wsdlRegistry = {}
  if (wsdlDir) {
    if (!existsSync(wsdlDir)) {
      console.error(`\nWSDL directory not found: ${wsdlDir}`)
    } else {
      try {
        wsdlRegistry = await buildWsdlRegistry(wsdlDir)
      } catch (err) {
        console.error(`WSDL scan failed: ${err.message}`)
        if (DEBUG) console.error(err.stack)
      }
    }
  }

  // ── Assemble output ──
  const enrichedEndpoints = enrichEndpoints(epData.endpoints, schemaMap, wsdlRegistry)
  const endpointUsage     = buildEndpointUsage(pages)
  const sortedPages       = pages.sort((a, b) => a.relativePath.localeCompare(b.relativePath))

  const output = {
    generatedAt:  new Date().toISOString(),
    pagesDir,
    openapiFile:  openapiFile ?? null,
    wsdlDir:      wsdlDir    ?? null,
    summary: {
      totalPages:     sortedPages.length,
      totalEndpoints: Object.keys(enrichedEndpoints).length,
      totalWsdlTypes: Object.keys(wsdlRegistry).length,
    },
    // Per-page analysis (beans, properties, methods, endpoint matches)
    pages: sortedPages,
    // All endpoints, enriched with field types
    endpoints: enrichedEndpoints,
    // Inverted index: which pages reference each endpoint
    endpointUsage,
  }

  if (dryRun) {
    console.log('\n[DRY RUN] Would write:')
    console.log(`  ${OUTPUT_FILE}`)
    console.log(`  ${STATE_FILE}`)
    if (sortedPages.length > 0) {
      console.log('\nFirst page preview:')
      console.log(JSON.stringify(sortedPages[0], null, 2))
    }
    return
  }

  await mkdir(outDir, { recursive: true })
  await writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf8')
  await saveState(state)

  console.log(`\nOutput: ${outDir}`)
  console.log(`  analysis.json  — ${sortedPages.length} pages, ${Object.keys(enrichedEndpoints).length} endpoints`)
  console.log(`  state.json     — resume cache (${Object.keys(state.pages).length} entries)`)

  if (nErrors > 0) {
    console.log(`\nWarning: ${nErrors} file(s) could not be processed. Re-run to retry.`)
  }
}

main().catch(err => {
  console.error('\nFatal error:', err.message)
  if (DEBUG) console.error(err.stack)
  else console.error('  (set DEBUG=1 for full stack trace)')
  process.exit(1)
})
