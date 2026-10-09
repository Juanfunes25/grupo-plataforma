# Arquitectura de la Plataforma del Grupo

## 1. Qué problema resuelve

Hoy cada negocio vive en su propia app (WizPOS + dashboard, reposición, facturación, EcoStone), con
sus propias bases (SQLite/Turso, dos proyectos de Supabase, Google Sheets). Para ver "cuánto ganó el
grupo" hay que juntar cuatro lugares a mano, una misma persona puede estar dada de alta en tres
sistemas y cada app repite la misma lógica fiscal.

La plataforma pone **un solo motor** debajo y **una configuración por empresa** encima:

- Una **base de datos** (Supabase/Postgres) con todo el grupo, separado por `empresa_id`.
- **Un login**: pantalla con el logo de cada empresa → acceso (PIN o correo) → Hub de módulos.
- **Un RRHH**: la persona existe una vez; tiene un contrato por empresa.
- **Un POS/fiscal**: el motor de `italo-facturacion` (CAI/correlativo atómico, ISV, cierres) generalizado.
- **Un inventario**: insumos, lotes con vencimiento, recetas, mermas, compras — sirve a frutas de
  Origen, insumos de gelato y materia prima de EcoStone.
- **Un consolidado**: ventas, costo, gastos y utilidad de todas las empresas en una llamada, restando
  las operaciones entre empresas del grupo.

## 2. Vista general

```
                      ┌───────────────────────── Railway (1 servicio Node) ─────────────────────────┐
 Navegador / tablet   │   Web (React PWA, estática)          API Express  /api/*                     │
 PIN o correo  ──────►│   Entrada → Acceso → Hub → módulo    auth · admin · pos · inv · rrhh · fin   │
                      │                                      terceros · grupo                         │
                      └───────────────────────────────┬──────────────────────────────────────────────┘
                                                      │  pg (conexión directa, rol postgres)
                                          ┌───────────▼───────────┐
                                          │  Supabase (Postgres)  │  core · rrhh · pos · inv · fin
                                          │  backups · (Storage)  │  RLS cerrada: solo el API entra
                                          └───────────────────────┘
```

Un único servicio sirve API y web: un solo deploy, sin CORS, y los dos pagos que querías
(Railway + Supabase) son todo.

## 3. Modelo de datos

Esquemas de Postgres (cada uno es un "módulo" de datos):

| Esquema | Contenido |
|---|---|
| `core` | `empresas`, `empresa_modulos`, `sucursales`, `usuarios`, `accesos` (rol por empresa), `terceros` (clientes/proveedores comunes), `auditoria` (inalterable), `config` |
| `rrhh` | `personas`, `empleados` (contrato por empresa), `horarios`, `marcaciones`, `vacaciones` |
| `pos` | catálogo (`categorias`, `productos`, `modificador_grupos`, `modificadores`), fiscal (`puntos_emision`), `turnos`, `movimientos_caja`, `ventas`, `detalle_venta`, `venta_pagos`, `notas_credito` |
| `inv` | `insumos`, `lotes`, `movimientos`, `receta_items`, `modificador_consumo`, `compras`; vistas `stock` y `costo_receta` |
| `fin` | `categorias_gasto`, `gastos`, `intercompania` |

Reglas de diseño:

1. **Todo cuelga de una empresa.** Cada fila de negocio lleva `empresa_id` (y `sucursal_id` si aplica).
   El API nunca acepta la empresa desde el cuerpo de la petición: sale del contexto autenticado.
2. **Terceros comunes.** Un cliente que compra en Origen y en Italo es la misma ficha; el historial se
   cruza (`GET /api/terceros/:id/historial`).
3. **Una persona, un contrato por empresa.** `rrhh.personas` (única por identidad) →
   `rrhh.empleados` (uno vigente por empresa). El directorio del grupo los junta.
4. **El stock es un libro.** `inv.movimientos` (+entra / −sale) es la verdad; los lotes dan FEFO y costo.
5. **La caja no se bloquea.** Si se vende algo sin existencia registrada, el sistema cobra igual, deja
   stock negativo (alerta en Dirección) y costea al último precio conocido.

## 4. Seguridad

- **Autenticación propia, sin dependencias externas**: contraseñas con scrypt; PIN de 4–8 dígitos
  guardado como HMAC-SHA256 con *pepper* del servidor, único por empresa; sesión = JWT firmado
  (12 h) con versión de token para poder cerrar todas las sesiones de alguien.
- **PIN solo para roles operativos** (cajero, producción, bodega, ventas, gerente) y **ligado a una
  empresa**: un token de PIN no sirve en otra empresa aunque se manipule el encabezado.
  Dirección (dueño, admin, contador, solo lectura) exige correo + contraseña.
