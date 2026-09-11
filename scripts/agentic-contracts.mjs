#!/usr/bin/env node
/**
 * Inventario y guard del acoplamiento entre los activos agénticos y la
 * documentación que consumen.
 *
 * ## Por qué existe
 *
 * El vínculo entre un skill y el documento que lee es hoy **una ruta en prosa
 * dentro de un markdown**. Nada falla si el destino desaparece: el skill
 * simplemente arranca ciego, y nadie se entera hasta que una corrida toma una
 * decisión sin su checklist. Eso ya pasó: una purga de documentación dejó sin
 * insumo a cinco de los siete activos de `.claude/`, incluido el subagente de
 * seguridad clínica, sin un solo error.
 *
 * Este script convierte ese acoplamiento implícito en **una interfaz
 * verificada**.
 *
 * ## Dos modos
 *
 *   node scripts/agentic-contracts.mjs scan    Regenera el manifiesto e imprime
 *                                              el reporte de referencias.
 *   node scripts/agentic-contracts.mjs check   Falla (exit 1) si algo se rompió.
 *                                              Es lo que corre `pnpm verify`.
 *
 * `check` verifica cuatro invariantes mecánicos, sin heurísticas — a propósito:
 * un guard ruidoso termina desactivado.
 *
 *   1. Toda ruta declarada en el manifiesto existe en disco.
 *   2. Toda referencia desde `.claude/` a un documento está declarada.
 *   3. Los presupuestos de líneas por capa se respetan.
 *   4. NINGÚN archivo del repo —código fuente incluido— referencia un `.md`
 *      que no existe.
 *
 * La cuarta se agregó el 2026-08-26, en la Fase 5, justo antes de borrar. El
 * escáner original solo miraba `.claude/`, y con eso los 16 documentos daban
 * "cero referencias entrantes, purgables". Eran 17 más: comentarios de
 * `packages/domain/src/*.ts` y `apps/mobile/src/components/*.tsx` citando
 * `ROADMAP_V0.2.md § Fase 13`, `UX_GUIDELINES.md` y `RESEARCH_SOURCES.md`.
 * Borrarlos habría dejado diecisiete punteros muertos dentro del código —
 * exactamente el fallo silencioso que este script existe para eliminar, un
 * nivel más abajo. Un inventario que solo mira donde uno espera encontrar
 * dependencias no es un inventario.
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const MANIFEST = join(ROOT, 'contracts', 'manifest.json');

/**
 * Presupuesto de contexto por capa, en líneas.
 *
 * No son números estéticos: la Capa 0 se carga en **cada turno**, así que cada
 * línea sale del presupuesto disponible para trabajo real. La literatura de
 * context engineering ubica el techo de lo siempre-cargado alrededor de las
 * 150-200 líneas antes de que las reglas que importan se diluyan entre las que
 * no. Acá se toma 100 porque `AGENTS.md` (34) ya prueba que alcanza.
 *
 * Sin esto verificado, la Capa 2 vuelve a ser un documento de 2.833 líneas en
 * seis meses. Ya pasó una vez.
 */
const BUDGETS = {
  layer0: { limit: 100, files: ['CLAUDE.md', 'AGENTS.md'], label: 'Capa 0 (constitución, siempre cargada)' },
  contract: { limit: 60, label: 'Capa 1 (contrato)' },
  memory: { limit: 150, label: 'Capa 2 (memory bank)' },
};

/**
 * Carpetas cuyo contenido es memoria agéntica consumible.
 *
 * ⚠️ El punto va DENTRO de la clase de caracteres del nombre de archivo. Sin
 * él, `docs/ROADMAP_V0.2.md` no matcheaba —el `.2` cortaba la ruta— y el
 * escáner reportaba como "sin referencias entrantes, purgable" un documento
 * que `app-shell/SKILL.md:62` sí citaba. Un guard con falsos negativos es peor
 * que no tener guard: da permiso para borrar justo lo que rompe algo.
 */
const NAME = String.raw`[A-Za-z0-9_.\/-]+\.md`;
const DOC_PATTERN = new RegExp(`(?:docs\\/${NAME}|contracts\\/${NAME}|memory-bank\\/${NAME}|\\bAGENTS\\.md|\\bCLAUDE\\.md)`, 'g');

