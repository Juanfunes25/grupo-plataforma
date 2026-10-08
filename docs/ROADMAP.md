# Roadmap

Cada fase deja algo **utilizable**; ninguna obliga a apagar un sistema que hoy funciona.

## ✅ Fase 0–1 · Cimientos + Origen (hecha en esta entrega)
- Monorepo, esquema Postgres multiempresa (core, rrhh, pos, inv, fin), migraciones y semillas.
- Login multiempresa con logos, PIN y correo, roles por empresa, permisos finos, auditoría inalterable.
- POS fiscal completo (CAI, correlativo atómico, ISV, ticket), turnos de caja, modificadores, venta por peso.
- Inventario con recetas/FEFO/mermas/conteos/traslados/compras; cocina (KDS).
- RRHH único (persona + contrato por empresa), finanzas (gastos, utilidad, intercompañía), terceros comunes.
- Dirección: consolidado de todas las empresas con alertas.
- 65 pruebas automáticas y recorrido verificado en navegador real.

## Fase 2 · Poner Origen y Dirección en producción (≈ 1 semana de trabajo + tus datos)
- Desplegar en Railway + Supabase (guía lista), cargar datos reales de Origen.
- **Modo sin conexión** con cola de ventas (la mejora de confiabilidad #1).
- Impresión directa a térmica y gaveta; bottom-sheet de orden en celular.
- Pantalla de seguimiento para el dueño en el celular (alertas por correo/WhatsApp).

## Fase 3 · Italo POS en paralelo con WizPOS (≈ 2–3 semanas)
- ✅ Script de importación de `italo-facturacion` (hecho y probado contra su esquema real): falta correrlo con los datos reales.
- Paridad de facturación: notas de crédito, caja chica, cotizaciones/eventos, antifraude, cuadre por terminal.
- Conector de **solo lectura** a WizPOS para que Dirección vea las 4–5 tiendas mientras convive.
- Correr 2–4 semanas en paralelo; cortar WizPOS tienda por tienda.

## Fase 4 · Producción y reposición de gelato (≈ 3–5 semanas, lo más grande)
- Esquema `gelato`: pesaje nocturno, reposición por panas, despachos Los Andes → tiendas, recepción con discrepancias.
- Producción centralizada con lotes MEC3, costeo real por sabor (insumos dolarizados con tipo de cambio).
- Inventario por sucursal, RFID, trazabilidad, mantenimiento e incidencias.
- Asistencia/horarios/vacaciones avanzados sobre el RRHH único.

## Fase 5 · EcoStone y DISERCO (≈ 3–4 semanas)
- Cotizaciones por m² y su conversión a factura, órdenes de producción/colada, trazabilidad de lotes,
  calidad, catálogo importado de DISERCO, salidas y cuentas por cobrar.
- Operaciones intercompañía automáticas (DISERCO vende a EcoStone).

## Fase 6 · Dirección avanzada
- Presupuesto vs real, flujo de caja, cuentas por pagar/cobrar, conciliación bancaria (lo de `banco/` del dashboard).
- Gastos por foto con IA, "gerente digital" que explica desviaciones, comparativos entre sucursales.
- Exportes contables para el contador (libro de ventas ya existe en CSV).

## Transversal (en todas las fases)
- Siempre pruebas automáticas antes de tocar facturación.
- Actualizar dependencias con aviso de seguridad (vite/react-router).
- Respaldos verificados y simulacro de restauración trimestral.