- **Límite de intentos** (6 por correo/IP, 8 por PIN/IP en 10 min).
- **Roles por empresa** + permisos finos (`pos:anular`, `fin:ver`, `grupo:ver`…): ver
  `packages/shared/src/permisos.js`. Un administrador no puede crear otro administrador ni un dueño.
- **Precios siempre del servidor**: la caja manda producto, cantidad y opciones; el total se recalcula
  con los precios y reglas de la base. Un cliente manipulado no puede cambiar un precio.
- **Auditoría inalterable**: `core.auditoria` con cadena de hashes SHA-256; triggers impiden
  UPDATE/DELETE/TRUNCATE; `core.verificar_auditoria()` detecta cualquier alteración.
- **RLS activa y sin políticas** en todas las tablas: aunque alguien exponga un esquema por la API
  REST de Supabase, `anon` y `authenticated` no ven nada. Solo el API (rol `postgres`) entra.
- **Verificación en dos pasos (TOTP), sesiones con cierre remoto, políticas de contraseña y PIN, rotación de llaves sin cerrar sesiones**: ver `docs/SEGURIDAD.md`. **Copias exportables, restauración y estado del sistema**: `docs/RESPALDOS.md`. **Medición de rendimiento**: `docs/RENDIMIENTO.md`.
- Secretos solo en variables de entorno. En producción el servidor se niega a arrancar sin
  `APP_JWT_SECRET` (≥ 32 caracteres) ni `DATABASE_URL`.

## 5. Motor fiscal (SAR Honduras)

Portado de `italo-facturacion`, con las mismas garantías:

- `pos.cobrar_venta()` hace en **una transacción**: valida pagos, bloquea la fila del punto de emisión,
  asigna el siguiente correlativo, valida rango y fecha límite del CAI, escribe los pagos netos
  (sin el cambio) y cierra la venta. Dos cajeros no pueden obtener el mismo número (probado con
  cobros simultáneos).
- Sin CAI real, la factura sale `BORRADOR-…` y el ticket dice "SIN VALIDEZ FISCAL". Activar el CAI
  valida el formato del SAR (6-6-6-6-6-2), códigos de 3/3/2 dígitos, rango y fecha, y **no deja
  retroceder el correlativo** si ya se emitió.
- ISV con precio incluido; buckets exento / exonerado / gravado 15 % / gravado 18 %; descuentos por
  línea (0/10/25 %) o global repartido proporcionalmente para que base e ISV cuadren al centavo.
- Anular no reutiliza el correlativo; queda la factura marcada anulada con motivo y usuario.

> **Pendiente de validar con el contador** (ver PREGUNTAS-ABIERTAS): la clasificación exento vs
> exonerado y si el jugo/smoothie preparado de Origen lleva 15 % mientras la fruta fresca va exenta.

## 6. Cómo se compone una empresa

Una empresa es **datos + módulos encendidos** (`core.empresa_modulos`), no código aparte:

| Empresa | Módulos hoy | Lo específico que se suma encima |
|---|---|---|
| Origen | pos, kds, inventario, rrhh, finanzas | modificadores (tamaño/boosters), recetas con merma, cocina, venta por peso |
| Italo | pos, inventario, rrhh, finanzas | pesaje/reposición, producción central, despachos (ver MIGRACION) |
| EcoStone | pos, inventario, rrhh, finanzas | cotizaciones, órdenes de producción/colada, trazabilidad de lotes |
| DISERCO | pos, inventario, rrhh, finanzas | catálogo importado, cotizaciones, salidas |

Agregar una empresa nueva = una fila en `core.empresas`, sus sucursales y sus módulos; el login, el
Hub, los permisos, el POS y el consolidado ya la reconocen.

## 7. Decisiones y por qué

| Decisión | Razón |
|---|---|
| Un servicio en Railway sirviendo API + web | Un deploy, un dominio, cero CORS; es lo que ya funcionaba bien en las apps actuales (Render). |
| Postgres directo (`pg`) en vez de `supabase-js` | Transacciones reales (cobrar + correlativo + inventario atómicos), funciones PL/pgSQL, y mismos tests contra PGlite. |
| Auth propia + PIN | La caja necesita entrar en 2 segundos con PIN; Supabase Auth no lo hace. Se puede sumar Supabase Auth después (MFA para dueños) sin tocar el resto. |
| Trigger de inventario en la base | Descontar recetas al cobrar funciona venga de donde venga la venta (caja, API, importación). |
| Esquemas por módulo | Orden, permisos y backups por área; facilita sacar un módulo a su propio servicio si algún día hiciera falta. |
| PGlite en pruebas y modo demo | Las 81 pruebas corren el API completo contra un Postgres real sin red ni instalación. |

## 8. Límites actuales (honestos)