/**
 * Clasificación de una referencia por el verbo que la rodea.
 *
 * Heurística deliberada y **falible**: por eso el manifiesto se commitea y se
 * revisa a mano. Lo que el guard verifica es la existencia y la declaración,
 * no la clasificación — así una clasificación equivocada nunca rompe el build,
 * solo empeora el reporte.
 */
function classify(context) {
  const lower = context.toLowerCase();
  if (/\b(actualiza|update|add a row|agrega|añade|escribe)\b/.test(lower)) return 'write';
  if (/\b(read|lee|leer|checklist|before reviewing|antes de|repasa|consulta)\b/.test(lower)) return 'hard-read';
  return 'citation';
}

function walk(dir, out = [], extensions = ['.md']) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out, extensions);
    else if (extensions.some((extension) => entry.endsWith(extension))) out.push(full);
  }
  return out;
}

/**
 * Todo archivo que puede citar un documento: los activos agénticos, el código
 * fuente (los comentarios citan documentos y esas citas se pudren igual), la
 * memoria misma y la puerta de entrada del repo.
 */
function citingFiles() {
  return [
    ...walk(join(ROOT, '.claude')),
    ...walk(join(ROOT, 'packages'), [], ['.ts', '.tsx']),
    ...walk(join(ROOT, 'apps', 'mobile', 'src'), [], ['.ts', '.tsx']),
    ...walk(join(ROOT, 'apps', 'api', 'src'), [], ['.ts', '.tsx']),
    ...walk(join(ROOT, 'memory-bank')),
    ...walk(join(ROOT, 'contracts')),
    ...walk(join(ROOT, 'docs')),
    ...['README.md', 'CLAUDE.md', 'AGENTS.md'].map((f) => join(ROOT, f)).filter(existsSync),
  ];
}

/** Referencias a un `.md` que no existe, desde cualquier parte del repo. */
function danglingReferences() {
  const problems = [];
  for (const file of citingFiles()) {
    const rel = relative(ROOT, file);
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      for (const match of line.matchAll(DOC_PATTERN)) {
        const target = match[0].replace(/^`|`$/g, '');
        // Un archivo que se cita a sí mismo no es una referencia rota.
        if (target === rel) continue;
        if (!existsSync(join(ROOT, target))) {
          problems.push(`Puntero muerto: ${rel}:${index + 1} cita ${target}, que no existe`);
        }
      }
    });
  }
  return problems;
}

function lineCount(path) {
  return readFileSync(path, 'utf8').split('\n').filter((l, i, a) => i < a.length - 1 || l !== '').length;
}

/** Extrae toda referencia a documentación desde los activos de `.claude/`. */
function scanReferences() {
  const refs = [];
  for (const file of walk(join(ROOT, '.claude'))) {
    const rel = relative(ROOT, file);
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      for (const match of line.matchAll(DOC_PATTERN)) {
        const target = match[0].replace(/^`|`$/g, '');
        // El contexto son la línea y la anterior: los verbos de lectura suelen
        // ir en la frase que introduce la lista de archivos.
        const context = `${lines[index - 1] ?? ''} ${line}`;
        refs.push({ from: rel, line: index + 1, target, kind: classify(context) });
      }
    });
  }
  return refs;
}

function buildManifest(refs) {
  const byTarget = new Map();
  for (const ref of refs) {
    if (!byTarget.has(ref.target)) byTarget.set(ref.target, { target: ref.target, consumers: [] });
    const entry = byTarget.get(ref.target);
    const existing = entry.consumers.find((c) => c.asset === ref.from && c.kind === ref.kind);
    if (existing) existing.lines.push(ref.line);
    else entry.consumers.push({ asset: ref.from, kind: ref.kind, lines: [ref.line] });
  }
  return {
    $comment: 'Generado por scripts/agentic-contracts.mjs scan. Declara qué documento consume cada activo agéntico. `pnpm verify` falla si una ruta declarada no existe o si un activo referencia algo no declarado.',
    generatedAt: new Date().toISOString().slice(0, 10),
    budgets: { layer0: BUDGETS.layer0.limit, contract: BUDGETS.contract.limit, memory: BUDGETS.memory.limit },
    dependencies: [...byTarget.values()].sort((a, b) => a.target.localeCompare(b.target)),
  };
}

