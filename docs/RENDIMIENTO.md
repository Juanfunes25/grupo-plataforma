# Rendimiento: medición y mejoras

Informe de antes y después. Todas las cifras son medidas reales en esta máquina; las del celular son **simuladas** (CPU 4× más lenta, red 4G lenta de 1,6 Mbps y 150 ms de latencia, caché vacía) y las del servidor corren sobre PGlite (Postgres compilado a WASM, de 5 a 10 veces más lento que el Postgres real de Supabase). Importan las **proporciones**, no los milisegundos absolutos.

## 1. Cómo se mide (para repetirlo)

| Qué | Cómo |
|---|---|
| Pantalla de acceso (la primera que ve cualquiera) | **Lighthouse 12** móvil (`lighthouse URL --form-factor=mobile --only-categories=performance`) contra el servicio compilado. |
| Pantallas con sesión (POS, Hub, Dashboard, Facturas, CAI) | Lighthouse no inicia sesión; se usa Playwright + Chromium con las mismas condiciones simuladas (CDP: `Network.emulateNetworkConditions` y `Emulation.setCPUThrottlingRate`), sesión ya guardada en el navegador, caché vacía, 3 vueltas y mediana. Mide FCP, LCP, tiempo bloqueado (TBT, tareas largas tras el primer dibujo), bytes y peticiones. |
| API con miles de ventas | Base con **120 000 ventas, 240 000 líneas y 120 000 pagos** de Italo en 4 sucursales a lo largo de un año; `GET` autenticado, mediana de 3 llamadas. |
| Bundle | Salida de `vite build` y análisis por módulo de cada paquete. |

Los scripts de medición no forman parte del producto; el procedimiento está arriba y se rehace en minutos.

## 2. Resultados en el celular

### Pantalla de acceso (Lighthouse, móvil)

| | Antes | Después |
|---|---|---|
| Puntaje de rendimiento | 90 | **99** |
| Primer dibujo (FCP) | 2,6 s | **1,7 s** |
| Contenido principal (LCP) | 2,7 s | **1,9 s** |
| Índice de velocidad | 4,3 s | **1,7 s** |
| Desplazamientos de diseño (CLS) | 0 | 0 |
| Peso transferido | 179 KiB | **122 KiB** |

### Pantallas con sesión (Playwright, mediana de 3)

| Pantalla | FCP antes → después | LCP antes → después | Tiempo bloqueado | Bytes |
|---|---|---|---|---|
| Hub | 1 152 → 1 024 ms | 2 636 → 2 352 ms | 192 → 138 ms | 232 → 210 kB |
| POS | 1 184 → 1 028 ms | 2 608 → 2 400 ms | 154 → 161 ms | 232 → 210 kB |
| Dashboard | 1 116 → 1 016 ms | 2 592 → 2 360 ms | 189 → 115 ms | 205 → 186 kB |
| Facturas | 1 144 → 1 072 ms | 2 640 → 2 392 ms | 151 → 169 ms | 207 → 188 kB |
| CAI / asistente fiscal | 1 148 → 1 040 ms | 2 580 → 2 336 ms | 120 → 111 ms | 188 → 170 kB |

Lectura honesta: en las pantallas con sesión la mejora es de ~10 % (≈250 ms de LCP); lo que sigue pesando es la **cadena** documento → JavaScript → `/auth/yo` → pantalla → datos, cuatro viajes de red seguidos que no se acortan con bytes. La mejora grande está en la pantalla de acceso, donde antes se esperaba a Google Fonts.

## 3. Qué se cambió y por qué

1. **Fuentes propias** (antes: hoja de estilos de Google Fonts que bloqueaba el primer dibujo y 3 conexiones a terceros, y no existían sin internet). Ahora: `public/fuentes/*.woff2` (Inter variable + Barlow Condensed 500/600/700, solo subconjunto latino, licencia OFL incluida), `font-display: swap` y una **letra de reserva con las mismas medidas** (`size-adjust`) para que la pantalla no salte al cambiar de letra. Una prueba con las fuentes pre-cargadas dio *peor* resultado (compiten por ancho de banda con el JavaScript) y se descartó. El service worker las guarda: también salen sin conexión.
2. **Brotli precomprimido** al compilar (`apps/web/scripts/precomprimir.mjs`, nivel 11) y servido por el API: el JavaScript de entrada baja de 41 kB (gzip) a **35 kB**, el total de la compilación de 1 676 kB a 468 kB sin gastar CPU por petición. (La compresión «al vuelo» de Express usa Brotli nivel 4, que no ganaba nada sobre gzip: 94,7 kB contra 94,3 kB.)
3. **Caché HTTP correcta**: lo que lleva hash en el nombre (`/assets/…`) no vence nunca; fuentes, iconos y manifiestos un día (antes los iconos sin hash también eran «inmutables» por un año y no se habrían actualizado); `index.html` y el service worker se revisan siempre.
4. **React y el enrutador en un archivo aparte** (`vendor-react`, 165 kB / 47 kB brotli): casi no cambia, así que se queda en la caché del teléfono aunque la app se actualice a diario.
5. **Arranque en una sola llamada**: con la empresa ya conocida, `/auth/yo` se pide una vez (antes dos seguidas). Con red lenta ahorra un viaje completo.
6. **Pantalla de acceso sin salto**: el esqueleto de carga tiene la altura de la tarjeta real; sin eso el CLS subía a 0,19 en cuanto llegaban los datos.

