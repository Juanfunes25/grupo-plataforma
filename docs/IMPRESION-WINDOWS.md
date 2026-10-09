# Impresión en las tiendas (Windows + impresora térmica USB)

Las tiendas imprimen desde Chrome en una computadora con Windows y una impresora térmica de 80 mm (o 58 mm) por USB. Nada de apps nativas: la plataforma imprime una página HTML del tamaño exacto del rollo.

## Una sola vez por computadora

1. **Driver.** Con la impresora conectada, instala el driver del fabricante (Epson, Xprinter, 3nStar, Bixolon…). En *Configuración → Bluetooth y dispositivos → Impresoras* márcala como **predeterminada**.
2. **Papel.** En *Preferencias de impresión*: papel **80 mm** (o 58 mm), largo continuo (rollo), márgenes **0**, escala 100 %. Si tiene cortador, activa «cortar al final del documento».
3. **Acceso directo.** Entra a la plataforma → *Impresora* → **Descargar «Caja-…bat»** y déjalo en el escritorio. Es lo mismo que crear un acceso directo con este destino (cambia `TU-DOMINIO` por el dominio de la plataforma y `italo` por la empresa):

   ```
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk-printing --user-data-dir="%LOCALAPPDATA%\GrupoCaja" --app=https://TU-DOMINIO/italo/pos
   ```

   - `--kiosk-printing`: imprime en la predeterminada **sin ventana de confirmación**.
   - `--user-data-dir`: perfil de Chrome propio para la caja. Sin esto, si ya hay una ventana de Chrome abierta, Chrome **ignora** `--kiosk-printing`.
   - `--app`: abre como aplicación, sin barra de direcciones ni pestañas.
   - Si Chrome está en `Program Files (x86)`, cambia esa parte de la ruta (el `.bat` descargado ya prueba las dos).
4. **Arranque automático (opcional).** Copia el acceso directo a la carpeta `shell:startup` (Win+R → `shell:startup`).
5. **Prueba.** Entra por el acceso directo → *Impresora* → **Imprimir ticket de prueba**. Debe salir directo. Si la línea de números sale cortada, cambia el ancho del papel en la misma pantalla (el ancho es **por caja**: se guarda en esa computadora).

## Qué sale impreso

- **Ticket de factura** (80 mm = 48 o 42 columnas; 58 mm = 32): logo, razón social, RTN, dirección, teléfono, factura, CAI y rango (cuando haya CAI real), líneas, ISV, pagos, efectivo recibido y cambio.
- **«BORRADOR - SIN VALOR FISCAL»** arriba y abajo, mientras el punto de emisión esté en borrador. Al activar el CAI real desaparece solo.
- **Reimpresión**: la primera impresión es original; las demás salen «COPIA #n» y piden motivo (queda en la bitácora; la 2.ª copia levanta alerta).
- **Comprobante provisional** (venta sin conexión): ver `POS-SIN-CONEXION.md`.
- **Cierre de caja**: al cerrar el turno, botón **Imprimir cierre de caja** (ventas por forma de pago, fondo, efectivo contado, diferencia y firma).
- **PDF carta** de la factura: *Ver PDF carta* en el recibo y en Facturas; lleva el logo (si existe) y una marca de agua «BORRADOR» en cada página mientras no haya CAI real.

## Logo

Guarda el logo como `apps/web/public/logos/<codigo-de-empresa>.png` (`italo`, `origen`, `ecostone`, `diserco`). Debe ser PNG de 8 bits, fondo blanco o transparente y de preferencia en blanco y negro (la térmica no imprime grises; el sistema aplica contraste). Hoy solo existe el de DISERCO; las demás empresas imprimen sin logo hasta que se agregue su archivo. Se puede apagar por caja en la pantalla *Impresora*.

## Problemas comunes

| Síntoma | Causa y solución |
|---|---|
| Sale la ventana de impresión | La caja no se abrió con el acceso directo. Ciérrala y ábrela desde él. |
| Imprime en otra impresora | No es la predeterminada de Windows. |
| Texto cortado a la derecha | Ancho de papel incorrecto en la pantalla *Impresora*, o márgenes distintos de 0 en el driver. |
| Letra diminuta | Escala distinta de 100 % en el driver. |
| No corta | Activa el cortador en las preferencias del driver. |
| Tablet Android | Usa el servicio de impresión del sistema; no existe impresión silenciosa. |