/**
 * Documentos sin ninguna referencia entrante: candidatos seguros a purgar.
 *
 * Mira **todo** el repo, no solo `.claude/`. Ver la nota de la invariante 4:
 * la primera versión miraba solo los activos agénticos y por eso declaraba
 * purgables documentos que el código fuente citaba en sus comentarios.
 */
function orphans() {
  const referenced = new Set();
  for (const file of citingFiles()) {
    const rel = relative(ROOT, file);
    for (const match of readFileSync(file, 'utf8').matchAll(DOC_PATTERN)) {
      const target = match[0].replace(/^`|`$/g, '');
      if (target !== rel) referenced.add(target);
    }
  }
  const docs = walk(join(ROOT, 'docs')).map((f) => relative(ROOT, f));
  const roots = ['README.md', 'CLAUDE.md', 'AGENTS.md'].filter((f) => existsSync(join(ROOT, f)));
  return [...docs, ...roots].filter((d) => !referenced.has(d));
}

function checkBudgets() {
  const problems = [];
  const layer0 = BUDGETS.layer0.files.filter((f) => existsSync(join(ROOT, f)));
  const total = layer0.reduce((sum, f) => sum + lineCount(join(ROOT, f)), 0);
  if (total > BUDGETS.layer0.limit) {
    problems.push(`${BUDGETS.layer0.label}: ${total} líneas (${layer0.join(' + ')}), techo ${BUDGETS.layer0.limit}`);
  }
  for (const [dir, budget] of [['contracts', BUDGETS.contract], ['memory-bank', BUDGETS.memory]]) {
    for (const file of walk(join(ROOT, dir))) {
      const count = lineCount(file);
      if (count > budget.limit) {
        problems.push(`${budget.label}: ${relative(ROOT, file)} tiene ${count} líneas, techo ${budget.limit}`);
      }
    }
  }
  return problems;
}

/**
 * 5. Toda capacidad de `db.ts` está clasificada para el agente.
 *
 * El agente de IA solo puede alcanzar lo que `packages/domain/src/agent-tools.ts`
 * declara. Sin este chequeo, agregar una función a `db.ts` la dejaba en silencio
 * fuera del alcance del agente, y nadie se enteraba hasta que alguien preguntara
 * por qué el chat "no sabe hacer eso". La regla es que cada función exportada
 * está registrada como herramienta o excluida CON SU MOTIVO — nunca por omisión.
 *
 * Se lee con expresiones regulares y no importando el módulo a propósito: este
 * script es `.mjs` y no puede cargar TypeScript sin sumarle un compilador.
 */
function agentToolCoverage() {
  const problems = [];
  const dbPath = join(ROOT, 'apps/mobile/src/db.ts');
  const toolsPath = join(ROOT, 'packages/domain/src/agent-tools.ts');
  if (!existsSync(dbPath) || !existsSync(toolsPath)) return problems;

  const db = readFileSync(dbPath, 'utf8');
  const tools = readFileSync(toolsPath, 'utf8');

  const exported = [...db.matchAll(/^export (?:async )?function ([A-Za-z0-9_]+)/gmu)].map((m) => m[1]);
  const backed = new Set([...tools.matchAll(/backing: '([A-Za-z0-9_]+)'/gu)].map((m) => m[1]));

  // El bloque de exclusiones, para no confundir sus claves con otro objeto.
  const excludedBlock = tools.slice(tools.indexOf('NOT_REACHABLE_BY_AGENT'));
  const excluded = new Set([...excludedBlock.matchAll(/^  ([A-Za-z0-9_]+):/gmu)].map((m) => m[1]));

  const missing = exported.filter((name) => !backed.has(name) && !excluded.has(name));
  if (missing.length > 0) {
    problems.push(
      `Capacidades de db.ts sin clasificar para el agente: ${missing.join(', ')}. `
      + 'Regístralas en AGENT_TOOLS o en NOT_REACHABLE_BY_AGENT con su motivo '
      + '(packages/domain/src/agent-tools.ts).',
    );
  }

  // Un `backing` que ya no existe es un puntero muerto, igual que un doc borrado.
  const exportedSet = new Set(exported);
  for (const name of backed) {
    if (!exportedSet.has(name)) {
      problems.push(`AGENT_TOOLS apunta a \`${name}\`, que ya no existe en db.ts.`);
    }
  }
  return problems;
}

