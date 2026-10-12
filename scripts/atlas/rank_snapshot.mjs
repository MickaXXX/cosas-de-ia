#!/usr/bin/env node
/* Foto del ranking con el MISMO motor que usa la app (docs/atlas/js), para el digest
 * semanal y las alertas de cambio de posición. Solo datos reales (sin DEMO) y con la
 * configuración publicada (config/defaults.json).
 *
 *   node scripts/atlas/rank_snapshot.mjs   →  docs/atlas/data/ranking_snapshot.json
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildContext, analyzeProject, devGeometry, hypotheticalUnit } from '../../docs/atlas/js/analysis.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(here, '..', '..', 'docs', 'atlas');
const read = (p, d = null) => (existsSync(path.join(APP, p)) ? JSON.parse(readFileSync(path.join(APP, p), 'utf8')) : d);

const config = read('config/defaults.json');
// Igual que la app (app.js → buildProjects): sin unidades publicadas se usa la unidad hipotética
// con el precio "desde", que nunca pasa las puertas de calidad (queda en la lista provisional).
const projects = (read('data/projects.json', { projects: [] }).projects || []).filter((p) => !p.demo).map((p) => {
  const h = hypotheticalUnit(p, config);
  return h ? { ...p, units: [h], hypothetical_units: true } : p;
});
const features = (p) => read(p, { features: [] }).features || [];
const uf = read('data/uf.json') || { value: read('data/market.json', {}).uf_fallback?.value };
const ctx = buildContext({
  projects,
  rentals: (read('data/rentals.json', { listings: [] }).listings || []).filter((r) => !r.demo),
  references: read('data/rent_reference.json', { references: [] }).references || [],
  stations: features('data/osm/metro_stations.geojson'),
  metroLines: features('data/osm/metro_lines.geojson'),
  pois: features('data/osm/pois.geojson'),
  communesGeo: features('data/osm/communes.geojson'),
  developments: (read('data/developments.json', { developments: [] }).developments || []).filter((d) => devGeometry(d)),
  config, uf,
});
const rows = [];
for (const p of projects) {
  const an = analyzeProject(p, ctx);
  if (!an.best) continue;
  const a = an.best;
  rows.push({
    id: p.id, unit: a.unit.id, name: p.name, commune: p.commune, score: Math.round(a.score * 10) / 10,
    passed: a.gates.passed, pending: a.gates.fails.slice(0, 4), status: a.status.code,
    price_uf: a.priceUf, monthly_cf_clp: uf?.value ? Math.round(a.metrics.monthlyCf * uf.value) : null,
    rent_source: a.rentSource, hypothetical: !!a.unit.hypothetical,
    plan: a.plan ? { status: a.plan.status, terms: a.plan.terms.source, cuotas: a.plan.cuotas,
      cuota_clp: uf?.value ? Math.round(a.plan.cuotaUf * uf.value) : null, min_installments_needed: a.plan.minInstallmentsNeeded } : null,
  });
}
rows.sort((x, y) => (y.passed - x.passed) || (y.score - x.score));
rows.forEach((r, i) => { r.position = i + 1; });
const inv = config.investor || {};
const out = { generated_at: new Date().toISOString(), profile: config.ranking.profile, uf: uf?.value ?? null,
  investor_plan: { cash_today_clp: inv.cashTodayClp ?? null, monthly_savings_clp: inv.monthlySavingsClp ?? null },
  note: 'Ranking con la configuración publicada y solo datos reales. "passed" = pasa las puertas de calidad.', rows };
writeFileSync(path.join(APP, 'data', 'ranking_snapshot.json'), `${JSON.stringify(out, null, 1)}\n`);
console.log(`ranking_snapshot.json: ${rows.length} proyectos (${rows.filter((r) => r.passed).length} verificados)`);
