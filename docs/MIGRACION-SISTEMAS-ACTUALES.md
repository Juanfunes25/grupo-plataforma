# Qué pasa con cada sistema actual

Principio: **no se tira nada ni se apaga nada hasta que su reemplazo esté probado en paralelo.** Cada
sistema se integra por etapas ("estrangulamiento"): primero convive, luego se importan sus datos, luego
se retira.

Los cuatro sistemas, por lo que realmente hay en los repositorios:

| Sistema | Qué es hoy | Base actual | Tamaño |
|---|---|---|---|
| `italo-facturacion` | POS + facturación fiscal de las 4 tiendas de Italo (CAI, cierres, antifraude, cotizaciones/eventos) | Supabase (Postgres) | ~19 mil líneas |
| `Ecostone-facturacion` | El mismo motor adaptado a fábrica: cotizaciones por m², producción/colada, trazabilidad, **y DISERCO** como segunda empresa | Supabase (Postgres) | ~25 mil líneas |
| `italo-reposicion` | Pesaje nocturno, reposición por panas, despachos Los Andes→tiendas, producción, costeo, inventario con lotes MEC3, RFID, asistencia/horarios/vacaciones, "gerente digital" | SQLite/Turso | ~47 mil líneas |
| `italo-dashboard` | Tablero de dueños sobre WizPOS (solo lectura) + banco/gastos/IA + `italo-costeo` | SQLite/Turso + WizPOS | ~30 mil líneas |

## Mapa: de dónde sale cada cosa en la plataforma

| Funcionalidad actual | Dónde queda | Estado |
|---|---|---|
| Login por sucursal / PIN / roles (reposición, facturación) | `core.accesos` + login con logos + PIN | ✅ Hecho |
| Catálogo, categorías, clientes (facturación) | `pos.*` + `core.terceros` | ✅ Hecho |
| Punto de venta, CAI, correlativo atómico, ISV, descuentos, ticket (facturación) | `pos.*` + módulo POS | ✅ Hecho (ver paridad abajo) |
| Cierre de caja con cuadre (facturación) | `pos.turnos` + cierre de turno | ✅ Hecho (rediseñado: apertura→cierre) |
| Auditoría inalterable con cadena de hashes (facturación) | `core.auditoria` | ✅ Hecho |
| Empleados, horarios, vacaciones, asistencia (reposición) | `rrhh.*` | 🟡 Base hecha; falta turnos/rotación/reportes de horas avanzados |
| Costeo y recetas (italo-costeo, reposición) | `inv.receta_items` + márgenes | 🟡 Base hecha; falta importar los 303 insumos MEC3 y 24 recetas |
| Consolidado de ventas/gastos del dueño (dashboard) | `GET /api/grupo/resumen` + pantalla Dirección | ✅ Hecho sobre datos propios; el puente a WizPOS está pendiente |
| Pesaje, reposición, despachos, producción de gelato, RFID, trazabilidad (reposición) | esquema `gelato` (nuevo) | ⬜ Pendiente (Fase 3) |
| Cotizaciones, órdenes de producción/colada, trazabilidad de lotes (EcoStone) | esquema `industria` (nuevo) | ⬜ Pendiente (Fase 4) |
| Catálogo/cotizaciones/salidas de DISERCO | `industria` + `pos` | ⬜ Pendiente (Fase 4) |
| Banco, gastos con IA, gerente analítico (dashboard) | `fin.*` + módulo Finanzas | 🟡 Gastos y utilidad hechos; banco/IA pendientes |
| Lectura de WizPOS (solo lectura) | Conector de solo lectura en el API | ⬜ Pendiente (mientras WizPOS siga vivo) |

## Por qué este orden

1. **Origen primero (hecho)**: negocio nuevo, sin datos históricos ni costumbres que romper. Sirve de
   banco de pruebas real del motor común y entra en producción sin riesgo para lo que ya factura.
2. **Italo POS (siguiente)**: el motor ya es el de `italo-facturacion`. Se migra el catálogo, clientes,
   ventas históricas y cierres con un script de importación (ver abajo) y se corre **en paralelo** con
   WizPOS unas semanas antes de cortar. El dashboard WizPOS sigue como puente hasta entonces.