/**
 * El log del dictado se corta en el origen, y eso se verifica.
 *
 * `expo-speech-recognition` escribe la transcripción **y las pistas de
 * vocabulario** —los nombres de las insulinas de la usuaria y su catálogo— con
 * `Log.d`, sin condición. Android llama a eso Log Info Disclosure y `AGENTS.md`
 * lo prohíbe.
 *
 * Se resolvió parcheando la dependencia y **no** con una regla de ProGuard, por
 * una razón que costó un build averiguar: una regla no se puede comprobar desde
 * acá, y la que se escribió no borró nada del APK. El parche sí se comprueba —
 * los textos desaparecen del archivo instalable.
 *
 * Esto verifica que el parche siga declarado. Un `pnpm install` que lo pierda
 * devolvería la fuga en silencio, que es exactamente cómo se pierden estas
 * cosas.
 */
function speechLogPatchIsDeclared() {
  const problems = [];
  const wsPath = join(ROOT, 'pnpm-workspace.yaml');
  const patchPath = join(ROOT, 'patches/expo-speech-recognition@57.0.0.patch');
  if (!existsSync(wsPath)) return problems;

  const usesPackage = existsSync(join(ROOT, 'apps/mobile/package.json'))
    && readFileSync(join(ROOT, 'apps/mobile/package.json'), 'utf8').includes('expo-speech-recognition');
  if (!usesPackage) return problems;

  // La clave, con sus dos puntos: buscar solo el nombre lo encontraba dentro de
  // la RUTA del .patch y daba por buena una declaración rota.
  if (!/^\s*'?expo-speech-recognition@57\.0\.0'?\s*:/mu.test(readFileSync(wsPath, 'utf8'))) {
    problems.push(
      'El parche de expo-speech-recognition no está declarado en pnpm-workspace.yaml: '
      + 'el dictado volvería a escribir la transcripción y los nombres de las insulinas '
      + 'en el log de Android. Ver docs/adr/0009.',
    );
  } else if (!existsSync(patchPath)) {
    problems.push(
      'pnpm-workspace.yaml declara el parche de expo-speech-recognition pero el archivo '
      + `no existe (${'patches/expo-speech-recognition@57.0.0.patch'}). El install va a fallar.`,
    );
  } else if (!readFileSync(patchPath, 'utf8').includes('neutralizado')) {
    problems.push(
      'El parche de expo-speech-recognition ya no neutraliza `log()`: revisa que siga '
      + 'cortando la escritura de la transcripción al log (patches/).',
    );
  }
  return problems;
}

/**
 * Que el micrófono siga declarado, y que nadie lo bloquee por detrás.
 *
 * Costó un build entero: `expo-image-picker` con `microphonePermission: false`
 * llama a `withBlockedPermissions(['android.permission.RECORD_AUDIO'])` — su
 * comentario dice, textual, "to ensure no package can add them" —, así que
 * anulaba **tanto** la declaración explícita de `app.json` **como** la del
 * plugin de dictado. La app se instaló sin la opción de micrófono en los
 * ajustes del teléfono, sin un solo error en el build.
 *
 * Un permiso que está en `permissions` y a la vez bloqueado desaparece en
 * silencio. Esto lo detiene antes del build.
 */
