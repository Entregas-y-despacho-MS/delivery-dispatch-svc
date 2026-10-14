// Mide el límite de la API `table` de la instancia OSRM (ST-50.2, etapa 1.a, A-2).
//
// Uso:  node scripts/osrm/measure-table-limit.mjs [urlBase]      (por defecto http://localhost:5001)
//
// No entra al build: es una herramienta de medición, no código del servicio. Las coordenadas
// salen de una semilla fija dentro de La Paz, así que dos corridas dan las mismas consultas.

const BASE = process.argv[2] ?? process.env.OSRM_URL ?? 'http://localhost:5001';
const TIMEOUT_MS = 20_000;

// mulberry32: generador determinista (semilla fija).
function rng(seed) {
    return () => {
        seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const rand = rng(50_2);
const POINTS = Array.from({ length: 1200 }, () => ({
    lat: -16.56 + rand() * (-16.48 - -16.56),
    lon: -68.15 + rand() * (-68.05 - -68.15),
}));

const range = (from, to) => Array.from({ length: to - from }, (_, i) => from + i);

async function table(n, { sources, destinations } = {}) {
    const coords = POINTS.slice(0, n).map((p) => `${p.lon},${p.lat}`).join(';');
    const params = new URLSearchParams({ annotations: 'duration' });
    if (sources) params.set('sources', sources.join(';'));
    if (destinations) params.set('destinations', destinations.join(';'));
    const url = `${BASE}/table/v1/driving/${coords}?${params.toString().replaceAll('%3B', ';')}`;

    const started = performance.now();
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        const text = await res.text();
        const ms = Math.round(performance.now() - started);
        let body = null;
        try { body = JSON.parse(text); } catch { /* cuerpo no JSON */ }
        const rows = body?.durations?.length ?? 0;
        const cols = body?.durations?.[0]?.length ?? 0;
        const nulls = (body?.durations ?? []).flat().filter((d) => d === null).length;
        return {
            http: res.status, code: body?.code ?? text.slice(0, 60), ms,
            shape: body?.durations ? `${rows}x${cols}` : '-', nulls, urlLength: url.length,
        };
    } catch (err) {
        return { http: 0, code: `${err.name}: ${err.message}`, ms: Math.round(performance.now() - started), shape: '-', nulls: 0, urlLength: url.length };
    }
}

function line(label, r) {
    console.log(
        `${label.padEnd(46)} http=${String(r.http).padEnd(3)} code=${String(r.code).padEnd(12)} ` +
        `${String(r.ms).padStart(5)} ms  matriz=${r.shape.padEnd(9)} nulls=${r.nulls}  url=${r.urlLength} car.`,
    );
}

console.log(`OSRM: ${BASE}\n`);

console.log('# 1. Sin sources/destinations (cuenta de coordenadas)');
for (const n of [2, 10, 50, 100, 101, 150]) line(`N=${n}`, await table(n));

console.log('\n# 2. Con sources y destinations explícitos (¿producto o total de coordenadas?)');
line('N=150, sources=0..49, destinations=todos', await table(150, { sources: range(0, 50), destinations: range(0, 150) }));
line('N=150, sources=0..9,  destinations=todos', await table(150, { sources: range(0, 10), destinations: range(0, 150) }));
line('N=300, sources=0..9,  destinations=todos', await table(300, { sources: range(0, 10), destinations: range(0, 300) }));
line('N=150, sources=0..99, destinations=0..99', await table(150, { sources: range(0, 100), destinations: range(0, 100) }));
line('N=150, sources=0..99, destinations=100..149', await table(150, { sources: range(0, 100), destinations: range(100, 150) }));
line('N=150, sources=0..100, destinations=0..99', await table(150, { sources: range(0, 101), destinations: range(0, 100) }));

console.log('\n# 3. Longitud de URL (límite de cabecera HTTP)');
for (const n of [400, 800, 1200]) {
    line(`N=${n}, sources=0, destinations=todos`, await table(n, { sources: [0], destinations: range(0, n) }));
}

console.log('\n# 4. Latencia con N=100 (3 repeticiones)');
for (let i = 1; i <= 3; i++) line(`N=100 repetición ${i}`, await table(100));