3. **Reposición/producción de gelato**: es lo más grande (47 mil líneas) y lo más delicado (RFID, SQLite→Postgres).
   Se porta módulo por módulo, aprovechando que su lógica de negocio está en funciones puras con
   pruebas (`backend/lib/*.test.js`), que se reutilizan tal cual.
4. **EcoStone/DISERCO**: comparten motor con Italo; lo propio (cotizaciones por m², colada) se porta a `industria`.
5. **Retiro**: cuando una app lleva un ciclo completo (un mes cerrado) sin diferencias contra la plataforma, se apaga.

## Importación de datos (SQLite/Turso y Supabase → plataforma)

- **✅ De `italo-facturacion` (hecho y probado)**: `npm run importar:italo` (ver abajo).
- **De Supabase (EcoStone/DISERCO)**: los esquemas son casi iguales al nuevo (`ventas`, `detalle_venta`,
  `venta_pagos`, `puntos_emision`…). La importación es un script SQL/Node que mapea `sucursales` →
  `core.sucursales`, `perfiles` → `core.usuarios` + `core.accesos`, y copia ventas e históricos con su
  `empresa_id`. **Las contraseñas no se pueden migrar** (Supabase Auth no las expone): los usuarios
  reciben un PIN o contraseña nueva. La bitácora antigua se archiva aparte (su cadena de hashes no es
  compatible con la nueva).
- **De SQLite/Turso (reposición, costeo)**: un script de Node lee con `@libsql/client` y escribe en
  Postgres tabla por tabla (los tipos cambian: fechas texto → `timestamptz`, enteros 0/1 → booleanos).
- Todo script de importación es **idempotente** y corre primero contra una copia de la base, nunca contra producción.

## Paridad con italo-facturacion (lo que aún le falta al POS unificado para reemplazarlo)

Prioridad alta antes de cortar WizPOS/`italo-facturacion`:
- [ ] Notas de crédito emitidas como documento (hoy solo se anula).
- [ ] Cotizaciones/eventos y su conversión a factura.
- [ ] Caja chica con arqueo y su reporte.
- [ ] Antifraude: reglas configurables y alertas (descuentos fuera de rango, huecos de correlativo, reimpresiones).
- [ ] Cierre con cuadre por terminal de tarjeta (BAC/Ficohsa) además de por tipo de pago.
- [ ] Exigir carné/identidad para el descuento de tercera edad (regla configurable).
- [ ] Envío de factura por correo y resumen diario al dueño.
- [ ] Modo sin conexión con cola de ventas.

## Importar `italo-facturacion` (listo)

```bash
export LEGACY_DATABASE_URL='postgresql://…'   # la base de italo-facturacion (solo se LEE)
export DATABASE_URL='postgresql://…'          # la base nueva de la plataforma

npm run importar:italo                         # ENSAYO: dice qué haría y no guarda nada
npm run importar:italo -- --aplicar            # guarda (idempotente: se puede repetir)
npm run importar:italo -- --aplicar --desde=2026-01-01     # solo ventas desde esa fecha
npm run importar:italo -- --aplicar --fiscal   # SOLO EL DÍA DEL CORTE: copia CAI y correlativo vigente
```

Qué trae: sucursales (emparejadas por alias), usuarios con su rol y sucursal (sin contraseña: se asignan PIN o
contraseña nuevos), categorías, productos (ISV 15/18/0), clientes (unidos por RTN con el directorio común),
formas de pago, ventas pagadas y anuladas con detalle y pagos (incluida la identidad del adulto mayor en
descuentos del 25 %), cierres de caja como turnos cerrados enlazados a sus ventas, notas de crédito y la
bitácora antigua como archivo de solo lectura. **No** trae: caja chica (se revisa con el contador),
cotizaciones/eventos, alertas antifraude (fases siguientes).

Probado contra el **esquema real** de `italo-facturacion` (sus 15 migraciones corridas en un Postgres embebido),
incluido el escenario de corte: después de `--fiscal` la primera factura de la plataforma continúa el correlativo
exacto donde iba el sistema viejo.

**Plan de corte seguro (por tienda):** ensayo → aplicar (histórico) → semanas en paralelo → día del corte: detener el
sistema viejo → `--aplicar --fiscal` → verificar la primera factura → abrir la nueva caja.