## 4. Servidor con muchas ventas

Base de prueba: 120 000 ventas (Italo, 12 meses). Mediana de 3 llamadas.

| Endpoint | Antes | Con índice | Con índice + caché (repetida) |
|---|---|---|---|
| Dashboard (mes en curso) | 1 735 ms | **196 ms** | 6 ms |
| Reportes de ventas (7 días) | 1 197 ms | **147 ms** | 6 ms |
| Dirección: resumen del grupo | 864 ms | **99 ms** | 3 ms |
| Tablero de la empresa | 738 ms | **95 ms** | 3 ms |
| Tablero del grupo | 941 ms | **190 ms** | 4 ms |
| Gerente digital | 1 825 ms | **1 138 ms** | 3 ms |
| Catálogo del POS | 178 ms | 171 ms | 14 ms |
| Dashboard (año completo) | 5 155 ms | 4 285 ms | 8 ms |
| Reportes (año completo) | 4 266 ms | 3 921 ms | 4 ms |

**Causa raíz.** Casi todos los reportes filtran por `(fecha_emision at time zone 'America/Tegucigalpa')::date`. La conversión sobre la columna impedía usar el índice que existía: la base leía las 120 000 ventas del estado «pagada» y descartaba 117 000 para quedarse con 2 600 del mes. **Migración 0041**: índice sobre esa misma expresión `(empresa_id, fecha_en_Honduras, sucursal_id)`, otro parcial para anulaciones y uno por fecha para Dirección. Es la mejora que más pesa (≈ 9× en los reportes del periodo).

**Caché de lecturas** (`apps/api/src/lib/cache.js`): catálogo, versión del catálogo (la caja la consulta cada pocos segundos y recalcula hashes de todos los productos), dashboard, reportes, tableros y gerente digital. Seguridad: solo esas rutas; antes de servir una respuesta guardada se exige el mismo permiso que pide la ruta; la clave incluye la empresa y la persona (el catálogo, que es de la empresa, se comparte entre quienes ven las mismas sucursales); **cualquier cambio exitoso en la empresa borra todo lo suyo** (los tableros de Dirección se borran con un cambio en cualquier empresa), de modo que una venta recién cobrada aparece en el siguiente refresco; y vence solo (10–60 s). Probado en `cache-api.test.js` (aciertos, renovación al cambiar un precio o cobrar, 403 aunque esté guardada, sin mezclar personas ni empresas). Se apaga con `CACHE_API=0`.

**Permisos**: la lista de permisos y de módulos visibles de cada persona/empresa se calcula una vez y se reutiliza mientras no cambien su acceso ni la empresa (antes se recalculaba, con ordenamiento, en cada petición). Los usuarios, accesos y empresas ya tenían caché de 15 s.

**Lo que no se arregla con índices:** agregar un año entero de 120 000 ventas (4 s en PGlite; en Postgres real es del orden de 0,5 s). Si algún día pesa, el camino es una tabla resumen diaria por empresa y sucursal; con el volumen actual no hace falta.

## 5. Peso de la aplicación

| | Al empezar | Ahora |
|---|---|---|
| JavaScript de entrada | 234 kB (77 kB gzip) | 122 kB (41 kB gzip, **35 kB brotli**) + `vendor-react` 165 kB (54 kB gzip, 47 kB brotli, en caché) |
| Pantallas cargadas por partes | 83 archivos | 113 archivos |
| Service worker: precarga | 83 entradas, 1 300 KiB | 113 entradas, 1 752 KiB (≈ 470 kB por la red con Brotli) |

El total creció porque **otros módulos nuevos** (ayuda, cobranza, planilla, compras, tablero, mensajería, sin conexión) y los míos (seguridad, asistente fiscal, estado del sistema) se sumaron. Todo lo mío va en partes que solo se descargan al abrir esa pantalla. Dependencias pesadas revisadas: la mayor es `react-dom` (130 kB, inevitable); el generador de QR (`qrcode`) solo se descarga al activar los dos pasos o imprimir etiquetas; no hay librerías de gráficas ni de fechas (se dibuja a mano). Imágenes: un solo logo PNG de 8 kB; los iconos de la app son los de instalación.

**Recomendaciones pendientes**:
* ~~`ayuda/contenido.js` en el JavaScript de entrada~~ — hecho en la segunda ronda (sección 6).
* El service worker precarga **todas** las pantallas. Para los celulares de gerentes conviene precargar solo el núcleo (entrada, vendor, caja, facturas, cierres) y guardar las demás al visitarlas (`runtimeCaching`). Requiere confirmar con la mejora de «ventas sin conexión» qué pantallas deben funcionar sin red.
* En producción, habilitar **HTTP/2** en el servicio (Render/Railway ya lo hacen) para que los 25–30 archivos de arranque no esperen turno.


