# Plataforma del Grupo

Un solo sistema para **Italo Gelateria · Origen · EcoStone · DISERCO**: un login con el logo de cada
empresa, un Hub por empresa, y por debajo un motor común (POS fiscal SAR/CAI, inventario con recetas,
RRHH, finanzas y auditoría) para poder cruzar la información de todo el grupo.

```
Railway (1 servicio Node)  ──►  Supabase (Postgres + backups)
   ├─ API  /api/*   (Express)
   └─ Web  /*       (React PWA, mismo servicio)
```

## Probarlo en tu computadora (2 minutos, sin instalar base de datos)

```bash
cd plataforma
npm install
npm run demo          # base local de demostración con datos de Origen
npm run build         # compila la web
npm start             # http://localhost:4300
```

Usuarios de la demo: dueño `dueno@grupo.hn` / `Demo-Grupo-2026` · gerente de Origen `gerente@origen.hn` (PIN 2468) ·
caja PIN `1111` · cocina PIN `2222`. **Solo para pruebas locales; nunca contra producción.**

Para desarrollar con recarga en vivo: `npm run dev:api` y, en otra terminal, `npm run dev:web` (http://localhost:5180).

## Pruebas

```bash
npm test      # 60 pruebas: motor fiscal, permisos, y el API completo contra un Postgres real embebido
```

## Documentación

| Documento | Para qué |
|---|---|
| [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md) | Cómo está hecho y por qué |
| [docs/DESPLIEGUE-RAILWAY-SUPABASE.md](docs/DESPLIEGUE-RAILWAY-SUPABASE.md) | Poner todo en línea, paso a paso |
| [docs/MIGRACION-SISTEMAS-ACTUALES.md](docs/MIGRACION-SISTEMAS-ACTUALES.md) | Qué pasa con cada app actual y en qué orden se integran |
| [docs/ORIGEN.md](docs/ORIGEN.md) | El POS de Origen: qué hay y qué falta |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Fases y prioridades |
| [docs/PREGUNTAS-ABIERTAS.md](docs/PREGUNTAS-ABIERTAS.md) | Decisiones que necesito de ti |

## Estructura

```
apps/api        API Express (módulos: auth, admin, pos, inv, rrhh, fin, terceros, grupo)
apps/web        Frontend React (PWA) — Entrada, Hub, POS táctil, cocina, ventas, inventario…
packages/shared Permisos/roles, cálculo fiscal, módulos y formatos (usados por API y web)
supabase/       Migraciones SQL (en orden) y semillas
```