- **Un solo proceso**: los límites de intentos y cachés son en memoria. Perfecto para este tamaño; si
  algún día se escalan a varias réplicas habría que moverlos a la base o a Redis.
- **Sin modo offline para ventas**: el catálogo se guarda en el dispositivo y la caja avisa sin
  conexión, pero **no encola ventas**. Está en el ROADMAP (es la mejora de confiabilidad #1 del POS).
- **Imágenes de productos / comprobantes**: previstos en Supabase Storage; aún no conectados.
- **Dependencias con avisos de `npm audit`** (esbuild/vite en desarrollo, react-router): no afectan
  producción tal como está (no hay SSR ni redirecciones con entrada del usuario); se actualizarán con
  la siguiente tanda.

## 9. Perfiles y gerente digital

**Perfiles.** Cada empresa trabaja con tres perfiles principales: **Ventas** (cobra y consulta), **Manager** (opera la empresa,
anula, ve reportes y el gerente digital) y **Administrador** (usuarios, catálogo, fiscal e inventario de SU empresa). Encima de
todos está el **Administrador general** (`es_dueno_grupo`): ve y controla las cuatro empresas, asigna perfiles en cualquiera
y puede nombrar a otros administradores generales. El Administrador de una empresa no ve el consolidado del grupo ni otras empresas.
Cada empresa lleva su propio inventario, caja y facturación; Dirección ve y controla las finanzas de todas.

**Gerente digital** (`apps/api/src/modulos/gerente`). Es un motor de reglas explícitas, no una caja negra: toma los números de la
empresa (ventas, costo de receta, gastos, inventario, caja, fiscal, antifraude), compara los últimos N días con los N anteriores y
produce un resumen en lenguaje natural, un puntaje de salud 0–100, tres prioridades y una lista de hallazgos con "qué hacer".
Detecta, entre otras cosas: caída o alza de ventas, días anómalos para su día de la semana, productos que venden pero tienen
margen bajo (y el precio que llevaría al margen objetivo), productos en caída, concentración en un solo producto, ventas sin
receta, carga fija excesiva, gastos que crecen más que las ventas, pérdida operativa, merma alta, insumos a punto de agotarse,
stock negativo o dormido, producto por vencer, faltantes de caja, alertas de control y CAI por vencer. El de Dirección analiza
cada empresa y las compara (ranking, brecha de margen, dependencia de una sola empresa, operaciones sin conciliar).
Las reglas y umbrales están en `analisis.js` y se prueban con datos sintéticos. Una capa de redacción con IA (Claude) puede
sumarse después para explicar los hallazgos en conversación; hoy no depende de ningún servicio externo.

## 10. Finanzas del grupo y Compras (mejoras 16 y 17)

**Compras** (`apps/api/src/modulos/compras`, esquema `cmp`, migración 0060). Orden de compra por empresa: borrador → enviada → recibida
parcial/total → cerrada (o anulada). Proveedores = fichas comunes `core.terceros` (`es_proveedor`). Compra en lempiras o dólares con tipo de cambio
editable en la orden y, aparte, el del día de la factura al recibir. Cada recepción deja una fila inalterable en `cmp.precios` (historial por
proveedor; el comparativo muestra la variación y, en dólares, cuánto se debe al precio y cuánto al tipo de cambio). Documento imprimible y correo
(usa `lib/correo.js`; sin Gmail configurado queda «pendiente»).

*Punto de integración con los inventarios* (`compras/recepcion.js`, sin duplicar su lógica): `inv` → `inv.compras` + `inv.ingresar()`;
`fab` (EcoStone) → `fab.mover_insumo(…'compra'…)` (costo promedio ponderado); `rinv_fab` (Italo/Mec3) → stock + kardex + lote + `rinv.precios_fab`
y `prod.costeo_precios` por nombre (alimenta el costeo del gelato); `rep_suc` → `rinv.stock_suc`; `dis` (DISERCO) → `dis.mover(…'compra'…)`.
Costos siempre sin ISV. Lo que entra por una orden queda marcado con `recepcion_id` para no contarlo dos veces en el flujo de caja.

**Finanzas** (`apps/api/src/modulos/fin`): `estados.js` (estado de resultados por sucursal, flujo de caja, por cobrar, por pagar, presupuesto,
saldos entre empresas), `extra.js` (rutas de la empresa activa), `consolidado.js` (Dirección, con eliminación de operaciones internas) y
`excel.js` (libros .xlsx). Por cobrar = facturas a crédito (`fin.abonos_credito`) + cotizaciones aprobadas leídas de `crm.cxc` (fuente única de
Cobranza). Por pagar = recepciones de órdenes a crédito + gastos con `pagado = false`. El flujo cuenta el dinero cuando se mueve.