## 6. Segunda ronda (octubre 2026)

Misma máquina y método. Teléfono simulado = Pixel 7, CPU 4× más lenta, 1,6 Mbps y 150 ms; caché vacía; mediana de 3.
Servidor con PGlite y la base de demostración (catálogo real de Italo y EcoStone).

### Peso

| | Antes | Después |
|---|---|---|
| JavaScript de entrada (`index-*.js`) | 121,7 kB · **41,2 kB gzip** | 98,1 kB · **33,4 kB gzip** (−19 %) |
| CSS de entrada | 14,0 kB gzip | 13,4 kB gzip |
| `vendor-react` (en caché aparte) | 53,8 kB gzip | igual |

Salieron de la entrada y se descargan al usarse: pantalla de acceso (solo la ve quien no tiene sesión), verificación en dos
pasos (opcional y apagada), búsqueda Ctrl+K y el texto de la ayuda (se pide después del primer dibujo; `ayuda/rol.js` queda
en la entrada porque el menú lo necesita).

### Carga de pantallas

| Pantalla | Teléfono FCP / LCP antes | Después | Escritorio LCP antes → después |
|---|---|---|---|
| Acceso (PIN) | 1 256 / 1 256 ms | **980 / 1 304 ms** | 148 → 92 ms |
| POS (cajero) | 980 / 2 080 ms | 980 / **1 900 ms** | 300 → 164 ms |
| Cierre de caja | 1 008 / 2 200 ms | 980 / **2 076 ms** | 488 → 448 ms |
| Dirección del grupo | 1 012 / 2 160 ms | 984 / **2 028 ms** | 216 → 396 ms (ruido: varía ±200 ms entre vueltas) |

Qué cambió:
1. **El código de la pantalla se pide en paralelo con la sesión.** Al abrir o recargar `/italo/pos`, `App.jsx` adelanta la
   descarga de la pantalla mientras `/auth/yo` responde (antes esperaba la sesión para empezar). Un viaje de red menos.
2. **POS**: la cuadrícula de productos es un componente memorizado (agregar a la orden, el aviso «+ producto» y el
   autoguardado ya no vuelven a dibujar los ~160 botones del catálogo). El catálogo guardado en el equipo se muestra al
   instante y se actualiza cuando contesta el servidor (que de todos modos recalcula precios al guardar y cobrar).
   Medido en Playwright: dos toques seguidos 130–200 ms en teléfono simulado.

### Servidor

| Qué | Antes | Después |
|---|---|---|
| Arranque normal (ya migrado y sembrado), mediana de 5 | **1 235 ms** | **871 ms** (−30 %) |
| Importar el código del API (`app.js`) | 565 ms | ~350 ms |
| Consultas a la base en el arranque normal | 12 seguidas | **2** |
| `GET /pos/ventas/cambios` (la caja lo pregunta cada 8 s) con 120 000 ventas | 22,6 ms | **2,1 ms** |
| `POST /pos/ventas` (orden abierta) | 31,1 ms | 27,0 ms |
| `PUT /pos/ventas/:id` (autoguardado) | 31,6 ms | 28,4 ms |
| Venta + cobro en borrador | 70,2 ms | 52,9 ms |

1. **Arranque**: exceljs (~250 ms), nodemailer y el módulo de Planilla se cargan la primera vez que se usan, no al arrancar.
   Las migraciones leen la tabla de control con una consulta (la preparación con candado y RLS solo corre en una base nueva)
   y las tres cargas iniciales (reposición, catálogo de Italo, datos de EcoStone) se revisan juntas en una sola consulta
   (`db/arranque.js`). En Render con Supabase cada consulta es un viaje de red: 10 viajes menos en cada arranque, y en el
   plan gratuito el servidor arranca cada vez que despierta.
2. **Líneas de la venta en una sola sentencia** (`jsonb_to_recordset`) en vez de un insert por línea; el cobro reutiliza la
   configuración ya leída.
3. **Migración 0095**: índice `(sucursal_id, updated_at)` en `pos.ventas`. El sondeo de la caja recorría todo el historial
   de la sucursal y crecía cada día; ahora lee solo lo abierto o tocado en 3 días.

Las lecturas pesadas (tablero, dashboard, reportes, catálogo) ya tenían caché e índices de la primera ronda: con la base de
demostración responden en 2–10 ms y no cambiaron.

### Recomendaciones (dependen de Render, no se tocaron)

* **El plan gratuito se duerme tras 15 minutos sin visitas** y la primera persona que entra espera el arranque completo
  (decenas de segundos en el plan gratis). Lo que más ayuda: un plan sin suspensión (Starter). Un «despertador» externo cada
  10 minutos lo evita pero va contra el uso previsto del plan gratuito.
* Cada despertar cuenta como «caída» en Estado del sistema (no hubo latido) y, tras 3 en un día, se manda correo al dueño.
  En el plan gratuito eso es ruido normal; con un plan sin suspensión desaparece.
* Poner la base de Supabase y el servicio de Render en la **misma región** (cada consulta es un viaje de red).
