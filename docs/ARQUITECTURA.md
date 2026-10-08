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
| PGlite en pruebas y modo demo | Las 65 pruebas corren el API completo contra un Postgres real sin red ni instalación. |

## 8. Límites actuales (honestos)

- **Un solo proceso**: los límites de intentos y cachés son en memoria. Perfecto para este tamaño; si
  algún día se escalan a varias réplicas habría que moverlos a la base o a Redis.
- **Sin modo offline para ventas**: el catálogo se guarda en el dispositivo y la caja avisa sin
  conexión, pero **no encola ventas**. Está en el ROADMAP (es la mejora de confiabilidad #1 del POS).
- **Imágenes de productos / comprobantes**: previstos en Supabase Storage; aún no conectados.
- **Dependencias con avisos de `npm audit`** (esbuild/vite en desarrollo, react-router): no afectan
  producción tal como está (no hay SSR ni redirecciones con entrada del usuario); se actualizarán con
  la siguiente tanda.