function microphonePermissionSurvives() {
  const problems = [];
  const appJsonPath = join(ROOT, 'apps/mobile/app.json');
  if (!existsSync(appJsonPath)) return problems;

  const expo = JSON.parse(readFileSync(appJsonPath, 'utf8')).expo ?? {};
  const plugins = expo.plugins ?? [];
  const usesDictation = plugins.some((p) => (Array.isArray(p) ? p[0] : p) === 'expo-speech-recognition');
  if (!usesDictation) return problems;

  const RECORD_AUDIO = 'android.permission.RECORD_AUDIO';
  if (!(expo.android?.permissions ?? []).includes(RECORD_AUDIO)) {
    problems.push(`El dictado necesita ${RECORD_AUDIO} en android.permissions (apps/mobile/app.json).`);
  }
  if ((expo.android?.blockedPermissions ?? []).includes(RECORD_AUDIO)) {
    problems.push(
      `${RECORD_AUDIO} está en blockedPermissions: el bloqueo gana y el micrófono `
      + 'queda sin opción en los ajustes del teléfono, sin ningún error visible.',
    );
  }
  // El bloqueo que de verdad pasó: viene de la config de otro plugin.
  for (const plugin of plugins) {
    if (!Array.isArray(plugin)) continue;
    if (plugin[1]?.microphonePermission === false) {
      problems.push(
        `El plugin \`${plugin[0]}\` tiene \`microphonePermission: false\`, que BLOQUEA `
        + `${RECORD_AUDIO} para toda la app y deja el dictado mudo. Quita esa clave.`,
      );
    }
  }
  return problems;
}

function check() {
  const problems = [];

  if (!existsSync(MANIFEST)) {
    console.error('✗ Falta contracts/manifest.json. Corre: node scripts/agentic-contracts.mjs scan');
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const declared = new Set(manifest.dependencies.map((d) => d.target));

  // 1. Toda ruta declarada existe.
  for (const dep of manifest.dependencies) {
    if (!existsSync(join(ROOT, dep.target))) {
      const who = dep.consumers.map((c) => c.asset).join(', ');
      problems.push(`Referencia rota: ${dep.target} no existe, y lo consume ${who}`);
    }
  }

  // 2. Toda referencia desde .claude/ está declarada.
  for (const ref of scanReferences()) {
    if (!declared.has(ref.target)) {
      problems.push(`Referencia no declarada: ${ref.from}:${ref.line} apunta a ${ref.target}. Corre \`scan\` y revisa el manifiesto.`);
    }
  }

  // 3. Presupuestos.
  problems.push(...checkBudgets());

  // 4. Punteros muertos desde cualquier parte del repo, código incluido.
  problems.push(...danglingReferences());

  // 5. Cada capacidad de db.ts, clasificada para el agente.
  problems.push(...agentToolCoverage());

  // 6. El dictado no vuelve a escribir en el log de Android.
  problems.push(...speechLogPatchIsDeclared());

  // 7. El permiso de micrófono sobrevive a los plugins.
  problems.push(...microphonePermissionSurvives());

  if (problems.length > 0) {
    console.error('✗ verify:contracts falló\n');
    for (const problem of problems) console.error(`  · ${problem}`);
    console.error('');
    process.exit(1);
  }
  console.log(`✓ verify:contracts — ${manifest.dependencies.length} dependencias declaradas, todas resueltas; presupuestos dentro de techo; capacidades del agente clasificadas; el dictado no escribe en el log; micrófono declarado`);
}

function scan() {
  const refs = scanReferences();
  const manifest = buildManifest(refs);
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`Manifiesto escrito: contracts/manifest.json (${manifest.dependencies.length} documentos referenciados)\n`);
  console.log('DEPENDENCIAS POR DOCUMENTO');
  for (const dep of manifest.dependencies) {
    const exists = existsSync(join(ROOT, dep.target)) ? '' : '  ⚠ NO EXISTE';
    console.log(`\n  ${dep.target}${exists}`);
    for (const c of dep.consumers) console.log(`      ${c.kind.padEnd(10)} ${c.asset}  (líneas ${c.lines.join(', ')})`);
  }

  const unreferenced = orphans();
  console.log(`\n\nSIN REFERENCIAS ENTRANTES — purgables sin romper ningún activo (${unreferenced.length})`);
  for (const doc of unreferenced) console.log(`  · ${doc}  (${lineCount(join(ROOT, doc))} líneas)`);

  const budgetProblems = checkBudgets();
  console.log(`\n\nPRESUPUESTOS: ${budgetProblems.length === 0 ? 'dentro de techo' : 'EXCEDIDOS'}`);
  for (const problem of budgetProblems) console.log(`  ⚠ ${problem}`);
}

const mode = process.argv[2];
if (mode === 'scan') scan();
else if (mode === 'check') check();
else {
  console.error('Uso: node scripts/agentic-contracts.mjs <scan|check>');
  process.exit(1);
}
